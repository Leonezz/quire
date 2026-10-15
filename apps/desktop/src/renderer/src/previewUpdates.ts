import type { ReadApiUpdates, UpdateState } from "../../shared/contracts";

// The browser preview's updates: no GitHub, no installer. A check answers after a short pause with a
// fake newer alpha (or "up to date" behind the switch below), so the About section and the sidebar
// banner can be exercised; installing is refused the way an unsigned build refuses, and the download
// runs a fake progress to a fake file in Downloads.

export const PREVIEW_UPDATE_SWITCH = "read:preview-update";
export const PREVIEW_VERSION = "preview";
const PREVIEW_LATEST = "0.1.0-alpha.2";
const PREVIEW_URL = "https://github.com/Leonezz/quire/releases/tag/v0.1.0-alpha.2";
const CHECK_DELAY_MS = 600;
const DOWNLOAD_STEP_MS = 120;
const PREVIEW_DOWNLOAD_URL = `https://github.com/Leonezz/quire/releases/download/v${PREVIEW_LATEST}/Quire-${PREVIEW_LATEST}-arm64.dmg`;
const PREVIEW_NOTES = [
  "## What's new", "",
  "- The reader keeps its place when a material is rebuilt.",
  "- Inbox items show their source's health at a glance.",
  "- **Updates** arrive through GitHub Releases; signed builds install in place.", "",
  "## Fixes", "",
  "- PDF annotations survive a view switch.",
  "- Feeds with a bad `Last-Modified` header sync again.",
].join("\n");

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export function createPreviewUpdates(): ReadApiUpdates {
  const listeners = new Set<(state: UpdateState) => void>();
  let state: UpdateState = { phase: "idle", current: PREVIEW_VERSION };
  const set = (next: UpdateState) => { state = next; for (const listener of listeners) listener(next); };

  return {
    getUpdateState: async () => state,
    checkForUpdates: async () => {
      set({ phase: "checking", current: PREVIEW_VERSION });
      await wait(CHECK_DELAY_MS);
      const checkedAt = new Date().toISOString();
      set(localStorage.getItem(PREVIEW_UPDATE_SWITCH) === "uptodate"
        ? { phase: "up-to-date", current: PREVIEW_VERSION, checkedAt }
        : { phase: "available", current: PREVIEW_VERSION, latest: PREVIEW_LATEST, notes: PREVIEW_NOTES, url: PREVIEW_URL, canInstall: false, downloadUrl: PREVIEW_DOWNLOAD_URL, checkedAt });
      return state;
    },
    installUpdate: async () => { throw new Error("UPDATE_INSTALL_UNAVAILABLE"); },
    downloadUpdate: async () => {
      if (state.phase !== "available") throw new Error("UPDATE_NOT_AVAILABLE");
      const { current, latest } = state;
      for (let percent = 0; percent <= 100; percent += 10) {
        set({ phase: "downloading", current, latest, percent });
        await wait(DOWNLOAD_STEP_MS);
      }
      set({ phase: "saved", current, latest, path: `~/Downloads/Quire-${latest}-arm64.dmg` });
    },
    openDownloadedUpdate: async () => undefined,
    openReleasePage: async () => undefined,
    onUpdateState: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
