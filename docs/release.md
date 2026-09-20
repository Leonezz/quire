# Releasing Quire

Quire ships as a macOS app built with electron-builder from `apps/desktop`. Releases live on this
repository's Releases page, which is also what the in-app updater polls. The extraction eval's
page snapshots (`eval/corpus/`) are third-party content and stay local (gitignored); everything
else is public.

## Two ways to publish

**Locally, signed with the Apple Development identity (the alpha path).** GitHub's runners have no
certificate, and electron-updater refuses to install unsigned macOS builds, so alphas are built on
the maintainer's Mac:

```sh
pnpm build
pnpm --filter @read/desktop release:local
```

`release:local` signs with `Apple Development: leonez12138@gmail.com (LGNAH9RZH4)` (override with
`CSC_NAME`), publishes with `gh auth token` (override with `GH_TOKEN`), and creates the GitHub
release as a draft named `v<version>`; publish it from the Releases page after checking the
assets (`.dmg`, `.zip`, `latest-mac.yml` per architecture). A development certificate is not
trusted by Gatekeeper on other Macs — users follow the "First launch" steps in the README — but
it is a valid code signature, so in-app updates install in place between builds signed with the
same identity.

**On GitHub Actions (unsigned, or Developer ID when the secrets exist).** `release.yml` runs only
by hand (Actions → Release → Run workflow, with an existing tag) and publishes with the job's own
`GITHUB_TOKEN`. It is deliberately not tag-triggered: a local `release:local` publish creates the
tag, and a tag-triggered run would then overwrite the signed assets with unsigned ones. Without `CSC_LINK` /
`CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` the build is
unsigned and the updater only offers the download; with a Developer ID certificate and those
secrets the build is signed, notarized, and installs in place.

## Cutting an alpha

1. Bump the version in `apps/desktop/package.json` (for example `0.1.0-alpha.2`). The release
   workflow refuses a tag that does not match this field.
2. Commit, then tag and push the tag:

   ```sh
   git commit -am "chore: release 0.1.0-alpha.2"
   git tag v0.1.0-alpha.2
   git push origin main v0.1.0-alpha.2
   ```

3. `.github/workflows/release.yml` runs on a `macos-14` runner:
   - installs the workspace with pnpm and runs `pnpm build` (electron-vite writes `apps/desktop/out`);
   - runs `electron-builder --mac --publish always`, which packages `Quire.app` for `arm64` and
     `x64`, produces a `.dmg` and a `.zip` per architecture plus `latest-mac.yml`, and creates a
     release `v<version>` on this repository with those files;
   - uploads the same files as a workflow artifact (`quire-v<version>-mac`);
   - writes the release notes from the `feat:`/`fix:` commits since the previous tag and marks the
     release as a prerelease when the tag contains `alpha` or `beta` (otherwise it becomes the
     latest release).

Tags containing `alpha`/`beta` stay prereleases; electron-updater in the app decides separately
whether prereleases are offered.

## Secrets

Set these in the source repository (Settings → Secrets and variables → Actions):

| Secret | Required | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | automatic | The job's own token; releases are created on this repository. |
| `CSC_LINK` | for signing | Base64 of the **Developer ID Application** certificate exported as `.p12` (`base64 -i cert.p12 | pbcopy`). |
| `CSC_KEY_PASSWORD` | with `CSC_LINK` | Password of that `.p12`. |
| `APPLE_ID` | for notarization | Apple ID of the developer account. |
| `APPLE_APP_SPECIFIC_PASSWORD` | with `APPLE_ID` | An app-specific password for that Apple ID (appleid.apple.com). |
| `APPLE_TEAM_ID` | with `APPLE_ID` | The 10-character team id. |

The workflow only exports a signing or notarization variable when its secret exists, and fails
early when a set is incomplete (for example `APPLE_ID` without `APPLE_TEAM_ID`, or notarization
requested without a certificate).

### Why signing matters

- **Unsigned build** (no `CSC_LINK`): the workflow sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and
  electron-builder skips signing and notarization. The app runs, but Gatekeeper reports it as from
  an unidentified developer (right-click → Open, or `xattr -d com.apple.quarantine Quire.app`),
  and **electron-updater refuses to install updates of unsigned macOS apps**, so users download each
  alpha by hand from the release page.
- **Signed + notarized build**: with a Developer ID certificate and the three `APPLE_*` secrets the
  app is signed under the hardened runtime (entitlements in `apps/desktop/build/entitlements.mac.plist`,
  only `com.apple.security.cs.allow-jit`), notarized with `notarytool` and stapled. This is what
  makes in-app auto-update work on macOS.

## Packaging configuration

`apps/desktop/electron-builder.yml` holds the configuration; the notable decisions:

- `files` restricts `node_modules` in the asar to the main process's runtime externals and their
  dependency closure (`@mixmark-io/domino`, `linkedom`, `mathml-to-latex`, `temml`, `pdfjs-dist`,
  see `electron.vite.config.ts`). Everything else is bundled into `out/` by Vite. When an external
  or one of its dependencies changes, update that list; a missing package fails loudly at launch.
- `extraMetadata.productName: Quire` makes the packaged app store its data under
  `~/Library/Application Support/Quire`, separate from the dev app (`@read/desktop`).
- `npmRebuild: false`: there are no native modules to rebuild (`node:sqlite` ships with Electron).
- `publish` targets this repository (`Leonezz/quire`) with `releaseType: prerelease`.

## Local smoke test

Before tagging, package the app for the current architecture and launch it from a terminal so the
main process's stderr is visible:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @read/desktop package:dir
apps/desktop/release/mac-arm64/Quire.app/Contents/MacOS/Quire
```

The window should open on the Inbox with nothing on stderr (a missing module in the asar shows up
here as `Cannot find module`). `~/Library/Application Support/Quire/quire.sqlite` appears on first
launch. `pnpm --filter @read/desktop package` additionally builds the dmg and zip for both
architectures into `apps/desktop/release/`; without `--publish` nothing is uploaded.

## Continuous integration

`.github/workflows/ci.yml` runs `pnpm typecheck` and `pnpm test` on Ubuntu for pushes to `main`
and pull requests. The `@read/ui` tests render every story in headless Chromium, so the job installs
Playwright's Chromium (cached between runs). The Electron binary download is skipped there because
nothing in the checks launches Electron.
