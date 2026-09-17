# Extraction & Rendering Quality Review — Round 2

Re-scored all 64 docs in `eval/out/` against the same 0–2 rubric (Title, Byline, Date, Body-start, Body-end, Completeness, Element-fidelity) and the same PASS/MINOR/MAJOR rule used in `eval/quality-review.md`. Method: `head`/`tail`/`rg`/`grep`/`sed`/small Python scripts against `source.txt`/`extracted.md`, cross-checked against `summary.json`'s own claims, plus a live-browser spot-check of 5 docs (paulgraham-greatwork, jaykmody-gpt, lilian-attention, githubblog-copilotx, ruanyifeng-curl) at `http://localhost:5173/`. `bair-koala` and `coolshell-rust` are still absent from `eval/out/` entirely (unchanged pipeline failure) and are excluded from the 64.

---

## 1. Summary

**New Part A verdicts (64 docs): 46 PASS · 4 MINOR · 14 MAJOR** (previously 36 PASS · 6 MINOR · 22 MAJOR).

- 7 docs moved MAJOR → PASS: `ciechanowski-gps`, `codinghorror-nocode`, `githubblog-copilotx`, `hf-rlhf`, `jaykmody-gpt`, `mitchellh-large`, `ruder-optim`.
- 1 doc moved MAJOR → MINOR: `webdev-vitals`.
- 4 docs moved MINOR → PASS: `joelonsoftware-test`, `pragmaticengineer-product`, `ruanyifeng-curl`, `ruanyifeng-weekly`.
- 14 docs stayed MAJOR (see table).
- 2 docs stayed MINOR (`gwern-scaling`, `kentcdodds-context`).
- 1 doc **regressed PASS → MINOR**: `mtlynch-google` (see §2).
- 35 previously-PASS docs stayed PASS.

### Fate of the previous top-10 issues

