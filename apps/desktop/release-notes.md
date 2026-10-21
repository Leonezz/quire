Fourth alpha: report a page that rendered badly in one step, lists that look like lists again, and the agent's conversations kept out of your Codex app.

**macOS only.** Download the `.dmg` for your Mac (`arm64` for Apple silicon, `x64` for Intel) and drag Quire to Applications. If you have an earlier alpha, **Settings › About → Check for updates** installs this one in place.

**First launch.** The alpha is signed with a development certificate but not notarized, so macOS refuses it once: right-click Quire → **Open** → **Open** again, or **System Settings → Privacy & Security → Open Anyway**. Or in Terminal: `xattr -d com.apple.quarantine /Applications/Quire.app`.

## New

- **Report a rendering problem in one step.** Press **⌥⌘R** anywhere while reading, or select the broken passage and choose **Report** in the selection toolbar (the quality badge, the Info panel and the low-quality banner still work too). Picking a problem type and writing a note are optional. Press **Report** and Quire captures everything — the saved original page (or the PDF), what it extracted, a screenshot of what you see, the whole article, and the original page at the same spot — into one zip. It then opens a prefilled GitHub issue, shows the zip in Finder and puts a side-by-side screenshot on your clipboard: press **⌘V** in the issue and drag the zip in. Nothing is uploaded by the app; untick "Include the original page" for private pages. Your reports are listed in **Settings › Feedback**.

## Fixed

- Bulleted and numbered lists show their bullets and numbers again in the reader.
- The selection toolbar sits centred over the selection (it was drawn half its width to the left).
- Settings › About shows the real version number.
- The agent's conversations no longer appear in your Codex app: Quire now runs Codex in its own space. **After updating, sign in to ChatGPT once more in Settings › Agent.** Threads an earlier alpha left in your Codex app can be removed with `node apps/desktop/scripts/clean-codex-threads.mjs` from a checkout.

## Known problems

We now check extraction against screenshots of every page in our test set; the problems it found are tracked in [#8](https://github.com/Leonezz/quire/issues/8) and grouped by cause in #14–#24 — for example embedded videos and interactive demos leaving no trace (#14), some lazy-loaded images going missing (#15) and note/callout boxes being dropped (#17). If a page you read is affected, ⌥⌘R is the fastest way to tell us.
