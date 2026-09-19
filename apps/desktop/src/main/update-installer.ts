import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { isPrerelease, parseSemver } from "./engine/semver";
import type { UpdateFeed, UpdateInstaller } from "./engine/updates";

// electron-updater behind the engine's `UpdateInstaller` seam. It only ever downloads on request
// (autoDownload off) and follows the alpha channel while the running version is a prerelease.
// A macOS build can replace itself only when it carries a real (Developer ID) signature: Squirrel.Mac
// refuses an ad-hoc or unsigned bundle at install time, so an unsigned build reports itself unsupported
// up front and the renderer offers the download instead.

export interface ElectronInstallerOptions {
  feed: UpdateFeed;
  currentVersion: string;
  warn: (message: string) => void;
}

const CODESIGN_TIMEOUT_MS = 10_000;

/** The .app bundle around the running executable (Quire.app/Contents/MacOS/Quire → Quire.app). */
function bundlePath(): string {
  return resolve(app.getPath("exe"), "..", "..", "..");
}

/** True when `codesign` reports a certificate chain (Authority=…) rather than an ad-hoc or missing signature. */
function hasDeveloperSignature(bundle: string, warn: (message: string) => void): Promise<boolean> {
  return new Promise((done) => {
    execFile("codesign", ["-dv", "--verbose=2", bundle], { timeout: CODESIGN_TIMEOUT_MS }, (error, _stdout, stderr) => {
      const report = String(stderr);
      if (error && !/not signed at all/.test(report)) warn(`[updates] codesign could not describe ${bundle}: ${error.message}`);
      done(!error && /^Authority=/m.test(report) && !/Signature=adhoc/.test(report));
    });
  });
}

export function createElectronInstaller({ feed, currentVersion, warn }: ElectronInstallerOptions): UpdateInstaller {
  let supported = false;
  if (!app.isPackaged) warn("[updates] development build: updates are checked but never installed in place");
  else if (process.platform !== "darwin") supported = true;
  else void hasDeveloperSignature(bundlePath(), warn).then((signed) => {
    supported = signed;
    if (!signed) warn("[updates] this build carries no Developer ID signature, so a new release downloads from its page instead of installing in place");
  });

  autoUpdater.autoDownload = false;
  autoUpdater.allowPrerelease = true;
  const version = parseSemver(currentVersion);
  if (version && isPrerelease(version)) autoUpdater.channel = "alpha";
  autoUpdater.setFeedURL({ provider: "github", owner: feed.owner, repo: feed.repo });
  autoUpdater.logger = { info: () => undefined, warn: (message) => warn(`[updates] ${String(message)}`), error: (message) => warn(`[updates] ${String(message)}`) };

  return {
    isSupported: () => supported,
    check: async () => { await autoUpdater.checkForUpdates(); },
    download: async () => { await autoUpdater.downloadUpdate(); },
    install: () => autoUpdater.quitAndInstall(),
    subscribe: ({ onProgress, onDownloaded, onError }) => {
      const progress = (info: { percent: number }) => onProgress(info.percent);
      const downloaded = () => onDownloaded();
      const failed = (error: Error) => onError(error);
      autoUpdater.on("download-progress", progress);
      autoUpdater.on("update-downloaded", downloaded);
      autoUpdater.on("error", failed);
      return () => {
        autoUpdater.off("download-progress", progress);
        autoUpdater.off("update-downloaded", downloaded);
        autoUpdater.off("error", failed);
      };
    },
  };
}
