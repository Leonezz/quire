# Extraction quality judge — 2026-10-08

66 cases: 50 PASS · 7 MINOR · 9 MAJOR · 0 error. This run judged 66 (63 fresh, 3 cached). Judge: policy screen-then-confirm · screen claude/claude-sonnet-5 · confirm codex/gpt-6-luna (on MINOR, MAJOR); mode visual; rubric 2026-10-09.5. 13 case(s) had an input cut to fit the prompt. 17 evidence quote(s) could not be found verbatim in the inputs.

Opinions: claude/claude-sonnet-5 66 opinions, 5,780,916 tokens, $21.66 · codex/gpt-6-luna 16 opinions, 962,939 tokens. Escalated 16 of 66 screened. Disputed 7.

Rendering facts over 66 captured cases: 17 broken images (2 cases) · 0 overflowing elements · 1 raw-markup samples (1 case) · 1 math errors (1 case).

## Issues by kind

| kind | cases | issues | major |
|---|---:|---:|---:|
| layout | 19 | 24 | 2 |
| images | 15 | 19 | 14 |
| missing_content | 14 | 23 | 10 |
| metadata | 12 | 12 | 2 |
| code_or_math | 7 | 10 | 6 |
| tables | 4 | 5 | 4 |
| extra_content | 3 | 3 | 0 |
| other | 2 | 2 | 1 |

## Cases

`kind!` marks a major issue. `broken`, `overflow`, `raw` and `math` are the render capture's measured facts (broken images, elements wider than the column, markup shown as text, formulas that failed to render); `–` means the case was judged without a capture. `decided by` is the backend whose opinion became the verdict; `(disputed)` means the other backend's verdict differed. Evidence quotes live in `eval/judge/out/<slug>.json` and screenshots in `eval/render/out/<slug>/` (neither committed).

