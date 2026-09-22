Third alpha: the first seven issues reported on alpha.2, plus a text view for PDFs.

**macOS only.** Download the `.dmg` for your Mac (`arm64` for Apple silicon, `x64` for Intel) and drag Quire to Applications. If you have alpha.2, **Settings › About → Check for updates** installs this one in place.

**First launch.** The alpha is signed with a development certificate but not notarized, so macOS refuses it once: right-click Quire → **Open** → **Open** again, or **System Settings → Privacy & Security → Open Anyway**. Or in Terminal: `xattr -d com.apple.quarantine /Applications/Quire.app`.

The agent needs the [Codex CLI](https://github.com/openai/codex) installed and signed in (`codex login`); everything else works without it.

## Fixed

- **#1** Setting a custom Codex path now enables the agent immediately: `~` is expanded, a directory or the npm shim is accepted, and every panel re-reads the agent status when the path, model or effort changes.
- **#2 · #5** The agent no longer prints raw ids. Citations render as titled pills; a pill that follows a quoted passage jumps the reader to that passage (in the article reader and in the PDF reader) and tells you when the passage could not be found.
- **#3** The contents rail sits at the edge and stays hidden until you move the pointer to the right edge, focus it, or pin it with `t`. It also rebuilds when you switch views.
- **#4** The agent knows what it can do: it writes documents into the library as artifacts when asked to draft, save or synthesise, and never claims it cannot create files.
- **#6** The update check no longer fails with `GitHub answered HTTP 403`: it reads the public releases feed first and only falls back to the API, and says when to retry if the rate limit is exhausted.
- **#7** The selection toolbar no longer covers the line above the selection; it sits 10px above it and flips below when there is no room.

## New

- **Text view for PDFs.** Any PDF gets a reflowed, single-column reading view (`v` cycles Web page · PDF · Text): columns merged, headers and footers dropped, headings in the contents rail, figures cropped from the page. Highlights made in the text view are mirrored to the PDF and back. Reflow quality is reported per document; degraded pages are marked. Optional: Settings › Reading can use a small hosted judge model (TypeSafe Jev) to decide what is body text; the default is rules only and fully local.

Please keep reporting: sites that extract badly go straight into the evaluation set, and PDFs that reflow badly into the layout set.