| # | Issue | Status | Detail |
|---|---|---|---|
| 1 | Duplicate title heading (28/64, 44%) | **FIXED — 0/64.** | Verified with exact *and* fuzzy (difflib ratio) matching of the first heading against `summary.title` across every doc: zero matches anywhere. `ruder-optim`, `mitchellh-large` (was triple), `jxnl-rag`, `hf-rlhf` and all other previously-cited cases now emit exactly one H1. |
| 2 | Heading permalink/anchor cruft (~24/64, 38%) | **Fixed for 23/24; 1 unchanged.** | Full heading-wrapped-in-link (10 docs incl. `jvns-firecracker`, `gwern-scaling`, `stratechery-endbeginning`, `ruder-optim`) — all confirmed clean, zero matches. Trailing `#`/🔗 glued to text (`lilian-agent`, `lilian-attention`, `mtlynch-google`) — confirmed fixed live in browser for `lilian-attention` ("Transformer", "Key, Value and Query" render clean bold black, no trailing `#`). Anchor-icon-image on every heading (`ciechanowski-gps`, 15/15 headings) — fixed. Empty `[]()` prefix (`csstricks-flexbox`, `hf-rlhf`, `mitchellh-large`, `rustblog-1.0`, `pytorch-genai2`, `raschka-selfattention`) — 6/7 fixed. **Unchanged:** `joshwcomeau-rerender` still glues literal `[Link to this heading](url)` text directly onto every heading (`## [Link to this heading](url)The core React loop`), still 8 occurrences. |
| 3 | Related-content/promo widgets kept as body (7 docs) | **Fixed for 3, unchanged for 3, 1 new occurrence found.** | `githubblog-copilotx` confirmed fixed live (ends cleanly on "Let's build from here 🚀", headings list is down to the 2 real headings). `codinghorror-nocode`'s trailing bio-card is gone (body now ends on real text) though a fake heading at the *top* remains. `hf-rlhf`'s 2 broken related-post cards are gone, but a bare, unformatted "More Articles from our Blog" text fragment is still the file's last line. **Unchanged:** `quanta-understand` (newsletter widget + share icons), `stratechery-endbeginning` (now "More by Sharp Text" instead of "More by Ben Thompson" — same category, source content just changed), `pragmaticengineer-product` (trailing "Gergely Orosz" bio card). **New:** `mtlynch-google` now ends on an empty "Discuss on" heading plus a full "Read My Book" self-promo section with cover image — not flagged last time (see Regressions). |
| 4 | Broken "card-link" markdown `\[...]\(<url>)` (10 docs) | **Unfixed for 9/10; fixed for 1; 2 new manifestations found.** | Identical, still-broken in `acx-sleeper` (8), `interconnects-o1` (8), `karpathy-software2` (3), `latentspace-ai-engineer` (7), `medium-backprop` (3, but now only at the top — tail is clean), `oneusefulthing-centaurs` (**7, up from 1**), `quanta-understand` (12, down from 36 but still present), `raschka-understanding-llms` (20, unchanged). `hf-rlhf` fixed. **New:** the same broken syntax now also wraps **entire H2 headings** in `fasterthanlime-golang` (`\[` / `## Garden-variety takes on Go` / `]\(<url>)` — 5 headings, all of them), and wraps **footnote-reference numbers** in `paulgraham-greatwork` (29 of ~29 footnotes, see #9 below and Regressions). |
| 5 | Math-delimiter fragility (`jaykmody-gpt` footnote raw LaTeX; `ruder-optim` stray `\(`/`\)`) | **jaykmody-gpt: FIXED (confirmed live).** `ruder-optim`'s H1-instead-of-H2 heading bug is fixed too; its equation delimiters now use a different pattern (see table row). | Browser-confirmed: `jaykmody-gpt` footnote 5's softmax equation now renders as a proper KaTeX display block, no raw `\[ \text{softmax}... \]` text visible anywhere on screen. |
| 6 | Byline extraction misses explicit on-page byline (8 confirmed) | **Fixed for 4/8.** | `joelonsoftware-test` ("Joel Spolsky"), `rustblog-1.0` ("The Rust Core Team"), `ruanyifeng-curl` and `ruanyifeng-weekly` (阮一峰) all now populated correctly — `ruanyifeng-curl` confirmed live in the reader's own header. **Unchanged/still null:** `openai-4o`, `webdev-vitals`, `mitchellh-large`, `stratechery-endbeginning`. |
| 7 | CJK date rounds to 1st of month (2/2 zh docs) | **FIXED — 2/2.** | `ruanyifeng-curl`: `publishedAt` now `2019-09-05` (was `2019-09-01`), confirmed live in the reader header ("2019/9/5"). `ruanyifeng-weekly`: now `2024-01-19` (was `2024-01-01`). Both exactly match the page's own "YYYY年M月D日" text. |
| 8 | Title picks wrong text (4 confirmed) | **Fixed for 3/4.** | `webdev-vitals`: title is now clean `"Web Vitals"` (was padded with a Google Collections tooltip) — confirmed live. `oneusefulthing-centaurs`: now the correct full title `"Centaurs and Cyborgs on the Jagged Frontier"` (was just the first section heading). `godev-pipelines`: no longer suffixed with `" - The Go Programming Language"`. **Unchanged:** `ciechanowski-gps` still `"GPS – Bartosz Ciechanowski"` (author name still appended). |
| 9 | Paragraph breaks lost on `<br>`-only pages (`paulgraham-greatwork`) | **FIXED, but a new defect appeared in its place.** | `summary.json` now reports `"paragraphs": 292` (was 1) for the same 11,849-word essay, and the browser confirms proper paragraph spacing throughout. However, the doc's ~29 footnote-reference markers (previously invisible, masked by the single-paragraph bug) now each render as an **isolated, disconnected one-line paragraph** — e.g. a lone blue `[1]` sitting on its own line/paragraph, breaking the sentence it belongs to. Confirmed on screen. This is why the doc is still MAJOR, just for a different reason. |
| 10 | Two corpus URLs produce no output (`bair-koala`, `coolshell-rust`) | **Unchanged.** | Still no `eval/out/bair-koala/` or `eval/out/coolshell-rust/` directory at all. |

**Net read:** every high-frequency *cosmetic* bug (duplicate title, heading-permalink cruft) is now essentially eliminated corpus-wide. The remaining MAJOR docs are almost all driven by the single surviving high-frequency bug — broken `\[...]\(<url>)` card-link serialization — which is unchanged in the cases it always affected (avatar/image/related-post cards) and has now spread to two new contexts (headings in one doc, footnote references in two docs).

---

## 2. Regressions

**One confirmed regression: `mtlynch-google` (PASS → MINOR).**

Its old issue (🔗︎ emoji glued to every heading) is fixed — headings are clean now (`## The first two years`, `## Metrics or it didn't happen`, etc., no trailing emoji). But the article now ends with:

```
#### Discuss on

## Read My Book

[![](https://mtlynch.io/images/refactoring-english/refactoring-english-cover2-800px.webp)](https://refactoringenglish.com/)

I'm writing a book of simple techniques to help developers improve their writing.
...
```

The real essay ends at `*Illustrations by Loraine Yow.*`; everything after that — an empty "Discuss on" heading and a full book-promo section with cover image — is site chrome kept as article body, and both fragments leak into `summary.json`'s own `headings` array (`..., 'Discuss on', 'Read My Book'`). New score: Be=0, C=1, Ef=1 → MINOR. This exact defect class (issue #3, "related-content/promo widgets kept as body") was not caught for this doc in the previous review; whether it's a true regression from the extractor change or a previously-missed pre-existing bug, it is real and present now.

**Two docs worth flagging even though their verdict didn't drop (partial regressions inside an otherwise-fixed doc):**

- `paulgraham-greatwork`: the paragraph fix is a major win, but the newly-exposed footnote-isolation bug (§1, issue #9) is severe enough on its own (29 occurrences) to keep the doc at MAJOR.
- `oneusefulthing-centaurs`: title is now fully correct, but the broken-card-link count went from 1 occurrence (previously) to 7 — a real increase in the surviving defect's frequency inside the same document.

No other doc scored lower on any column than in the previous review.

---

## 3. Part A — per-doc scores (all 64 docs)

Columns: **T**itle, **B**yline, **D**ate, **B**ody-**s**tart, **B**ody-**e**nd, **C**ompleteness, **E**lement-**f**idelity (0–2 each). Verdict: MAJOR if 0 on C or Ef, or ≥2 zeros anywhere; PASS if total ≥11 and no disqualifying zero; else MINOR. Δ = change vs. previous review.

| Slug | T | B | D | Bs | Be | C | Ef | Verdict | Δ | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| acoup-gondor1 | 2 | 2 | 2 | 2 | 2 | 2 | 1 | PASS | = | Unchanged, clean |
| acx-sleeper | 2 | 2 | 2 | 0 | 2 | 2 | 0 | MAJOR | = | Dup title FIXED, but body still opens with broken `\[`/`![avatar]`/`]\(<url>)` card |
| anthropic-mapping | 2 | 2 | 0 | 2 | 0 | 1 | 1 | MAJOR | = | `publishedAt` still null (page: "May 21, 2024"); now ends on a **completely empty** `## Policy Memo` heading, zero content beneath (worse truncation than before) |
| bair-koala | – | – | – | – | – | – | – | **MISSING** | = | Still no `eval/out/` directory |
| brendangregg-cpu | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | = | Unchanged, clean |
| ciechanowski-gps | 1 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ MAJOR→PASS | Date now correct (was null); anchor-icon-image on all 15 headings FIXED; only title still padded with author name |
| cloudflare-pingora | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | = | Unchanged, clean |
| codinghorror-nocode | 2 | 2 | 2 | 1 | 2 | 1 | 1 | PASS | ⬆ MAJOR→PASS | Trailing author-bio card is GONE, article now ends on real text; still opens with avatar-link + fake `#### Jeff Atwood` heading that pollutes the headings list |
| colah-lstm | 2 | 2 | 2 | 2 | 2 | 2 | 1 | PASS | = | Dup title also now fixed (bonus); footnote still a manual numbered link not `[^n]` |
| coolshell-rust | – | – | – | – | – | – | – | **MISSING** | = | Still no `eval/out/` directory |
| csstricks-flexbox | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ | Empty `[]()` prefix on 30 headings FIXED |
| danluu-files | 2 | 2 | 1 | 2 | 2 | 2 | 2 | PASS | = | `source.txt` still empty; benefit of doubt retained |
| distill-featurevis | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ | Dup title fully fixed (was adjacency-dependent before) |
| eugeneyan-llm-patterns | 2 | 2 | 2 | 2 | 1 | 2 | 1 | PASS | = | `source.txt` still empty; still ends on newsletter CTA |
| fasterthanlime-golang | 2 | 2 | 2 | 2 | 2 | 2 | 0 | MAJOR | = | `codeBlocks:70` claimed, still **zero** fenced blocks in the file; **new**: 5 of its H2 headings are now wrapped in the same broken `\[`/`]\(<url>)` card syntax (`\[` / `## Garden-variety takes on Go` / `]\(<url>)`) |
| githubblog-copilotx | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ MAJOR→PASS | **Browser-confirmed**: ends cleanly on "Let's build from here 🚀"; bio card + 4 promo cards fully gone; headings list down to the 2 real headings |
| godev-pipelines | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ | Title no longer suffixed " - The Go Programming Language"; dup title fixed |
| gradient-icl | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | = | Unchanged, clean |
| gwern-scaling | 2 | 2 | 1 | 2 | 0 | 1 | 1 | MINOR | = | Backlinks/Similar-Links/Bibliography still literal placeholder-bracket text, unchanged; date null (defensible) |
| hamel-evals | 2 | 2 | 2 | 1 | 2 | 1 | 1 | PASS | ⬆(partial) | Quarto frontmatter leak reduced from 6 floating lines to 3 (Author/Published lines now correctly extracted into metadata instead of leaking); "LLMs / evals / description" fragments still leak before the real intro |
| harvard-annotated-transformer | 2 | 1 | 1 | 2 | 2 | 2 | 2 | PASS | = | Byline/date still ambiguous (multi-author notebook) |
| hf-rlhf | 2 | 2 | 2 | 2 | 1 | 2 | 1 | PASS | ⬆ MAJOR→PASS | The 2 broken related-post cards are gone; file now ends on an orphaned, unformatted "More Articles from our Blog" text fragment with nothing beneath it |
| hillelwayne-engineers | 2 | 1 | 2 | 2 | 2 | 2 | 2 | PASS | = | Byline still ambiguous (site-header name, not explicit "by") |
| huyenchip-llm-eng | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | = | Unchanged, clean |
| interconnects-o1 | 2 | 2 | 2 | 1 | 2 | 1 | 0 | MAJOR | = | Still opens with "Article voiceover / 0:00 / -12:12" audio-widget text; 8 broken related-post/image cards persist; a stray isolated footnote marker `[1](url)` now floats as its own line near the end |
| jalammar-transformer | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ | Dup title fixed |
| jaykmody-gpt | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ MAJOR→PASS | **Browser-confirmed**: footnote 5's softmax equation now renders as a proper KaTeX display equation — no more raw LaTeX text |
| joelonsoftware-test | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ MINOR→PASS | Byline "Joel Spolsky" now correctly populated; the "2000December 5, 2016" date-run-together text no longer found |
| joshwcomeau-rerender | 2 | 2 | 0 | 1 | 0 | 1 | 0 | MAJOR | = | `publishedAt` still null; every heading still literally prefixed `[Link to this heading](url)`; tail still ends on "### Last updated on / December 3rd, 2025 / ### # of hits" analytics-widget-as-headings |
| jvns-firecracker | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ | All 13 headings' full link-wrap FIXED |
| jxnl-rag | 2 | 2 | 2 | 1 | 2 | 2 | 2 | PASS | ⬆ | Dup title fixed (file now has exactly 1 H1); still opens with 2 empty GitHub edit-icon links |
| karpathy-recipe | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | = | Unchanged, clean |
| karpathy-rnn | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | = | Clean; an automated dup-title flag on "Recurrent Neural Networks" was a false positive (legitimate distinct H2, substring of the title) |
| karpathy-software2 | 2 | 2 | 0 | 0 | 2 | 2 | 0 | MAJOR | = | `publishedAt` still "2021-03-13" vs. page's "Nov 11, 2017"; still opens with broken Medium avatar-card |
| kentcdodds-context | 2 | 1 | 0 | 1 | 2 | 2 | 1 | MINOR | = | Byline/date still null; still opens with a translation-links list |
| latentspace-ai-engineer | 2 | 1 | 2 | 1 | 2 | 2 | 0 | MAJOR | = | Byline still the publication name, not a person; 7 broken card-link occurrences persist |
| lesswrong-lethalities | 2 | 2 | 0 | 2 | 2 | 2 | 2 | PASS | = | Date still null (page shows a specific date; scored leniently per the original review's own precedent) |
| lilian-agent | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ | Tail no longer ends on empty share-button links — now ends cleanly on a real tag list |
| lilian-attention | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ | **Browser-confirmed**: trailing blue "#" on headings FIXED — "Transformer", "Key, Value and Query" render clean bold black |
| matklad-architecture | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ | Dup title fixed |
| medium-backprop | 2 | 2 | 2 | 0 | 2 | 2 | 0 | MAJOR | ⬆(partial) | Tail now ends cleanly on real content (was polluted before); still opens with broken Medium avatar-card |
| mitchellh-large | 2 | 0 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ MAJOR→PASS | Triple-heading redundancy fully fixed — headings list is now just the 6 real sections; footnotes render cleanly with proper return-links; only byline still null despite the page showing the author's name beside the title |
| mtlynch-google | 2 | 2 | 2 | 2 | 0 | 1 | 1 | MINOR | ⬇ **PASS→MINOR** | 🔗︎ emoji-on-every-heading FIXED, but article now ends on an empty "Discuss on" heading + a full "Read My Book" self-promo section, both leaking into the headings list — see §2 |
| nullprogram-sm | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ | Redundant heading-link duplicate right after the title FIXED; `source.txt` still empty |
| oneusefulthing-centaurs | 2 | 2 | 2 | 2 | 1 | 1 | 0 | MAJOR | =(mixed) | Title now FULLY CORRECT ("Centaurs and Cyborgs on the Jagged Frontier"); but broken image/related-post cards are now worse — 7 occurrences vs. 1 before |
| openai-4o | 2 | 0 | 0 | 2 | 2 | 2 | 1 | MAJOR | = | Byline and `publishedAt` both still null despite "May 13, 2024" being literal visible body text right under the title |
| overreacted-useeffect | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ | Dup title fixed; heading-link-wrap fixed (previously rendered fine anyway, now the markdown itself is clean) |
| paulgraham-greatwork | 2 | 2 | 1 | 2 | 2 | 2 | 0 | MAJOR | =(different cause) | **`paragraphs` now 292 (was 1) — confirmed live, proper paragraph spacing throughout.** But ~29 footnote markers now render as isolated, disconnected one-line `[N]` paragraphs instead of inline superscripts (confirmed on screen) — new Ef=0 defect replaces the old one |
| pragmaticengineer-product | 2 | 2 | 2 | 2 | 1 | 1 | 2 | PASS | ⬆ MINOR→PASS | Dup title fixed; still ends on the "Annual conference talk" + "Gergely Orosz" bio-card section kept as body |
| pytorch-genai2 | 2 | 2 | 0 | 2 | 2 | 2 | 2 | PASS | = | Date still null (page: "November 30, 2023"); empty-link heading prefix on 11 headings now fixed |
| quanta-understand | 2 | 2 | 2 | 0 | 0 | 0 | 0 | MAJOR | = | Still worst-scoring doc: opens with broken `\[Comment\]\(<url>)`; still ends on a newsletter-signup widget + broken share-icon cards; broken-card count down from 36 to 12 but still severe |
| raschka-selfattention | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ | Empty-link prefix on 8 headings FIXED |
| raschka-understanding-llms | 2 | 2 | 2 | 2 | 2 | 2 | 0 | MAJOR | = | 20 broken embedded-image-card occurrences persist exactly as before |
| regehr-ub | 2 | 2 | 2 | 2 | 2 | 1 | 2 | PASS | = | Heading hierarchy still flattened — all section headings now emit as literal H2 (was H1 before), same single-level defect, different level |
| ruanyifeng-curl | 2 | 2 | 2 | 2 | 2 | 2 | 1 | PASS | ⬆ MINOR→PASS | **Browser-confirmed**: byline "阮一峰" and date "2019/9/5" both now correct in the reader's own header; code blocks still wrapped in a redundant blockquote left-bar (cosmetic, unchanged) |
| ruanyifeng-weekly | 2 | 2 | 2 | 2 | 2 | 2 | 1 | PASS | ⬆ MINOR→PASS | Byline and date both now correct (2024-01-19 matches page exactly) |
| ruder-optim | 2 | 2 | 2 | 1 | 2 | 2 | 1 | PASS | ⬆ MAJOR→PASS | "Nesterov accelerated gradient" H1-instead-of-H2 bug FIXED (now correctly H2); the NAG display equation now uses `\\(...\\)` wrapping a full `\begin{align}` block rather than being flanked by stray literal `\(`/`\)` text — not independently re-verified on screen, flagged for a follow-up render check |
| rustblog-1.0 | 2 | 2 | 2 | 2 | 2 | 2 | 1 | PASS | ⬆ | Byline "The Rust Core Team" now correctly populated |
| samaltman-ia | 2 | 2 | 0 | 2 | 2 | 2 | 1 | PASS | = | Date still null; dup title also now fixed |
| simonw-llms-2024 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ | Dup title fixed |
| simonw-wordcamp | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | = | Unchanged, clean |
| sivers-ff | 2 | 2 | 2 | 2 | 2 | 2 | 2 | PASS | ⬆ | Dup title fixed |
| stratechery-endbeginning | 2 | 0 | 2 | 2 | 0 | 0 | 1 | MAJOR | = | Byline still null despite the page always showing "By Ben Thompson"; still ends on an unrelated site's promoted-articles widget (now "Sharp Text" instead of "Ben Thompson" content — same bug, different source snapshot) |
| vickiboykis-gguf | 2 | 1 | 2 | 2 | 2 | 2 | 2 | PASS | = | Byline still ambiguous (stylized site-name-as-logo) |
| waitbutwhy-ai | 2 | 2 | 2 | 2 | 2 | 2 | 1 | PASS | = | Unchanged, clean |
| webdev-vitals | 2 | 0 | 1 | 1 | 2 | 2 | 1 | MINOR | ⬆ MAJOR→MINOR | Title bug FULLY FIXED (clean "Web Vitals", no more UI-tooltip text); byline still null despite "Philip Walton" visible in body; 5 empty social-icon links remain (down from 6) |

---

## 4. Ranked remaining issues (frequency × severity)

| # | Issue | Frequency | Severity | Layer |
|---|---|---|---|---|
| 1 | **Broken `\[...]\(<url>)` card-link markdown** for avatar/image/related-post cards. | 9 docs unchanged (`acx-sleeper`, `interconnects-o1`, `karpathy-software2`, `latentspace-ai-engineer`, `medium-backprop`, `oneusefulthing-centaurs` (worse), `quanta-understand`, `raschka-understanding-llms`, `fasterthanlime-golang` — new heading-wrap manifestation) + 1 new doc (`paulgraham-greatwork`, footnote-refs). | High — this is now the single largest driver of the remaining MAJOR docs; it has also spread from cards to headings and footnote references. | Markdown conversion (the "linked card" DOM shape → `\[`/`]\(<url>)` serialization bug is unfixed and has widened in scope). |
| 2 | **Trailing / leading site-chrome kept as body** (related-post widgets, author-bio cards, self-promo sections). | 5 docs: `quanta-understand`, `stratechery-endbeginning`, `pragmaticengineer-product`, `mtlynch-google` (new), `codinghorror-nocode` (head only), `hf-rlhf` (residual one-line stub). | High for `quanta-understand`/`stratechery-endbeginning` (full widgets, drive their MAJOR verdict); Medium for the others. | Chrome-pruning / candidate-selection end-boundary detection — still doesn't reliably find the true end of the article on Ghost/Substack/WordPress "author bio + related posts" footers. |
| 3 | **Missing byline despite an explicit on-page byline.** | 4 confirmed: `openai-4o`, `webdev-vitals`, `mitchellh-large`, `stratechery-endbeginning`. | Medium. | Metadata extraction — down from 8, but the remaining 4 are a stable, unmoved residue across two review rounds. |
| 4 | **Footnote-reference markers rendered as isolated one-line paragraphs** instead of inline superscripts. | 2 confirmed on screen (`paulgraham-greatwork`, ~29 instances; `interconnects-o1`, 1 instance) — likely more, given the shared `\[N\]\(url)` → isolated-`[N]` pattern; not exhaustively swept across all 64. | High where frequent (`paulgraham-greatwork` — breaks the reading flow of a heavily-footnoted, otherwise-fixed essay). | Footnote rendering pipeline (same family as issue #1 — footnote refs go through the same broken serialization path as image/avatar cards). |
| 5 | **Missing/wrong `publishedAt`.** | 10 docs still null or wrong: `anthropic-mapping`, `joshwcomeau-rerender`, `karpathy-software2` (wrong, not just null), `kentcdodds-context`, `lesswrong-lethalities`, `pytorch-genai2`, `samaltman-ia`, plus `openai-4o` (paired with missing byline). | Medium — mostly "defensible null" cases where the page shows a date the extractor doesn't pick up, one confirmed wrong-value case (`karpathy-software2`: wrong year *and* month). | Metadata extraction (date parser still doesn't handle every date-display convention; CJK case is fully fixed, these are non-CJK misses). |
| 6 | **Fake/orphan headings from unstripped byline or nav chrome.** | 3 residual: `codinghorror-nocode` (top `#### Jeff Atwood`), `jxnl-rag` (2 empty GitHub edit-icon links), `anthropic-mapping` (dangling empty `## Policy Memo`). | Low–Medium (mostly cosmetic pollution of the heading/TOC list; `anthropic-mapping`'s is a genuine content-completeness cut). | Chrome pruning (byline-card and nav-icon elements not fully recognized as non-content). |
| 7 | **`codeBlocks` count claimed by `summary.json` doesn't match reality.** | 1 confirmed unchanged: `fasterthanlime-golang` (`codeBlocks: 70`, zero ` ``` ` fences in the file). | High for this doc (its largest code sample is still a single collapsed inline-code span). | Extractor's code-fence serializer for a specific source DOM shape. |
| 8 | **`joshwcomeau-rerender`'s "Link to this heading" text glued onto every heading.** | 1 doc, 8 occurrences, unchanged. | Medium (cosmetic but very visible — every single heading in the doc is affected). | Markdown conversion / heading-permalink stripping (this is the one surviving member of what used to be a 38%-frequency bug family). |
| 9 | **Flattened heading hierarchy** (all sections emit at one heading level). | 1 confirmed unchanged: `regehr-ub` (now H2-only, was H1-only before — same defect, different level). | Low. | Source→heading-level mapping. |
| 10 | **Missing corpus entries.** | 2/66: `bair-koala`, `coolshell-rust` — unchanged. | High (100% content loss) but out of scope of the extractor fix that produced everything else in this round. | Crawl/extractor pipeline, upstream of the markdown converter. |

---

## 5. Browser spot-check (5 required docs)

- **paulgraham-greatwork** (paragraphs): Opened at `/`. Paragraphs render with correct spacing throughout — confirmed the "292 paragraphs" fix visually, not just from `summary.json`. New defect confirmed: footnote marker `[1]` renders as its own isolated one-line paragraph, disconnected from "...and that offers scope to do great work." — this pattern repeats at every footnote reference. Title, "July 2023" dateline, and body text all render cleanly.
- **jaykmody-gpt** (footnote 5 math): Scrolled to the end-of-article footnotes/notes section. Footnote 5's softmax equation renders as a properly typeset KaTeX display block: `softmax(x)ᵢ = eˣⁱ / Σⱼeˣʲ`. No raw LaTeX text visible anywhere. This is a full fix of the review's single most concrete previous finding.
- **lilian-attention** (heading anchors): "Transformer" and "Key, Value and Query" headings both render clean, bold, black — no trailing blue "#" glued to the text (previously confirmed broken on screen). Inline math (`(K, V)`, `Q`, dimension variables) renders correctly via KaTeX alongside the fixed headings.
- **githubblog-copilotx** (end of article): Scrolled to 100% progress. Article ends cleanly on "GitHub Copilot X is on the horizon...So—let's build from here." No author bio card, no "Explore more from GitHub" promo cards — the entire trailing chrome block from the previous review is gone.
- **ruanyifeng-curl** (date/byline in header, code blocks): Reader's own header chrome now reads "阮一峰 · 2019/9/5 · 2 min" — both the byline and the corrected date render live, exactly matching the article's own Chinese-language date text. Code blocks still show a thin blue vertical bar on their left edge (the source's fenced-block-inside-blockquote nesting from the previous review), unchanged — a minor, purely cosmetic redundancy, not a functional break.

No image-related findings reported (remote images are blocked by CSP in this preview, as expected, and consistently rendered as "Image unavailable / Retry remote image" placeholders across all 5 docs — not counted as a defect).
