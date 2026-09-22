import type { UpdateState } from "../../shared/contracts";
import { parseReleaseFeed } from "./release-feed";
import { compareSemver, formatSemver, parseSemver, type SemVer } from "./semver";

// In-app updates over GitHub Releases. Two paths share one state machine:
//   manual  — always: the releases feed (no rate limit; the API only when the feed cannot be read) names
//             the newest version; the user downloads it from the release page.
//   install — a signed, packaged build (electron-updater behind `installer`): download, then restart into it.
// State moves idle → checking → up-to-date | available | error, and from available → downloading → ready
// on install. Every change goes out through `onState`; `check()` never throws, the state carries the failure.

export const UPDATE_INSTALL_UNAVAILABLE = "UPDATE_INSTALL_UNAVAILABLE";
export const UPDATE_NOT_AVAILABLE = "UPDATE_NOT_AVAILABLE";
export const FIRST_CHECK_DELAY_MS = 15_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
export const MAX_NOTES_LENGTH = 4000;
const RELEASES_PER_PAGE = 10;
const CODE_SIGNATURE = /code signature/i;

export interface UpdateFeed { owner: string; repo: string }

export interface GithubRelease {
  tag_name: string;
  html_url: string;
  /** Release notes: Markdown from the API, plain text from the feed. */
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
}

export interface UpdateFetchResponse {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}
export type UpdateFetch = (url: string, init: { headers: Record<string, string> }) => Promise<UpdateFetchResponse>;
type ReleasesOutcome = { ok: true; releases: unknown } | { ok: false; message: string };

export interface InstallerEvents {
  onProgress: (percent: number) => void;
  onDownloaded: () => void;
  onError: (error: Error) => void;
}

/** The self-replacing path (electron-updater in production); absent in development or when the module is missing. */
export interface UpdateInstaller {
  /** Whether this build can replace itself: packaged, and on macOS signed. Read at every check. */
  isSupported: () => boolean;
  /** The updater's own check, which resolves the file its `download` fetches. */
  check: () => Promise<void>;
  download: () => Promise<void>;
  /** Quits and installs the downloaded update. */
  install: () => void;
  subscribe: (events: InstallerEvents) => () => void;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  feed: UpdateFeed;
  fetch: UpdateFetch;
  platform: string;
  arch: string;
  installer?: UpdateInstaller | undefined;
  onState: (state: UpdateState) => void;
  /** `settings.checkUpdatesAutomatically`, read at every scheduled tick. */
  autoCheck: () => boolean;
  openExternal: (url: string) => Promise<void>;
  now?: (() => Date) | undefined;
  /** The feed could not be used and the API was asked instead: said here, never silently. */
  warn?: ((message: string) => void) | undefined;
}

interface PickedRelease { version: SemVer; release: GithubRelease }

function isRelease(value: unknown): value is GithubRelease {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.tag_name === "string" && typeof candidate.html_url === "string";
}

/** The newest release by version among those whose tag parses as semver, prereleases included; drafts are skipped. */
export function pickLatestRelease(body: unknown): PickedRelease | undefined {
  if (!Array.isArray(body)) return undefined;
  return body.reduce<PickedRelease | undefined>((best, item) => {
    if (!isRelease(item) || item.draft === true) return best;
    const version = parseSemver(item.tag_name);
    if (!version) return best;
    return best && compareSemver(best.version, version) >= 0 ? best : { version, release: item };
  }, undefined);
}

