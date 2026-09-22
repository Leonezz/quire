import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../../shared/contracts";
import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, UPDATE_INSTALL_UNAVAILABLE, UPDATE_NOT_AVAILABLE, UpdateService, pickLatestRelease, rateLimitMessage, rateLimitResetLabel, type GithubRelease, type InstallerEvents, type UpdateFetch, type UpdateFetchResponse, type UpdateInstaller, type UpdateServiceOptions } from "./updates";

const RELEASES_URL = "https://github.com/Leonezz/quire/releases";
const FEED_URL = "https://github.com/Leonezz/quire/releases.atom";
const API_URL = "https://api.github.com/repos/Leonezz/quire/releases?per_page=10";
const USER_AGENT = "Quire/0.1.0-alpha.1 (darwin; arm64)";

function release(tag: string, extra: Partial<GithubRelease> = {}): GithubRelease {
  return { tag_name: tag, html_url: `${RELEASES_URL}/tag/${tag}`, body: `Notes for ${tag}`, ...extra };
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): UpdateFetchResponse {
  const lowered = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (name) => lowered.get(name.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The releases as GitHub's feed lists them: drafts absent, notes as escaped HTML. */
function atomOf(releases: readonly GithubRelease[]): string {
  const entries = releases.filter((item) => item.draft !== true).map((item) =>
    `<entry><id>tag:github.com,2008:Repository/1/${item.tag_name}</id><updated>2026-09-20T09:00:00Z</updated><link rel="alternate" type="text/html" href="${item.html_url}"/><title>${escapeXml(item.tag_name)}</title><content type="html">${escapeXml(item.body ? `<p>${escapeXml(item.body)}</p>` : "")}</content></entry>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><id>tag:github.com,2008:${RELEASES_URL}</id><title>Release notes from quire</title>${entries.join("")}</feed>`;
}

/** A GitHub where the feed lists the same releases the API would answer with; when the API would fail, the feed is down (503) and the API answers as given. */
function jsonFetch(status: number, body: unknown, headers: Record<string, string> = {}): UpdateFetch {
  return vi.fn(async (url: string) => {
    if (url === FEED_URL) return status === 200 && Array.isArray(body) ? response(200, atomOf(body as GithubRelease[])) : response(503, "");
    return response(status, body, headers);
  });
}

/** The feed answers `feed`, the API `api`. */
function routedFetch(feed: UpdateFetchResponse | Error, api: UpdateFetchResponse | Error): UpdateFetch {
  return vi.fn(async (url: string) => {
    const answer = url === FEED_URL ? feed : api;
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

function fakeInstaller(overrides: Partial<UpdateInstaller> = {}) {
  const listeners = new Set<InstallerEvents>();
  const installer: UpdateInstaller = {
    isSupported: () => true,
    check: vi.fn(async () => undefined),
    download: vi.fn(async () => undefined),
    install: vi.fn(),
    subscribe: (events) => { listeners.add(events); return () => { listeners.delete(events); }; },
    ...overrides,
  };
  const emit = <K extends keyof InstallerEvents>(event: K, ...args: Parameters<InstallerEvents[K]>) => {
    for (const listener of listeners) (listener[event] as (...a: Parameters<InstallerEvents[K]>) => void)(...args);
  };
  return { installer, emit, listeners };
}

function service(overrides: Partial<UpdateServiceOptions> = {}) {
  const states: UpdateState[] = [];
  const warnings: string[] = [];
  const options: UpdateServiceOptions = {
    currentVersion: "0.1.0-alpha.1", feed: { owner: "Leonezz", repo: "quire" },
    fetch: jsonFetch(200, [release("v0.1.0-alpha.1")]), platform: "darwin", arch: "arm64",
    onState: (state) => { states.push(state); }, autoCheck: () => true, openExternal: vi.fn(async () => undefined),
    now: () => new Date("2026-09-20T10:00:00.000Z"), warn: (message) => { warnings.push(message); },
    ...overrides,
  };
  return { updates: new UpdateService(options), states, warnings, options };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("pickLatestRelease", () => {
  it("picks the newest semver tag, prereleases included, skipping drafts and tags that are not versions", () => {
    const picked = pickLatestRelease([release("v0.1.0-alpha.2"), release("latest"), release("v0.1.0-alpha.3", { draft: true }), release("v0.0.9"), release("v0.1.0-alpha.10", { prerelease: true })]);
    expect(picked?.release.tag_name).toBe("v0.1.0-alpha.10");
    expect(pickLatestRelease([])).toBeUndefined();
    expect(pickLatestRelease({ message: "Not Found" })).toBeUndefined();
    expect(pickLatestRelease([{ tag_name: 3 }, null, "v1.0.0"])).toBeUndefined();
  });
});

describe("UpdateService.check", () => {
  it("starts idle, passes through checking, and reports a newer release with its notes and page, from the feed alone", async () => {
    const fetch = jsonFetch(200, [release("v0.1.0-alpha.2", { body: `  ${"x".repeat(5000)}  ` }), release("v0.1.0-alpha.1")]);
    const { updates, states, warnings } = service({ fetch });
    expect(updates.getState()).toEqual({ phase: "idle", current: "0.1.0-alpha.1" });
    const result = await updates.check();
    expect(states[0]).toEqual({ phase: "checking", current: "0.1.0-alpha.1" });
    expect(result).toEqual({ phase: "available", current: "0.1.0-alpha.1", latest: "0.1.0-alpha.2", notes: "x".repeat(4000), url: `${RELEASES_URL}/tag/v0.1.0-alpha.2`, canInstall: false, checkedAt: "2026-09-20T10:00:00.000Z" });
    expect(states[1]).toEqual(result);
    expect(updates.getState()).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(FEED_URL, { headers: { accept: "application/atom+xml", "user-agent": USER_AGENT } });
    expect(warnings).toEqual([]);
  });

  it("asks the API only when the feed is unreachable or not a feed, and says so", async () => {
    const api = response(200, [release("v0.1.0-alpha.2")]);
    const down = service({ fetch: routedFetch(response(500, "Server Error"), api) });
    expect(await down.updates.check()).toMatchObject({ phase: "available", latest: "0.1.0-alpha.2", notes: "Notes for v0.1.0-alpha.2" });
    expect(down.options.fetch).toHaveBeenCalledTimes(2);
    expect(down.options.fetch).toHaveBeenLastCalledWith(API_URL, { headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT } });
    expect(down.warnings).toEqual([`[updates] The releases feed could not be used (GitHub answered HTTP 500 for ${FEED_URL}.); asking the GitHub API instead.`]);
    const html = service({ fetch: routedFetch(response(200, "<!doctype html><html><body>Sign in</body></html>"), api) });
    expect(await html.updates.check()).toMatchObject({ phase: "available", latest: "0.1.0-alpha.2" });
    expect(html.warnings).toEqual(["[updates] The releases feed could not be used (The releases feed is not an Atom document.); asking the GitHub API instead."]);
    const unreachable = service({ fetch: routedFetch(new Error("getaddrinfo ENOTFOUND github.com"), api) });
    expect(await unreachable.updates.check()).toMatchObject({ phase: "available" });
    expect(unreachable.warnings[0]).toContain("Could not reach GitHub: getaddrinfo ENOTFOUND github.com");
  });

  it("explains an exhausted API rate limit with the local reset time instead of the bare 403", async () => {
    const reset = "1790000000";
    const limited = service({ fetch: jsonFetch(403, { message: "API rate limit exceeded" }, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": reset }) });
    expect(await limited.updates.check()).toEqual({ phase: "error", current: "0.1.0-alpha.1", message: `GitHub's rate limit is exhausted; try again after ${rateLimitResetLabel(reset)}.`, checkedAt: "2026-09-20T10:00:00.000Z" });
    expect(rateLimitResetLabel(reset)).toBe(new Date(1_790_000_000_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    expect(rateLimitResetLabel(null)).toBeUndefined();
    expect(rateLimitResetLabel("soon")).toBeUndefined();
    expect(rateLimitMessage(null)).toBe("GitHub's rate limit is exhausted; try again after a few minutes.");
    const withoutReset = service({ fetch: jsonFetch(403, {}, { "x-ratelimit-remaining": "0" }) });
    expect(await withoutReset.updates.check()).toMatchObject({ phase: "error", message: "GitHub's rate limit is exhausted; try again after a few minutes." });
    // A 403 with requests left is something else (a blocked token, a policy): the status is reported as before.
    const forbidden = service({ fetch: jsonFetch(403, {}, { "x-ratelimit-remaining": "41" }) });
    expect(await forbidden.updates.check()).toMatchObject({ phase: "error", message: `GitHub answered HTTP 403 for ${API_URL}.` });
  });

  it("omits empty notes and reports up-to-date when the newest release is the running one or older", async () => {
    const { updates } = service({ fetch: jsonFetch(200, [release("v0.1.0-alpha.1", { body: null }), release("v0.0.9")]) });
    expect(await updates.check()).toEqual({ phase: "up-to-date", current: "0.1.0-alpha.1", checkedAt: "2026-09-20T10:00:00.000Z" });
    const final = service({ currentVersion: "0.1.0", fetch: jsonFetch(200, [release("v0.1.0-alpha.9", { body: "" })]) });
    expect(await final.updates.check()).toMatchObject({ phase: "up-to-date" });
    const newer = service({ currentVersion: "0.1.0", fetch: jsonFetch(200, [release("v0.2.0-alpha.1", { body: "" })]) });
    expect(await newer.updates.check()).toMatchObject({ phase: "available", latest: "0.2.0-alpha.1" });
    expect("notes" in (await newer.updates.check())).toBe(false);
  });

  it("turns a missing repository, an empty list, another HTTP status, bad JSON and a network failure into error states", async () => {
    expect(await service({ fetch: jsonFetch(404, { message: "Not Found" }) }).updates.check()).toEqual({ phase: "error", current: "0.1.0-alpha.1", message: `No releases yet at ${RELEASES_URL}.`, checkedAt: "2026-09-20T10:00:00.000Z" });
    expect(await service({ fetch: jsonFetch(200, []) }).updates.check()).toMatchObject({ phase: "error", message: `No releases yet at ${RELEASES_URL}.` });
    expect(await service({ fetch: jsonFetch(403, { message: "rate limited" }) }).updates.check()).toMatchObject({ phase: "error", message: `GitHub answered HTTP 403 for ${API_URL}.` });
    expect(await service({ fetch: routedFetch(response(503, ""), { ...response(200, ""), json: async () => { throw new Error("Unexpected token"); } }) }).updates.check()).toMatchObject({ phase: "error", message: "GitHub's answer was not JSON: Unexpected token" });
    expect(await service({ fetch: vi.fn(async () => { throw new Error("getaddrinfo ENOTFOUND api.github.com"); }) }).updates.check()).toMatchObject({ phase: "error", message: "Could not reach GitHub: getaddrinfo ENOTFOUND api.github.com" });
    expect(await service({ currentVersion: "preview" }).updates.check()).toMatchObject({ phase: "error", message: expect.stringContaining('"preview" is not a version number') });
  });

  it("shares one check in flight", async () => {
    const fetch = jsonFetch(200, [release("v0.1.0-alpha.2")]);
    const { updates } = service({ fetch });
    const [a, b] = await Promise.all([updates.check(), updates.check()]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("opens the available release's page, else the repository's releases", async () => {
    const { updates, options } = service({ fetch: jsonFetch(200, [release("v0.1.0-alpha.2")]) });
    await updates.openReleasePage();
    expect(options.openExternal).toHaveBeenLastCalledWith(RELEASES_URL);
    await updates.check();
    await updates.openReleasePage();
    expect(options.openExternal).toHaveBeenLastCalledWith(`${RELEASES_URL}/tag/v0.1.0-alpha.2`);
  });
});

describe("UpdateService.install", () => {
  it("rejects with UPDATE_INSTALL_UNAVAILABLE without an installer, or when the build is unsupported", async () => {
    const none = service({ fetch: jsonFetch(200, [release("v0.1.0-alpha.2")]) });
    await expect(none.updates.install()).rejects.toThrow(UPDATE_NOT_AVAILABLE);
    await none.updates.check();
    await expect(none.updates.install()).rejects.toThrow(UPDATE_INSTALL_UNAVAILABLE);
    const { installer } = fakeInstaller({ isSupported: () => false });
    const unsupported = service({ fetch: jsonFetch(200, [release("v0.1.0-alpha.2")]), installer });
    expect(await unsupported.updates.check()).toMatchObject({ phase: "available", canInstall: false });
    await expect(unsupported.updates.install()).rejects.toThrow(UPDATE_INSTALL_UNAVAILABLE);
    expect(installer.check).not.toHaveBeenCalled();
  });

  it("downloads with progress, becomes ready, and restarts into the update", async () => {
    let finishDownload: () => void = () => undefined;
    const { installer, emit, listeners } = fakeInstaller({ download: vi.fn(() => new Promise<void>((resolve) => { finishDownload = resolve; })) });
    const { updates, states } = service({ fetch: jsonFetch(200, [release("v0.1.0-alpha.2")]), installer });
    expect(await updates.check()).toMatchObject({ phase: "available", canInstall: true });
    const installing = updates.install();
    await Promise.resolve();
    expect(updates.getState()).toEqual({ phase: "downloading", current: "0.1.0-alpha.1", latest: "0.1.0-alpha.2", percent: 0 });
    emit("onProgress", 42.5);
    expect(updates.getState()).toMatchObject({ phase: "downloading", percent: 42.5 });
    // A check during the download leaves it alone.
    expect(await updates.check()).toMatchObject({ phase: "downloading" });
    emit("onDownloaded");
    expect(updates.getState()).toEqual({ phase: "ready", current: "0.1.0-alpha.1", latest: "0.1.0-alpha.2" });
    expect(installer.install).not.toHaveBeenCalled();
    finishDownload();
    await installing;
    expect(installer.check).toHaveBeenCalledTimes(1);
    expect(installer.install).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    expect(states.map((state) => state.phase)).toEqual(["checking", "available", "downloading", "downloading", "ready"]);
    // From ready, install restarts at once.
    await updates.install();
    expect(installer.install).toHaveBeenCalledTimes(2);
  });

  it("turns the platform's refusal of an unsigned bundle into an error and stops offering to install for the session", async () => {
    const { installer, emit } = fakeInstaller({ download: vi.fn(async () => { emit("onError", new Error("Code signature at URL file:///tmp/Quire.app did not pass validation")); throw new Error("Code signature at URL file:///tmp/Quire.app did not pass validation"); }) });
    const { updates } = service({ fetch: jsonFetch(200, [release("v0.1.0-alpha.2")]), installer });
    await updates.check();
    await expect(updates.install()).rejects.toThrow(/Code signature/);
    expect(updates.getState()).toEqual({ phase: "error", current: "0.1.0-alpha.1", message: "Code signature at URL file:///tmp/Quire.app did not pass validation", checkedAt: "2026-09-20T10:00:00.000Z" });
    expect(await updates.check()).toMatchObject({ phase: "available", canInstall: false });
    await expect(updates.install()).rejects.toThrow(UPDATE_INSTALL_UNAVAILABLE);
  });

  it("keeps offering to install after a plain download failure", async () => {
    const { installer } = fakeInstaller({ download: vi.fn(async () => { throw new Error("net::ERR_CONNECTION_RESET"); }) });
    const { updates } = service({ fetch: jsonFetch(200, [release("v0.1.0-alpha.2")]), installer });
    await updates.check();
    await expect(updates.install()).rejects.toThrow("net::ERR_CONNECTION_RESET");
    expect(updates.getState()).toMatchObject({ phase: "error", message: "net::ERR_CONNECTION_RESET" });
    expect(await updates.check()).toMatchObject({ phase: "available", canInstall: true });
  });
});

describe("UpdateService scheduling", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("checks 15 s after start and every 24 h, reading the setting at each tick", async () => {
    let auto = true;
    const fetch = jsonFetch(200, [release("v0.1.0-alpha.1")]);
    const { updates } = service({ fetch, autoCheck: () => auto });
    updates.start();
    updates.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(updates.getState()).toMatchObject({ phase: "up-to-date" });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    auto = false;
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    auto = true;
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(3);
    updates.stop();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("never checks while the setting is off, and stop before the first tick cancels it", async () => {
    const fetch = jsonFetch(200, [release("v0.1.0-alpha.1")]);
    const off = service({ fetch, autoCheck: () => false });
    off.updates.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS);
    expect(fetch).not.toHaveBeenCalled();
    expect(off.updates.getState()).toEqual({ phase: "idle", current: "0.1.0-alpha.1" });
    off.updates.stop();
    const stopped = service({ fetch });
    stopped.updates.start();
    stopped.updates.stop();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(fetch).not.toHaveBeenCalled();
  });
});
