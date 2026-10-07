# Extraction quality judge — 2026-10-07

66 cases: 43 PASS · 11 MINOR · 12 MAJOR · 0 error. This run judged 66 (65 fresh, 1 cached). Judge: policy screen-then-confirm · screen claude/claude-sonnet-5 · confirm codex/gpt-6-luna (on MINOR, MAJOR); rubric 2026-09-23.3. 13 case(s) had an input cut to fit the prompt. 12 evidence quote(s) could not be found verbatim in the inputs.

Opinions: claude/claude-sonnet-5 66 opinions, 2,663,859 tokens, $10.91 · codex/gpt-6-luna 23 opinions, 765,671 tokens. Escalated 23 of 66 screened. Disputed 5.

## Issues by kind

| kind | cases | issues | major |
|---|---:|---:|---:|
| missing_content | 30 | 39 | 20 |
| layout | 27 | 28 | 2 |
| metadata | 19 | 21 | 6 |
| images | 16 | 18 | 7 |
| code_or_math | 13 | 13 | 5 |
| extra_content | 9 | 9 | 1 |
| other | 9 | 10 | 0 |
| tables | 8 | 9 | 5 |

## Cases

`kind!` marks a major issue. `decided by` is the backend whose opinion became the verdict; `(disputed)` means the other backend's verdict differed. Evidence quotes live in `eval/judge/out/<slug>.json` (not committed).

