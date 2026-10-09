# Extraction quality judge — 2026-10-09

66 cases: 18 PASS · 19 MINOR · 29 MAJOR · 0 error. This run judged 66 (0 fresh, 0 cached, 66 rescored without a model call). Judge: policy screen-then-confirm · screen claude/claude-sonnet-5 · confirm codex/gpt-6-luna (on MINOR, MAJOR); mode visual; rubric 2026-10-10.12. 13 case(s) had an input cut to fit the prompt. 12 evidence quote(s) could not be found verbatim in the inputs.

Per layer: content 25 PASS · 15 MINOR · 26 MAJOR; metadata 44 PASS · 22 MINOR · 0 MAJOR; rendering 52 PASS · 9 MINOR · 5 MAJOR.

Cross-confirmed issues: 72 reported by both, 33 one-sided major kept by a fact, 34 one-sided major downgraded to minor, 45 one-sided minor.

Invalid issues (kept in out/, never counted): 38 — evidence-not-verbatim 12, outside-boundary 22, contradicts-image-facts 4.

Opinions: claude/claude-sonnet-5 66 opinions, 5,880,378 tokens, $22.15 · codex/gpt-6-luna 48 opinions, 2,617,867 tokens. Escalated 48 of 66 screened. Disputed 14.

Rendering facts over 66 captured cases: 17 broken images (2 cases) · 0 overflowing elements · 1 raw-markup samples (1 case) · 1 math errors (1 case).

## Issues by layer and kind

Valid issues only; issues from results judged before rubric v6 carry no layer and are not counted here.

| layer | kind | cases | issues | major |
|---|---|---:|---:|---:|
| content | missing_content | 30 | 56 | 23 |
| metadata | metadata | 22 | 23 | 0 |
| content | images | 15 | 37 | 35 |
| content | extra_content | 9 | 15 | 0 |
| rendering | layout | 8 | 9 | 0 |
| content | layout | 7 | 9 | 2 |
| rendering | code_or_math | 5 | 7 | 5 |
| content | tables | 3 | 4 | 3 |
| content | other | 2 | 19 | 19 |
| rendering | images | 2 | 3 | 3 |
| rendering | extra_content | 1 | 1 | 0 |
| rendering | tables | 1 | 1 | 0 |

## Cases

`content`, `metadata` and `rendering` are the layer verdicts; the verdict is the worst of them (`–`: the layer was not judged, as rendering in text mode, or the result predates rubric v6). `kind!` marks a major issue; kinds are those of the valid issues, `(+n invalid)` counts the ones the program discarded. `broken`, `overflow`, `raw` and `math` are the render capture's measured facts (broken images, elements wider than the column, markup shown as text, formulas that failed to render); `–` means the case was judged without a capture. `decided by` is the backend whose opinion became the verdict, or `merged` when two opinions were cross-confirmed into one issue list; `(disputed)` means the two opinions' own verdicts differed. Evidence quotes live in `eval/judge/out/<slug>.json` and screenshots in `eval/render/out/<slug>/` (neither committed).