| slug | verdict | kinds | broken | overflow | raw | math | summary | decided by | origin |
|---|---|---|---:|---:|---:|---:|---|---|---|
| acoup-gondor1 | PASS | layout | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the article: correct title, byline, and date; body starts and ends at the right points, excluding the… | claude/claude-sonnet-5 | fresh |
| acx-sleeper | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full article from the opening paragraph through the Hubinger job-ad link, preserving section mark… | claude/claude-sonnet-5 | fresh |
| anthropic-mapping | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full Anthropic article from the opening paragraph through the "Policy Memo" link, correctly exclu… | claude/claude-sonnet-5 | fresh |
| arxiv-2609-24983 | PASS | metadata | 0 | 0 | 0 | 0 | A faithful, well-ordered extraction of this long arXiv HTML paper: title, abstract, all numbered sections, figures, tables, equations, refe… | claude/claude-sonnet-5 | fresh |
| brendangregg-cpu | PASS | code_or_math | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the article: correct title/date, no byline (matching the source), clean start and end boundaries, all… | claude/claude-sonnet-5 | fresh |
| ciechanowski-gps | PASS | metadata, tables, code_or_math | 0 | 0 | 0 | 0 | The reader faithfully reproduces this very long GPS article: correct byline/date, body starts and (as far as visible) proceeds in order thr… | claude/claude-sonnet-5 | fresh |
| cloudflare-pingora | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the Pingora article: title, byline, and date match, the body starts at the Introduction and ends at t… | claude/claude-sonnet-5 | fresh |
| codinghorror-nocode | PASS | extra_content | 0 | 0 | 0 | 0 | The reader faithfully reproduces this short Coding Horror post: correct title/byline/date, body starts at the real first paragraph and ends… | claude/claude-sonnet-5 | fresh |
| colah-lstm | PASS | layout | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the entire article in correct order with accurate title, date, and no byline (matching the source), a… | claude/claude-sonnet-5 | fresh |
| csstricks-flexbox | PASS | missing_content | 0 | 0 | 0 | 0 | The reader page renders this long flexbox guide cleanly — all code blocks, 14 figures, headings and lists come through intact with no broke… | claude/claude-sonnet-5 | fresh |
| danluu-files | PASS | layout | 0 | 0 | 0 | 0 | The reader page faithfully reproduces this long technical talk transcript: title, absent byline/date, all 11 code blocks, all headings, blo… | claude/claude-sonnet-5 | fresh |
| distill-featurevis | MAJOR | missing_content!, images! | 0 | 0 | 0 | 0 | Title, byline, date, opening, and article order are correct, and the visible prose is readable. However, many source figures are absent fro… | codex/gpt-6-luna | fresh |
| eugeneyan-llm-patterns | PASS | code_or_math | 0 | 0 | 0 | 1 | The reader page faithfully reproduces title, byline, date, and the full article body in correct order with intact lists, headings, and imag… | claude/claude-sonnet-5 | fresh |
| fasterthanlime-golang | MAJOR | layout!, images! | 16 | 0 | 0 | 0 | Metadata and the article text are largely preserved, but the reader loses the section headings and shows failed image placeholders. The bro… | codex/gpt-6-luna (disputed) | fresh |
| githubblog-copilotx | MINOR | images | 0 | 0 | 0 | 0 | The article text, metadata, ordering, and ending are preserved, and the reader renders the three actual images cleanly. The embedded demo v… | codex/gpt-6-luna (disputed) | fresh |
| godev-pipelines | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full "Pipelines and cancellation" article: correct title, byline, and date, body starting at the … | claude/claude-sonnet-5 | fresh |
| gradient-icl | PASS | – | 0 | 0 | 0 | 0 | The reader page is a clean, complete reproduction of the article: correct title, byline, and date; body starts at the first paragraph and e… | claude/claude-sonnet-5 | fresh |
| gwern-scaling | MINOR | layout | 0 | 0 | 0 | 0 | Title, author, date, and the extracted article opening are correct. The visible article content and figures read cleanly; the only observed… | codex/gpt-6-luna | fresh |
| hamel-evals | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full article in correct order, with intact code blocks, the table, lists, footnotes, headings, an… | claude/claude-sonnet-5 | fresh |
| harvard-annotated-transformer | PASS | missing_content, layout | 0 | 0 | 1 | 0 | The reader page reproduces the full Annotated Transformer notebook faithfully — title, headings, 56 code blocks, formulas, and blockquoted … | claude/claude-sonnet-5 | fresh |
| hf-rlhf | MAJOR | missing_content!, images!, code_or_math! | 0 | 0 | 0 | 0 | The title, author list, date, and main article sections through the lecture link are present. However, the extracted article omits the subs… | codex/gpt-6-luna | fresh |
| hillelwayne-engineers | PASS | layout | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full article in correct order with accurate title and date, clean headings/lists, a working image… | claude/claude-sonnet-5 | fresh |
| huyenchip-llm-eng | PASS | missing_content | 0 | 0 | 0 | 0 | The reader page is a clean, complete reproduction of the article: correct title/byline/date, body starts and ends at the right points, all … | claude/claude-sonnet-5 | fresh |
| interconnects-o1 | PASS | missing_content | 0 | 0 | 0 | 0 | The reader page faithfully reproduces title, byline, date, and the full article body in order, including all 5 figures and 3 lists, ending … | claude/claude-sonnet-5 | fresh |
| jalammar-transformer | PASS | missing_content | 0 | 0 | 0 | 0 | The reader faithfully reproduces the full technical body of the Illustrated Transformer post—all 15 headings, 37 images, the one table, and… | claude/claude-sonnet-5 | fresh |
| jaykmody-gpt | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces this long technical article: title, date, and body text match the source exactly from the first parag… | claude/claude-sonnet-5 | fresh |
| joelonsoftware-test | PASS | layout | 0 | 0 | 0 | 0 | The reader page faithfully preserves the full article from the intro through all 12 Joel Test sections to the closing paragraph, correctly … | claude/claude-sonnet-5 | fresh |
| joshwcomeau-rerender | MINOR | metadata, layout | 0 | 0 | 0 | 0 | The article is largely complete and readable, with its title and byline correct and code blocks preserved. The publication date is missing,… | codex/gpt-6-luna | fresh |
| jvns-firecracker | PASS | missing_content, metadata | 0 | 0 | 0 | 0 | The reader faithfully reproduces the article's title, byline, screenshot, all code blocks, and lists with correct structure and no renderin… | claude/claude-sonnet-5 | fresh |
| jxnl-rag | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full article in correct order, with accurate title, byline, and date, and properly stops before t… | claude/claude-sonnet-5 | fresh |
| karpathy-recipe | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces Karpathy's "A Recipe for Training Neural Networks": correct title, no byline (matching the source), c… | claude/claude-sonnet-5 | cached |
| karpathy-rnn | MINOR | metadata, layout, code_or_math! | 0 | 0 | 0 | 0 | The reader keeps the article’s title, date, sequence, and substantial content, and the visible figures and code are generally readable. The… | codex/gpt-6-luna (disputed) | fresh |
| karpathy-software2 | MAJOR | images!, layout | 0 | 0 | 0 | 0 | The reader has the correct title, byline, date, and article text in order through the ending. The extraction omits the article's figures an… | codex/gpt-6-luna | fresh |
| kentcdodds-context | MINOR | metadata, images! | 0 | 0 | 0 | 0 | The article body is otherwise complete and in order, with its code and closing section preserved. Metadata omits the visible author and dat… | codex/gpt-6-luna | fresh |
| latentspace-ai-engineer | PASS | layout | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the article's title, byline, date, full body text, all 9 figures, 3 lists, headings and blockquotes i… | claude/claude-sonnet-5 | fresh |
| lesswrong-lethalities | MINOR | metadata | 0 | 0 | 0 | 0 | The extracted article appears complete and in order through the ending shown, and the visible reader layout is clean. Title and author are … | codex/gpt-6-luna | fresh |
| lilian-agent | PASS | missing_content, other | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full article with correct title, byline, date, intact figures, code blocks, lists and math, and s… | claude/claude-sonnet-5 | fresh |
| lilian-attention | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces this long, formula- and image-heavy article: title, byline and date are correct, the body starts at t… | claude/claude-sonnet-5 | cached |
| matklad-architecture | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the short matklad blog post: title, date, and full body text match the source in correct order, with … | claude/claude-sonnet-5 | fresh |
| medium-backprop | MAJOR | images!, code_or_math! | 0 | 0 | 0 | 0 | The extractor preserves the article’s text, metadata, section order, and ending. However, all article figures are absent and the code examp… | codex/gpt-6-luna | fresh |
| mitchellh-large | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full article in order, with correct title, date, and no byline (matching the source), proper list… | claude/claude-sonnet-5 | fresh |
| mtlynch-google | PASS | images | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the article's title, byline, date, full text in order, lists, blockquote formatting, and ends cleanly… | claude/claude-sonnet-5 | fresh |
| nullprogram-sm | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full article — all five sections, all seven code blocks, the ordered list, and all three diagram … | claude/claude-sonnet-5 | fresh |
| oneusefulthing-centaurs | PASS | layout | 0 | 0 | 0 | 0 | The reader page faithfully reproduces title, byline, date, full body text in order, and all 7 figures with no broken images, overflow, or r… | claude/claude-sonnet-5 | fresh |
| openai-4o | MAJOR | metadata!, images!, tables!, layout! | 0 | 0 | 0 | 0 | The article text is mostly complete and in order, with the correct title and no byline shown. However, the reader omits the demo images and… | codex/gpt-6-luna (disputed) | fresh |
| openai-4o-zh | MAJOR | metadata, images!, layout, tables! | 0 | 0 | 0 | 0 | The reader preserves the main article text and section order, and its risk table and article text remain readable. However, the three promi… | codex/gpt-6-luna (disputed) | fresh |
| overreacted-useeffect | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces this long useEffect guide: title, date, and absent byline are all correct, the body starts with the r… | claude/claude-sonnet-5 | fresh |
| paulgraham-greatwork | PASS | – | 0 | 0 | 0 | 0 | The reader page cleanly reproduces Paul Graham's essay: correct title, no byline (matching the source), the in-body "July 2023" date preser… | claude/claude-sonnet-5 | fresh |
| pragmaticengineer-product | PASS | extra_content | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full 9-trait article plus the tips list in correct order, with accurate title/byline/date, intact… | claude/claude-sonnet-5 | fresh |
| pytorch-genai2 | MINOR | metadata, images!, other! | 1 | 0 | 0 | 0 | The article is extracted in order through the acknowledgements, and the visible figures and code appear readable. The publication date is m… | codex/gpt-6-luna | fresh |
| quanta-understand | PASS | images | 0 | 0 | 0 | 0 | The reader faithfully reproduces the full article in correct order with accurate title, byline and date, correctly stripping sidebar widget… | claude/claude-sonnet-5 | fresh |
| raschka-selfattention | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full article: correct title, author and date, body starts at the first real paragraph and ends at… | claude/claude-sonnet-5 | fresh |
| raschka-understanding-llms | PASS | layout | 0 | 0 | 0 | 0 | The reader page faithfully reproduces Sebastian Raschka's reading-list article: correct title, byline and date, clean start at the first pa… | claude/claude-sonnet-5 | fresh |
| regehr-ub | MAJOR | metadata!, missing_content!, code_or_math!, layout | 0 | 0 | 0 | 0 | The reader displays the captured portions cleanly overall, but the extracted article has the wrong title, skips a section heading and the a… | codex/gpt-6-luna (disputed) | fresh |
| ruanyifeng-curl | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full curl reference article in the correct order, with correct title, byline, and date, starting … | claude/claude-sonnet-5 | fresh |
| ruanyifeng-weekly | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full weekly issue from the opening paragraph through "（完）", preserving all section headings, the … | claude/claude-sonnet-5 | fresh |
| ruder-optim | PASS | missing_content, images | 0 | 0 | 0 | 0 | The reader page is a faithful, well-rendered reproduction of this long article: title, byline, date, code blocks, footnotes, the formula-he… | claude/claude-sonnet-5 | fresh |
| rustblog-1.0 | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full "Announcing Rust 1.0" article, including the title, byline, date, all body sections in order… | claude/claude-sonnet-5 | fresh |
| samaltman-ia | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces Sam Altman's essay: title, cover image, and all body paragraphs appear in full and in order, with a c… | claude/claude-sonnet-5 | fresh |
| simonw-llms-2024 | PASS | images | 0 | 0 | 0 | 0 | The reader page reproduces the full 20-section article accurately with correct title, byline and date, clean start/end boundaries, intact c… | claude/claude-sonnet-5 | fresh |
| simonw-wordcamp | PASS | missing_content | 0 | 0 | 0 | 0 | The reader page faithfully reproduces this long, image-heavy talk transcript: title, byline and date are correct, the body starts and proce… | claude/claude-sonnet-5 | fresh |
| sivers-ff | PASS | – | 0 | 0 | 0 | 0 | The reader page cleanly reproduces the full article — title, byline, date, intro note, and all body paragraphs in order — while correctly e… | claude/claude-sonnet-5 | fresh |
| stratechery-endbeginning | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the article: correct title and date, no spurious byline, body starts at the first paragraph and ends … | claude/claude-sonnet-5 | fresh |
| vickiboykis-gguf | PASS | missing_content, layout | 0 | 0 | 0 | 0 | The reader page reproduces the article's title, date, long body, code blocks, math, images and lists faithfully and in order, ending cleanl… | claude/claude-sonnet-5 | fresh |
| waitbutwhy-ai | PASS | extra_content | 0 | 0 | 0 | 0 | The reader page faithfully reproduces Tim Urban's full article—title, byline, date, all sections, images, lists and footnotes are present, … | claude/claude-sonnet-5 | fresh |
| webdev-vitals | MAJOR | metadata, tables!, missing_content!, images!, layout | 0 | 0 | 0 | 0 | The reader is clean and readable overall, with the article title, date, prose, code sample, and lifecycle figure presented clearly. However… | codex/gpt-6-luna (disputed) | cached |