| slug | verdict | kinds | summary | decided by | origin |
|---|---|---|---|---|---|
| acoup-gondor1 | PASS | – | Clean extraction: title, byline, and date match the source exactly, the body starts with the actual opening paragraph and ends at the artic… | claude/claude-sonnet-5 | fresh |
| acx-sleeper | PASS | missing_content, layout | Title, byline, date, body boundaries, element fidelity (images, quotes, lists, headings) and section order are all correct; the only defect… | claude/claude-sonnet-5 | fresh |
| anthropic-mapping | PASS | missing_content | Clean extraction: title, absent byline, and date are all correct, the article body runs intact and in order from the opening paragraph thro… | claude/claude-sonnet-5 | fresh |
| arxiv-2609-24983 | MAJOR | metadata!, code_or_math!, tables! | The article text is largely preserved in order, and the title and publication date are correct. Metadata misses the authors, and the equati… | codex/gpt-6-luna | fresh |
| brendangregg-cpu | MAJOR | metadata, code_or_math!, extra_content | The title, date, article boundaries, section order, and most prose are preserved. The first perf-stat example is materially broken because … | codex/gpt-6-luna | fresh |
| ciechanowski-gps | MAJOR | metadata, images!, tables!, code_or_math, missing_content! | The extraction preserves the article’s section order and most prose, with the correct byline and date. It has a padded title, loses the int… | codex/gpt-6-luna | fresh |
| cloudflare-pingora | PASS | – | The extraction is clean and faithful: title, byline, and date all match the source exactly, the body starts at the real first paragraph and… | claude/claude-sonnet-5 | fresh |
| codinghorror-nocode | PASS | extra_content, code_or_math | Title, byline, date and the article's ending are all captured correctly and the body content matches the source in order and completeness. … | claude/claude-sonnet-5 | fresh |
| colah-lstm | PASS | code_or_math | A clean, faithful extraction: title, date, and body boundaries are correct, all sections and images appear in original order, and the singl… | claude/claude-sonnet-5 | fresh |
| csstricks-flexbox | MAJOR | missing_content!, images! | Title, byline, date, code, and most of the main guide are preserved. However, the extraction skips the article’s opening paragraph and cont… | codex/gpt-6-luna | fresh |
| danluu-files | PASS | layout, other | The extraction faithfully reproduces the entire talk transcript from the italicized intro through the acknowledgements, preserving all head… | claude/claude-sonnet-5 | fresh |
| distill-featurevis | MAJOR | metadata!, missing_content!, images!, code_or_math!, layout | The extraction preserves the main article sections through Author Contributions and captures most prose in order. It omits the article’s fi… | codex/gpt-6-luna | fresh |
| eugeneyan-llm-patterns | PASS | code_or_math | Within the visible (truncated) portion, metadata (title, byline, date) is correct, the body starts at the real intro with the discussion-li… | claude/claude-sonnet-5 | fresh |
| fasterthanlime-golang | MAJOR | layout!, code_or_math!, images!, missing_content!, extra_content, metadata | The extraction preserves most article prose in order and records the author and publication date correctly. However, it drops section headi… | codex/gpt-6-luna | fresh |
| githubblog-copilotx | MINOR | images, other | The article text is present in order from its opening paragraph through its final paragraph, and the title, author, and original publicatio… | codex/gpt-6-luna (disputed) | fresh |
| godev-pipelines | MAJOR | code_or_math!, missing_content! | Title, byline, date, and the article body through Further reading are captured in order. Code formatting is inconsistent and some code cont… | codex/gpt-6-luna | fresh |
| gradient-icl | PASS | layout | A faithful, well-ordered extraction with correct title, byline, date, clean body start and end, and all sections intact; the only flaw is b… | claude/claude-sonnet-5 | fresh |
| gwern-scaling | PASS | missing_content, layout | The extraction is accurate, well-ordered, and preserves the long article's prose, blockquotes, images/captions and footnote links faithfull… | claude/claude-sonnet-5 | fresh |
| hamel-evals | PASS | – | The extraction cleanly captures the full article from the "Motivation" heading through the Footnotes, with accurate title, byline, and date… | claude/claude-sonnet-5 | fresh |
| harvard-annotated-transformer | PASS | missing_content, layout | An extremely faithful, nearly line-by-line reproduction of this long notebook-style article: title, absent byline/date, code blocks, math, … | claude/claude-sonnet-5 | fresh |
| hf-rlhf | MAJOR | metadata!, missing_content!, images!, other, code_or_math, images | The main article through the lecture link is largely intact and in order, with figures retained. The extraction stops before the Further re… | codex/gpt-6-luna | fresh |
| hillelwayne-engineers | PASS | missing_content, images | A faithful, well-ordered extraction with correct title, date, and absent byline matching the source; the only flaws are the complete loss o… | claude/claude-sonnet-5 | fresh |
| huyenchip-llm-eng | PASS | missing_content, tables, layout | A faithful, well-ordered extraction with correct title/byline/date and clean body boundaries; only minor cosmetic issues remain (one small … | claude/claude-sonnet-5 | fresh |
| interconnects-o1 | PASS | extra_content, layout | A clean, faithful extraction: title, byline and date are correct, all images/blockquotes/footnote content survive, and the article ends at … | claude/claude-sonnet-5 | fresh |
| jalammar-transformer | PASS | missing_content, tables, layout | A faithful, well-ordered extraction with correct title/byline/date and all headings, body text, and diagrams present in sequence; the only … | claude/claude-sonnet-5 | fresh |
| jaykmody-gpt | PASS | missing_content | A faithful, well-formed extraction: title, byline, and date are correct, the body starts and (as far as the truncated text shows) tracks th… | claude/claude-sonnet-5 | fresh |
| joelonsoftware-test | PASS | layout, other | A faithful, well-structured extraction: correct title, byline, date, clean body start and end, and all 12 sections present in order with li… | claude/claude-sonnet-5 | fresh |
| joshwcomeau-rerender | MINOR | metadata, layout, missing_content!, images | Title and byline are correct, and the body mostly preserves the article’s order and content. The publication date and two passages are miss… | codex/gpt-6-luna | fresh |
| jvns-firecracker | MINOR | metadata, missing_content! | The article text is otherwise preserved in order, including code blocks, lists, and the image. The extractor stops before the article’s fin… | codex/gpt-6-luna (disputed) | fresh |
| jxnl-rag | PASS | missing_content, layout | The extraction correctly captures title, byline, date, and the full body in order with all links intact, only tripping on a dangling final … | claude/claude-sonnet-5 | fresh |
| karpathy-recipe | PASS | – | The extraction is clean: title, date, and absence of byline are all captured correctly, the body starts with the article's actual opening p… | claude/claude-sonnet-5 | fresh |
| karpathy-rnn | MINOR | metadata, missing_content!, images | The title, date, article opening, and most formatting are preserved. The Further Reading section is missing, and the extraction stops befor… | codex/gpt-6-luna (disputed) | fresh |
| karpathy-software2 | MINOR | metadata, layout | The article text is otherwise complete, in order, and ends at the article’s final paragraph. The title, author, body boundaries, and inline… | codex/gpt-6-luna | fresh |
| kentcdodds-context | MINOR | metadata | The article body starts and ends correctly and preserves its sections, code, and lists. Title is correct; author and publication date are m… | codex/gpt-6-luna (disputed) | fresh |
| latentspace-ai-engineer | PASS | metadata, layout, other | A faithful, well-ordered extraction of the full article body (intro through footnotes) with correct title, date, body-start and body-end bo… | claude/claude-sonnet-5 | fresh |
| lesswrong-lethalities | MINOR | metadata, layout | The title and byline are correct, and the article body appears complete and in order through its ending. The date metadata is absent, and t… | codex/gpt-6-luna | fresh |
| lilian-agent | PASS | missing_content, other | A faithful, well-ordered extraction with correct title/byline/date, clean body start, intact code blocks, lists, and math, but it is trunca… | claude/claude-sonnet-5 | fresh |
| lilian-attention | MINOR | code_or_math, tables | Title, author, date, article boundaries, sections, images, and references are captured. Some formulas have malformed escaping, and the firs… | codex/gpt-6-luna (disputed) | fresh |
| matklad-architecture | PASS | missing_content | Clean extraction with correct title, no-byline, and matching date; body starts correctly and all footer/UI cruft is excluded, but the extra… | claude/claude-sonnet-5 | fresh |
| medium-backprop | PASS | extra_content, code_or_math, layout | A faithful, complete extraction with correct title/byline/date and full section coverage in order, marred only by a leading byline/avatar w… | claude/claude-sonnet-5 | fresh |
| mitchellh-large | PASS | layout | A clean, faithful extraction: title, absent byline, and date all match the source, the body starts and ends at the correct boundaries, and … | claude/claude-sonnet-5 | fresh |
| mtlynch-google | PASS | – | The extraction is clean: title, byline, and date are correct, the article body starts and ends exactly at the article boundaries, all secti… | claude/claude-sonnet-5 | fresh |
| nullprogram-sm | PASS | layout, other | The extraction faithfully reproduces the article's title, date, and full body in order, starting at the first real paragraph and ending at … | claude/claude-sonnet-5 | fresh |
| oneusefulthing-centaurs | PASS | layout, missing_content | A clean, faithful extraction with correct title, byline, date, body start and end, and all images/paragraphs preserved in order; the only f… | claude/claude-sonnet-5 | fresh |
| openai-4o | MAJOR | metadata, missing_content!, tables!, images! | The main narrative is substantially present and ordered, with the correct title and a clean opening. However, the publication date, evaluat… | codex/gpt-6-luna | fresh |
| openai-4o-zh | PASS | layout, extra_content, missing_content, tables | The extraction correctly captures title, absent byline, date, and the full article body in order from the intro through model availability,… | claude/claude-sonnet-5 | fresh |
| overreacted-useeffect | PASS | – | The extraction faithfully reproduces the article: correct title and date, clean body start (donation widget correctly excluded), headings/o… | claude/claude-sonnet-5 | fresh |
| paulgraham-greatwork | MINOR | metadata | The article body is in order and preserves the visible text and footnote links. The prompt truncates both inputs before the ending, so body… | codex/gpt-6-luna | fresh |
| pragmaticengineer-product | MINOR | extra_content, missing_content, images | Title, byline, date, and the main article are captured accurately and in order. The extraction extends into promotional material, omits the… | codex/gpt-6-luna | fresh |
| pytorch-genai2 | MINOR | metadata | The article body starts and ends at the right places, with its sections, images, code, and lists largely intact. Title and byline are corre… | codex/gpt-6-luna | fresh |
| quanta-understand | PASS | images | Clean extraction: title, byline and date match exactly, the article body starts and ends at the correct points, all paragraphs appear compl… | claude/claude-sonnet-5 | fresh |
| raschka-selfattention | PASS | code_or_math | The extraction faithfully reproduces the full article in order—title, byline, and date all correct, body starts at the first paragraph and … | claude/claude-sonnet-5 | fresh |
| raschka-understanding-llms | PASS | missing_content | A faithful, well-ordered extraction that preserves title, byline, date, all 19 numbered paper entries with their images/captions/blockquote… | claude/claude-sonnet-5 | fresh |
| regehr-ub | MAJOR | metadata!, layout!, missing_content! | Most article prose and sections are present and ordered, and metadata has a plausible byline and timestamp. However, the title is wrong, th… | codex/gpt-6-luna | fresh |
| ruanyifeng-curl | PASS | layout | Clean, faithful extraction: correct title, byline, and date, body starts at the intro section and ends cleanly at the reference link/（完）, w… | claude/claude-sonnet-5 | fresh |
| ruanyifeng-weekly | PASS | other, layout | An essentially complete and faithful extraction: title, byline, date, body start/end and section order all match the source exactly, with e… | claude/claude-sonnet-5 | fresh |
| ruder-optim | PASS | missing_content, images, layout | A faithful, well-ordered extraction of a very long technical post with correct title/byline/date and a clean start and end (navigation, rel… | claude/claude-sonnet-5 | fresh |
| rustblog-1.0 | PASS | layout, other | Accurate, complete extraction with correct title, byline, date, and body boundaries matching the source article; only minor cosmetic deviat… | claude/claude-sonnet-5 | fresh |
| samaltman-ia | PASS | – | Clean extraction: title, absent byline, and date (2024-09-22T16:00:00Z matches Sep 23 in UTC+8) are all correct, the article text is comple… | claude/claude-sonnet-5 | fresh |
| simonw-llms-2024 | PASS | images, missing_content | The extraction cleanly captures title, byline, date, and the full article body from its opening paragraph through the final 'Everything tag… | claude/claude-sonnet-5 | fresh |
| simonw-wordcamp | PASS | missing_content, images | The extraction faithfully reproduces the title, byline, date, and the full slide-by-slide body text in correct order with code blocks and q… | claude/claude-sonnet-5 | fresh |
| sivers-ff | PASS | – | Clean extraction: title, byline, and date match the source exactly, the body begins with the article's opening parenthetical and ends at th… | claude/claude-sonnet-5 | fresh |
| stratechery-endbeginning | PASS | – | The extraction cleanly captures the full article from its opening paragraph through the closing footnote, preserving headings, the blockquo… | claude/claude-sonnet-5 | fresh |
| vickiboykis-gguf | MAJOR | metadata!, images!, images | The title and date are correct, and the article mostly reads in order through its conclusion. However, the author is missing and the GGML c… | codex/gpt-6-luna | fresh |
| waitbutwhy-ai | PASS | extra_content, layout | A faithful, well-ordered extraction of a long article with correct title/byline/date and intact images, lists, and footnotes; the only flaw… | claude/claude-sonnet-5 | fresh |
| webdev-vitals | MAJOR | metadata, extra_content!, missing_content!, tables! | The title, publication date, opening paragraph, and most article sections are captured. However, several explanatory notes and a key paragr… | codex/gpt-6-luna | cached |