| slug | verdict | content | metadata | rendering | kinds | broken | overflow | raw | math | summary | decided by | origin |
|---|---|---|---|---|---|---:|---:|---:|---:|---|---|---|
| acoup-gondor1 | MAJOR | MAJOR | PASS | MINOR | missing_content!, layout (+1 invalid) | 0 | 0 | 0 | 0 | The article text and metadata are preserved, and the visible figures render correctly. One original article image is missing, and the reade… | merged claude+codex (disputed) | rescored |
| acx-sleeper | MINOR | MINOR | PASS | PASS | missing_content | 0 | 0 | 0 | 0 | The reader page preserves the article text and all seven figures in order. The title, author, date, and visible layout are correct, with no… | merged claude+codex (disputed) | rescored |
| anthropic-mapping | MAJOR | MAJOR | MINOR | PASS | missing_content, metadata, images! (+1 invalid) | 0 | 0 | 0 | 0 | The reader presents the article text and its four included figures clearly, but omits the original lead image and the policy memo link. The… | merged claude+codex | rescored |
| arxiv-2609-24983 | MINOR | MINOR | MINOR | PASS | metadata, tables (+1 invalid) | 0 | 0 | 0 | 0 | The reader preserves the article’s main text, headings, figures, lists, and visible tables. The author metadata is missing, and the F1 equa… | merged claude+codex (disputed) | rescored |
| brendangregg-cpu | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full article in correct order, including both figures, both code blocks (rendered cleanly despite… | claude/claude-sonnet-5 | rescored |
| ciechanowski-gps | MAJOR | MAJOR | MINOR | PASS | tables!, metadata | 0 | 0 | 0 | 0 | The visible reader text is in order and the metadata matches the article. Table t1 has empty cells, which makes its structured content inco… | merged claude+codex | rescored |
| cloudflare-pingora | MAJOR | MAJOR | PASS | PASS | images! (+2 invalid) | 0 | 0 | 0 | 0 | The article text, metadata, list, and two matched figures are presented clearly. However, three original images and an article embed are mi… | merged claude+codex (disputed) | rescored |
| codinghorror-nocode | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader faithfully reproduces the full article — all paragraphs, both blockquotes, the bulleted list, the code example, and the mirror p… | claude/claude-sonnet-5 | rescored |
| colah-lstm | MINOR | MINOR | MINOR | PASS | metadata, layout (+4 invalid) | 0 | 0 | 0 | 0 | The reader preserves the article text, ordering, date, and most figures. Four original instructional diagrams are absent, and the author by… | merged claude+codex | rescored |
| csstricks-flexbox | MAJOR | MAJOR | PASS | PASS | missing_content!, other! | 0 | 0 | 0 | 0 | The visible opening sections read cleanly and the metadata is correct. However, the extraction omits the article tail and its interactive e… | merged claude+codex | rescored |
| danluu-files | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader faithfully reproduces this long technical post: all sections, blockquotes, numbered list, and all 11 code blocks (including the … | claude/claude-sonnet-5 | rescored |
| distill-featurevis | MAJOR | MAJOR | PASS | MINOR | images!, missing_content, layout!, layout (+2 invalid) | 0 | 0 | 0 | 0 | The reader displays the extracted text and matched images cleanly, but omits multiple original images and interactive figures, and the extr… | merged claude+codex | rescored |
| eugeneyan-llm-patterns | MAJOR | MINOR | PASS | MAJOR | code_or_math!, extra_content | 0 | 0 | 0 | 1 | The reader preserves the article’s visible text and images, but one formula is visibly unrendered as raw LaTeX. The remaining displayed con… | merged claude+codex | rescored |
| fasterthanlime-golang | MAJOR | MINOR | PASS | MAJOR | extra_content, images!, missing_content, layout (+1 invalid) | 16 | 0 | 0 | 0 | The reader preserves the article’s text and code formatting, but the extracted body omits section headings and both original docs.rs images… | merged claude+codex | rescored |
| githubblog-copilotx | MINOR | MINOR | PASS | PASS | missing_content, extra_content (+2 invalid) | 0 | 0 | 0 | 0 | The reader preserves the article text, all four videos, and the matched figures, but omits the original announcement hero image. | merged claude+codex (disputed) | rescored |
| godev-pipelines | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader page reproduces the full article faithfully: all sections from Introduction through Conclusion and Further reading appear in the… | claude/claude-sonnet-5 | rescored |
| gradient-icl | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the article: all body paragraphs, blockquotes, formulas, the two lists, and all nine figures with the… | claude/claude-sonnet-5 | rescored |
| gwern-scaling | MINOR | MINOR | PASS | PASS | missing_content, layout | 0 | 0 | 0 | 0 | The reader preserves the visible article content and its images in order. The displayed title and metadata look correct, and no measured re… | merged claude+codex (disputed) | rescored |
| hamel-evals | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the article: content is complete and in correct order (Motivation through Conclusion and Footnotes), … | claude/claude-sonnet-5 | rescored |
| harvard-annotated-transformer | MAJOR | MAJOR | MINOR | MAJOR | images!, metadata, code_or_math! (+1 invalid) | 0 | 0 | 1 | 0 | The article text and code are largely preserved, but the reader omits five original figures and displays the attention equation as raw LaTe… | merged claude+codex | rescored |
| hf-rlhf | MAJOR | MAJOR | PASS | PASS | missing_content! (+2 invalid) | 0 | 0 | 0 | 0 | The reader displays the captured article text and four matched figures, but the extraction ends before the Further reading, citation, and a… | merged claude+codex | rescored |
| hillelwayne-engineers | MINOR | PASS | MINOR | MINOR | metadata, layout (+1 invalid) | 0 | 0 | 0 | 0 | The reader preserves the article text and displays the matched chart, but omits the author metadata and loses the numbered-list markers. | merged claude+codex | rescored |
| huyenchip-llm-eng | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full article from the title through the "What's your strategy?" conclusion, correctly dropping th… | claude/claude-sonnet-5 | rescored |
| interconnects-o1 | MAJOR | MAJOR | PASS | PASS | other!, images!, layout | 0 | 0 | 0 | 0 | Most article text, lists, and figures are preserved and readable. The related-story image and the article’s audio embed are missing. | merged claude+codex | rescored |
| jalammar-transformer | MAJOR | MAJOR | PASS | PASS | missing_content! (+1 invalid) | 0 | 0 | 0 | 0 | The title, byline, date, prose, and many figures read clearly. Both JavaScript-provided embeds are absent from the reader. | merged claude+codex | rescored |
| jaykmody-gpt | MAJOR | MAJOR | MINOR | MINOR | images!, metadata, missing_content, tables | 0 | 0 | 0 | 0 | The article text, lists, and code shown read largely intact, but the Table of Contents and one architecture figure are missing. The GPT-3 d… | merged claude+codex | rescored |
| joelonsoftware-test | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader reproduces the full Joel Test article cleanly, in order, from the opening SEMA paragraph through the closing hallway-usability-t… | claude/claude-sonnet-5 | rescored |
| joshwcomeau-rerender | MAJOR | MAJOR | MINOR | MINOR | missing_content!, metadata, layout (+2 invalid) | 0 | 0 | 0 | 0 | The reader preserves most of the article text and code, but several interactive embeds and original images are missing, and the extraction … | merged claude+codex | rescored |
| jvns-firecracker | MAJOR | MAJOR | PASS | PASS | missing_content!, extra_content | 0 | 0 | 0 | 0 | The reader displays the article’s extracted text and code in order, with the puzzle image present. The extraction omits the final software … | merged claude+codex | rescored |
| jxnl-rag | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full article body, headings, and lists in correct order with accurate title, author, and date met… | claude/claude-sonnet-5 | rescored |
| karpathy-recipe | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader page reproduces the full article faithfully and in order, with correct title and date, intact bullet lists with markers, both co… | claude/claude-sonnet-5 | rescored |
| karpathy-rnn | MINOR | MINOR | MINOR | PASS | missing_content, metadata | 0 | 0 | 0 | 0 | The reader displays the opening of the article clearly, but the extracted article is cut off before most of the later sections and conclusi… | merged claude+codex | rescored |
| karpathy-software2 | MAJOR | MAJOR | MINOR | PASS | images!, missing_content, layout, metadata (+1 invalid) | 0 | 0 | 0 | 0 | The reader preserves most article prose and the ending, but it omits four substantial original images and two section headings. | merged claude+codex | rescored |
| kentcdodds-context | MAJOR | MAJOR | MINOR | PASS | metadata, missing_content! (+2 invalid) | 0 | 0 | 0 | 0 | The reader preserves the article text, code, list, and two inline images, but omits the hero image and an article embed. The author and pub… | merged claude+codex (disputed) | rescored |
| latentspace-ai-engineer | MINOR | MINOR | PASS | PASS | missing_content, layout | 0 | 0 | 0 | 0 | The reader displays the main article and its figures cleanly, but the extracted article is truncated near the end: the postscript and all e… | merged claude+codex (disputed) | rescored |
| lesswrong-lethalities | MINOR | PASS | MINOR | PASS | metadata | 0 | 0 | 0 | 0 | The reader shows the article body in order and with readable headings and list numbering in the inspected tiles. The extracted metadata omi… | merged claude+codex | rescored |
| lilian-agent | MINOR | MINOR | PASS | PASS | missing_content (+2 invalid) | 0 | 0 | 0 | 0 | The reader displays the captured article clearly, and the listed figures are all present with no measured rendering defects. The extractor … | merged claude+codex (disputed) | rescored |
| lilian-attention | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader page is a complete, faithful, and well-rendered reproduction of the article: all body text, section headings, both tables, the c… | claude/claude-sonnet-5 | rescored |
| matklad-architecture | MAJOR | MAJOR | PASS | PASS | missing_content! | 0 | 0 | 0 | 0 | The reader displays the extracted article clearly, but the extracted text omits its final body paragraph. | merged claude+codex (disputed) | rescored |
| medium-backprop | MAJOR | MAJOR | PASS | MAJOR | images!, code_or_math! | 0 | 0 | 0 | 0 | The reader retains the article text and metadata, but omits five article figures and collapses all three code blocks into single lines. | merged claude+codex | rescored |
| mitchellh-large | MINOR | PASS | MINOR | PASS | metadata | 0 | 0 | 0 | 0 | The reader preserves the article text, headings, lists, and footnotes in order and displays them cleanly. The extracted author byline is mi… | merged claude+codex | rescored |
| mtlynch-google | MAJOR | MAJOR | PASS | PASS | images! | 0 | 0 | 0 | 0 | The article’s text, metadata, and order are preserved, and the matched figures display. One original article image is missing from the read… | merged claude+codex | rescored |
| nullprogram-sm | MINOR | PASS | MINOR | PASS | metadata (+3 invalid) | 0 | 0 | 0 | 0 | The article text and code are largely present and readable, but the reader rendering does not visibly show the three article diagrams. The … | merged claude+codex | rescored |
| oneusefulthing-centaurs | MINOR | MINOR | PASS | PASS | missing_content | 0 | 0 | 0 | 0 | The text and metadata are largely intact, but five article figures visible in the original are absent from the extracted body. | merged claude+codex (disputed) | rescored |
| openai-4o | MAJOR | MAJOR | MINOR | PASS | missing_content!, metadata, missing_content | 0 | 0 | 0 | 0 | The main article text, all three images, and the tokenization table are present and readable. The audio embed is omitted, and the publicati… | merged claude+codex | rescored |
| openai-4o-zh | MAJOR | MAJOR | MINOR | PASS | missing_content!, metadata (+1 invalid) | 0 | 0 | 0 | 0 | The reader preserves most article text and renders the language table legibly, but the article audio embed is absent and the robot images a… | merged claude+codex | rescored |
| overreacted-useeffect | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader page reproduces the article faithfully: title, date, headings, body text, code blocks, and all 12 figures appear in the correct … | claude/claude-sonnet-5 | rescored |
| paulgraham-greatwork | MINOR | PASS | MINOR | PASS | metadata (+2 invalid) | 0 | 0 | 0 | 0 | The article body and its title are carried into a clean, readable reader page. The extractor omits the visible author and date metadata, al… | merged claude+codex | rescored |
| pragmaticengineer-product | MINOR | MINOR | PASS | PASS | extra_content, images | 0 | 0 | 0 | 0 | The main article is extracted in order and displays cleanly, with headings, quotes, lists, and the book cover readable. The author portrait… | merged claude+codex | rescored |
| pytorch-genai2 | MAJOR | PASS | MINOR | MAJOR | metadata, images! | 1 | 0 | 0 | 0 | The reader preserves the article text, lists, code, and figures overall, but the screen recording fails to load and the publication date is… | merged claude+codex | rescored |
| quanta-understand | MAJOR | MAJOR | PASS | PASS | missing_content, images!, images (+1 invalid) | 0 | 0 | 0 | 0 | The reader preserves the main article text and lead illustration, and its layout is clean. It omits the standfirst, two pull quotes, the in… | merged claude+codex (disputed) | rescored |
| raschka-selfattention | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full article: all section headings, body paragraphs, the bulleted query/key/value list, all 33 co… | claude/claude-sonnet-5 | rescored |
| raschka-understanding-llms | MINOR | MINOR | PASS | MINOR | missing_content, layout (+1 invalid) | 0 | 0 | 0 | 0 | The reader preserves the article’s main text, lists, and matched figures, but omits the linked RLHF recommendation card and its image. | merged claude+codex (disputed) | rescored |
| regehr-ub | MINOR | MINOR | MINOR | MINOR | missing_content, layout, code_or_math, metadata | 0 | 0 | 0 | 0 | The reader preserves the visible article flow and code formatting across the captured tiles. The extracted body omits the original article … | merged claude+codex | rescored |
| ruanyifeng-curl | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full curl reference article: all 24 headings, the single figure, the 40 code examples, and the cl… | claude/claude-sonnet-5 | rescored |
| ruanyifeng-weekly | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full article in correct order, with all 57 images displaying properly across the tiles, correct t… | claude/claude-sonnet-5 | rescored |
| ruder-optim | MAJOR | MAJOR | PASS | MINOR | missing_content!, images!, missing_content, extra_content, code_or_math, layout | 0 | 0 | 0 | 0 | The reader preserves most of the long article and displays its figures, code, and most equations well. However, the extractor omits the Cha… | merged claude+codex | rescored |
| rustblog-1.0 | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader page faithfully reproduces the full "Announcing Rust 1.0" article, including all body paragraphs, headings, links, and the compl… | claude/claude-sonnet-5 | rescored |
| samaltman-ia | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader faithfully reproduces the full article text in the correct order with the single cover image intact and readable, and the title … | claude/claude-sonnet-5 | rescored |
| simonw-llms-2024 | MAJOR | MAJOR | PASS | PASS | images!, missing_content! | 0 | 0 | 0 | 0 | The reader presents most of the article in a clean, readable layout, and the matched images, code and lists display correctly. It omits the… | merged claude+codex | rescored |
| simonw-wordcamp | MAJOR | MAJOR | PASS | PASS | images! | 0 | 0 | 0 | 0 | The reader preserves the article text and displays the images shown in the supplied tiles cleanly. One original figure is missing from the … | merged claude+codex | rescored |
| sivers-ff | MINOR | PASS | MINOR | PASS | metadata (+2 invalid) | 0 | 0 | 0 | 0 | The article text and its ordering are preserved, and the reader layout is legible. The embedded video is missing; the reader also formats t… | merged claude+codex (disputed) | rescored |
| stratechery-endbeginning | PASS | PASS | PASS | PASS | – | 0 | 0 | 0 | 0 | The reader page reproduces the full article faithfully and in order: both figures render correctly, the blockquote, footnote, and all secti… | claude/claude-sonnet-5 | rescored |
| vickiboykis-gguf | MAJOR | MAJOR | MINOR | PASS | images!, metadata, missing_content, extra_content | 0 | 0 | 0 | 0 | The reader preserves the article body, code, formulas, and the eight matched figures, but omits the original title image. The author byline… | merged claude+codex | rescored |
| waitbutwhy-ai | MINOR | MINOR | PASS | MINOR | missing_content, extra_content, layout (+1 invalid) | 0 | 0 | 0 | 0 | The reader displays the article text and matched illustrations cleanly in the visible tiles. The extraction appears to omit article footnot… | merged claude+codex | rescored |
| webdev-vitals | MAJOR | MAJOR | MINOR | PASS | metadata, tables!, missing_content!, extra_content (+1 invalid) | 0 | 0 | 0 | 0 | The reader presents the main article text, figures, and code in a readable order. However, several article notes and the article ending are… | merged claude+codex | rescored |