function notesOf(release: GithubRelease): string | undefined {
  const text = (release.body ?? "").trim();
  return text.length === 0 ? undefined : text.slice(0, MAX_NOTES_LENGTH);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** "HH:MM" in the machine's zone from GitHub's x-ratelimit-reset (epoch seconds); undefined when the header is missing or not a time. */
export function rateLimitResetLabel(reset: string | null): string | undefined {
  const seconds = reset === null ? Number.NaN : Number(reset);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** What a 403 with no requests left means to the reader: not the bare status, but when to try again. */
export function rateLimitMessage(reset: string | null): string {
  const label = rateLimitResetLabel(reset);
  return `GitHub's rate limit is exhausted; try again after ${label ?? "a few minutes"}.`;
}

export class UpdateService {
  private state: UpdateState;
  private inFlight: Promise<UpdateState> | undefined;
  /** Set for the session once the platform refused the downloaded bundle (an unsigned build). */
  private installBlocked = false;
  private firstTimer: ReturnType<typeof setTimeout> | undefined;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: UpdateServiceOptions) {
    this.state = { phase: "idle", current: options.currentVersion };
  }

  getState(): UpdateState {
    return this.state;
  }

  get releasesUrl(): string {
    return `https://github.com/${this.options.feed.owner}/${this.options.feed.repo}/releases`;
  }

  private get apiUrl(): string {
    return `https://api.github.com/repos/${this.options.feed.owner}/${this.options.feed.repo}/releases?per_page=${RELEASES_PER_PAGE}`;
  }

  private get feedUrl(): string {
    return `${this.releasesUrl}.atom`;
  }

  private get userAgent(): string {
    const { currentVersion, platform, arch } = this.options;
    return `Quire/${currentVersion} (${platform}; ${arch})`;
  }

  private set(next: UpdateState) {
    this.state = next;
    this.options.onState(next);
  }

  private stamp(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  private failure(message: string): UpdateState {
    return { phase: "error", current: this.options.currentVersion, message, checkedAt: this.stamp() };
  }

  private canInstall(): boolean {
    return !this.installBlocked && (this.options.installer?.isSupported() ?? false);
  }

  /** One check at a time; a download in progress (or finished) is never interrupted by a check. */
  check(): Promise<UpdateState> {
    if (this.inFlight) return this.inFlight;
    if (this.state.phase === "downloading" || this.state.phase === "ready") return Promise.resolve(this.state);
    this.inFlight = this.runCheck().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async runCheck(): Promise<UpdateState> {
    this.set({ phase: "checking", current: this.options.currentVersion });
    const outcome = await this.fetchLatest();
    this.set(outcome);
    return outcome;
  }

  private async fetchLatest(): Promise<UpdateState> {
    const { currentVersion } = this.options;
    const current = parseSemver(currentVersion);
    if (!current) return this.failure(`The running version "${currentVersion}" is not a version number, so releases cannot be compared with it.`);
    const releases = await this.fetchReleases();
    if (!releases.ok) return this.failure(releases.message);
    const latest = pickLatestRelease(releases.releases);
    if (!latest) return this.failure(`No releases yet at ${this.releasesUrl}.`);
    const checkedAt = this.stamp();
    if (compareSemver(latest.version, current) <= 0) return { phase: "up-to-date", current: currentVersion, checkedAt };
    const notes = notesOf(latest.release);
    return { phase: "available", current: currentVersion, latest: formatSemver(latest.version), ...(notes ? { notes } : {}), url: latest.release.html_url, canInstall: this.canInstall(), checkedAt };
  }

  /** The feed first, because it has no rate limit; the API only when the feed is unreachable or unparsable, which is reported. */
  private async fetchReleases(): Promise<ReleasesOutcome> {
    const fromFeed = await this.fetchFeed();
    if (fromFeed.ok) return fromFeed;
    this.options.warn?.(`[updates] The releases feed could not be used (${fromFeed.message}); asking the GitHub API instead.`);
    return this.fetchApi();
  }

  private async fetchFeed(): Promise<ReleasesOutcome> {
    let response: UpdateFetchResponse;
    try { response = await this.options.fetch(this.feedUrl, { headers: { accept: "application/atom+xml", "user-agent": this.userAgent } }); }
    catch (cause: unknown) { return { ok: false, message: `Could not reach GitHub: ${messageOf(cause)}` }; }
    if (!response.ok) return { ok: false, message: `GitHub answered HTTP ${response.status} for ${this.feedUrl}.` };
    let xml: string;
    try { xml = await response.text(); }
    catch (cause: unknown) { return { ok: false, message: `The releases feed could not be read: ${messageOf(cause)}` }; }
    try { return { ok: true, releases: parseReleaseFeed(xml) }; }
    catch (cause: unknown) { return { ok: false, message: messageOf(cause) }; }
  }

  private async fetchApi(): Promise<ReleasesOutcome> {
    let response: UpdateFetchResponse;
    try { response = await this.options.fetch(this.apiUrl, { headers: { accept: "application/vnd.github+json", "user-agent": this.userAgent } }); }
    catch (cause: unknown) { return { ok: false, message: `Could not reach GitHub: ${messageOf(cause)}` }; }
    if (response.status === 404) return { ok: false, message: `No releases yet at ${this.releasesUrl}.` };
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") return { ok: false, message: rateLimitMessage(response.headers.get("x-ratelimit-reset")) };
    if (!response.ok) return { ok: false, message: `GitHub answered HTTP ${response.status} for ${this.apiUrl}.` };
    try { return { ok: true, releases: await response.json() }; }
    catch (cause: unknown) { return { ok: false, message: `GitHub's answer was not JSON: ${messageOf(cause)}` }; }
  }

  /**
   * Downloads the available release and restarts into it; from `ready`, restarts at once.
   * Rejects with UPDATE_INSTALL_UNAVAILABLE when this build cannot replace itself, and with the
   * installer's failure (also written to the state) when the download or the platform refuses.
   */
  async install(): Promise<void> {
    const { installer } = this.options;
    const state = this.state;
    if (state.phase === "downloading") return;
    if (state.phase === "ready") {
      if (!installer) throw new Error(UPDATE_INSTALL_UNAVAILABLE);
      installer.install();
      return;
    }
    if (state.phase !== "available") throw new Error(UPDATE_NOT_AVAILABLE);
    if (!installer || !this.canInstall()) throw new Error(UPDATE_INSTALL_UNAVAILABLE);
    const { current, latest } = state;
    this.set({ phase: "downloading", current, latest, percent: 0 });
    const unsubscribe = installer.subscribe({
      onProgress: (percent) => { if (this.state.phase === "downloading") this.set({ phase: "downloading", current, latest, percent }); },
      onDownloaded: () => { if (this.state.phase === "downloading") this.set({ phase: "ready", current, latest }); },
      onError: (error) => this.failInstall(error),
    });
    try {
      await installer.check();
      await installer.download();
    } catch (cause: unknown) {
      this.failInstall(cause);
      throw cause instanceof Error ? cause : new Error(messageOf(cause));
    } finally {
      unsubscribe();
    }
    if (this.state.phase === "downloading") this.set({ phase: "ready", current, latest });
    if (this.state.phase === "ready") installer.install();
  }

  private failInstall(cause: unknown) {
    const message = messageOf(cause);
    if (CODE_SIGNATURE.test(message)) this.installBlocked = true;
    if (this.state.phase === "error") return;
    this.set(this.failure(message));
  }

  /** The release page of the available version, else the repository's releases. */
  openReleasePage(): Promise<void> {
    return this.options.openExternal(this.state.phase === "available" ? this.state.url : this.releasesUrl);
  }

  /** A check 15 s after launch and every 24 h, each one skipped while the setting is off. Idempotent. */
  start(): void {
    if (this.firstTimer || this.intervalTimer) return;
    this.firstTimer = setTimeout(() => { this.firstTimer = undefined; void this.tick(); }, FIRST_CHECK_DELAY_MS);
    this.intervalTimer = setInterval(() => { void this.tick(); }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.firstTimer = undefined;
    this.intervalTimer = undefined;
  }

  private async tick(): Promise<void> {
    if (!this.options.autoCheck()) return;
    await this.check();
  }
}
