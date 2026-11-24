# Releasing Quire (Tauri 2)

Quire ships as a native macOS app built with **Tauri 2** (`apps/desktop/src-tauri` + Vite frontend in
`apps/desktop/src/renderer`). Releases live on this repository's Releases page, which is also what
the in-app updater polls. The extraction eval's page snapshots (`eval/corpus/`) are third-party
content and stay local (gitignored); everything else is public.

## Publishing on GitHub Actions

`.github/workflows/release.yml` runs manually via `workflow_dispatch`:

```sh
gh workflow run release.yml -f tag=v0.2.0-alpha.1
```

Pass `-f runner=macos-15-intel` or `-f runner=macos-26-intel` when GitHub's arm64 pool is congested;
because Rust cross-compiles both `aarch64-apple-darwin` and `x86_64-apple-darwin` targets natively,
either runner produces both `Quire-<version>-arm64.dmg` and `Quire-<version>-x64.dmg`.

It reuses the repository's existing signing and notarization secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, mapped to Tauri's `APPLE_CERTIFICATE*`
and `APPLE_*` environment variables) for Developer ID team `7Z39KUX3QC`.

## Cutting a release

1. Align the version across:
   - `apps/desktop/package.json`
   - `apps/desktop/src-tauri/Cargo.toml`
   - `apps/desktop/src-tauri/tauri.conf.json`
2. Commit, tag `v<version>`, and push.
3. Trigger `gh workflow run release.yml -f tag=v<version>`.

## Local build & smoke test

Build the `.app` and `.dmg` locally:

```sh
pnpm --filter @read/desktop package
```

Launch the built binary directly to inspect logs and verify startup:

```sh
apps/desktop/src-tauri/target/release/bundle/macos/Quire.app/Contents/MacOS/quire-desktop
```

User data is stored at `~/Library/Application Support/Quire` (`quire.sqlite` WAL schema v4,
`materials/`, `images/`, `figures/`, `annotations/`, `settings.json`, `feedback/`, `codex/`),
100% compatible with libraries created by earlier builds. Override `QUIRE_DATA_DIR` to point at an
isolated directory during testing.
