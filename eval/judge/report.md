# Extraction quality judge — 2026-09-23

66 cases: 42 PASS · 6 MINOR · 18 MAJOR · 0 error. This run judged 66 (12 fresh, 54 cached). Judge: policy screen-then-confirm · screen claude/claude-haiku-4-5 · confirm codex/default (on MINOR, MAJOR); rubric 2026-09-23.3. 13 case(s) had an input cut to fit the prompt. 14 evidence quote(s) could not be found verbatim in the inputs.

Opinions: claude/claude-haiku-4-5 66 opinions, 2,563,259 tokens, $6.42 · codex/default 31 opinions, 1,082,770 tokens. Escalated 31 of 66 screened. Disputed 12.

## Issues by kind

| kind | cases | issues | major |
|---|---:|---:|---:|
| missing_content | 24 | 28 | 9 |
| layout | 21 | 27 | 2 |
| code_or_math | 19 | 21 | 12 |
| metadata | 17 | 21 | 15 |
| extra_content | 9 | 10 | 2 |
| images | 8 | 9 | 5 |
| tables | 6 | 8 | 2 |
| other | 2 | 2 | 0 |

## Cases

`kind!` marks a major issue. `decided by` is the backend whose opinion became the verdict; `(disputed)` means the other backend's verdict differed. Evidence quotes live in `eval/judge/out/<slug>.json` (not committed).

| slug | verdict | kinds | summary | decided by | origin |
|---|---|---|---|---|---|
| acoup-gondor1 | PASS | – | The extraction accurately preserves the article’s title, byline, publication date, complete body, section order, blockquotes, headings, lin… | codex/default (disputed) | fresh |
| acx-sleeper | PASS | – | The extraction is clean and complete. All metadata is accurate, the article body captures every section in order without extraneous navigat… | claude/claude-haiku-4-5 | cached |
| anthropic-mapping | PASS | – | The extraction accurately captures the full article with correct metadata (title, no byline, publication date), all body sections in sequen… | claude/claude-haiku-4-5 | cached |
| arxiv-2609-24983 | PASS | metadata, tables, code_or_math | The extraction accurately captures the article's structure and content through most sections, preserving the title, publication date, and b… | claude/claude-haiku-4-5 | fresh |
| brendangregg-cpu | PASS | code_or_math | The extraction cleanly captures the title, absent byline, date, full article, figures, section order, and proper article boundaries. Both t… | codex/default (disputed) | cached |
| ciechanowski-gps | PASS | metadata, code_or_math, tables | The extraction accurately captures the article's full structure and all sections in order with complete content. Title is padded with autho… | claude/claude-haiku-4-5 | fresh |
| cloudflare-pingora | PASS | – | Clean extraction with all article sections present in order, correct metadata, and properly formatted markdown. The article's content, stru… | claude/claude-haiku-4-5 | cached |
| codinghorror-nocode | PASS | extra_content, code_or_math | The extraction is largely complete with correct metadata (title, author, date) and all article sections in order. Minor presentation issues… | claude/claude-haiku-4-5 | fresh |
| colah-lstm | PASS | code_or_math, layout | The article is complete, correctly bounded, and has accurate metadata, headings, images, and section order. Reading quality is reduced slig… | codex/default | cached |
| csstricks-flexbox | MAJOR | missing_content!, code_or_math | The title, author, date, main technical sections, images, lists, and code blocks are largely preserved. However, both the article opening a… | codex/default (disputed) | fresh |
| danluu-files | PASS | – | The extraction cleanly captures the full article from its opening paragraph through the acknowledgements, while excluding navigation and ad… | codex/default (disputed) | cached |
| distill-featurevis | MAJOR | metadata, missing_content!, images!, code_or_math!, layout!, layout | The main prose and section order are largely preserved, but the incomplete authorship, early cutoff, missing visualizations, and badly brok… | codex/default (disputed) | cached |
| eugeneyan-llm-patterns | MAJOR | code_or_math! | The visible prose, headings, lists, links, and images read coherently, but the article’s many formulas are substantially broken by escaped … | codex/default (disputed) | cached |
| fasterthanlime-golang | MAJOR | metadata!, layout!, code_or_math!, extra_content! | The prose is substantially complete and ordered, with the correct title and date, but the extraction is badly degraded for reading: section… | codex/default | cached |
| githubblog-copilotx | MAJOR | missing_content! | The metadata, article boundaries, ordering, and retained elements are otherwise strong, but a complete subsection about GPT-4 is missing fr… | codex/default | fresh |
| godev-pipelines | MAJOR | code_or_math! | The metadata, article boundaries, prose, section order, and overall completeness are correct. However, pervasive code-block corruption make… | codex/default | cached |
| gradient-icl | PASS | layout | The extraction is clean overall: metadata correct, all article sections present and in order, body boundaries precise. One minor markdown f… | claude/claude-haiku-4-5 | cached |
| gwern-scaling | PASS | metadata, images | The extraction correctly captures the article structure, sections, and content in proper order with good markdown formatting of quotes, lin… | claude/claude-haiku-4-5 | fresh |
| hamel-evals | PASS | layout | Extraction is nearly flawless: metadata correct, all sections present and in order, elements fully intact. Minor issue is that several bull… | claude/claude-haiku-4-5 | cached |
| harvard-annotated-transformer | PASS | missing_content, metadata | The extraction captures the complete article content with correct code, formulas, and structure. The title is accurate and body sections ar… | claude/claude-haiku-4-5 | cached |
| hf-rlhf | MAJOR | missing_content!, code_or_math! | The title, authors, date, main prose, headings, lists, and images are largely captured accurately and in order. However, a substantial fina… | codex/default | cached |
| hillelwayne-engineers | PASS | missing_content, layout | The title, metadata, article boundaries, section order, quotations, links, headings, image, and nearly all body text are preserved well. Th… | codex/default (disputed) | cached |
| huyenchip-llm-eng | PASS | missing_content | The extraction is comprehensive and well-structured. All article sections are present in the correct order, metadata is accurate, and eleme… | claude/claude-haiku-4-5 | cached |
| interconnects-o1 | PASS | extra_content, layout | The extraction accurately captured metadata (title, author, publication date) and the complete article body with all sections in order. Min… | claude/claude-haiku-4-5 | cached |
| jalammar-transformer | PASS | missing_content, layout | The extraction cleanly captures the article's full technical content with correct metadata and all sections in order. The only material iss… | claude/claude-haiku-4-5 | cached |
| jaykmody-gpt | PASS | missing_content | The extraction correctly captures the article's metadata, title, content flow, and technical elements including code blocks and formulas. O… | claude/claude-haiku-4-5 | cached |
| joelonsoftware-test | PASS | other, layout | Extraction is complete with correct metadata, proper body boundaries, and all 12 article sections in order, but applies extensive emphasis … | claude/claude-haiku-4-5 | fresh |
| joshwcomeau-rerender | MAJOR | metadata!, missing_content!, code_or_math!, images!, layout | Most of the main prose remains in order and the extraction ends cleanly, but the date is missing, two article blocks are omitted, and sever… | codex/default | cached |
| jvns-firecracker | PASS | missing_content | The extraction accurately captures the article's title, byline, date, and content through most of the links section, with all code blocks a… | claude/claude-haiku-4-5 | cached |
| jxnl-rag | PASS | missing_content | The extraction cleanly captures the article's structure and content, with all major sections present and properly formatted. However, it en… | claude/claude-haiku-4-5 | cached |
| karpathy-recipe | PASS | – | The extraction is complete and accurate. All metadata is correct (title, date; byline correctly shown as none), the article body runs from … | claude/claude-haiku-4-5 | cached |
| karpathy-rnn | MAJOR | missing_content!, code_or_math, layout | The extraction preserves the metadata, opening, ending, images, and code samples well, but a large article section is completely missing an… | codex/default | cached |
| karpathy-software2 | MAJOR | metadata!, extra_content!, layout, images! | The prose is otherwise complete, correctly ordered, and ends cleanly, with the title and author identified correctly. However, the wrong pu… | codex/default (disputed) | cached |
| kentcdodds-context | MAJOR | metadata! | The article body is clean, complete, correctly bounded, and preserves its headings, lists, links, images, and code blocks. However, both th… | codex/default (disputed) | fresh |
| latentspace-ai-engineer | PASS | layout | The extraction cleanly captures the article with correct metadata, complete sections in order, and all content intact. Footnote reference n… | claude/claude-haiku-4-5 | cached |
| lesswrong-lethalities | MINOR | metadata!, layout | The article is otherwise complete, correctly ordered, and cleanly separated from the page chrome and comments, with the correct title, auth… | codex/default | cached |
| lilian-agent | MINOR | missing_content | The extraction is otherwise strong: metadata, article start, section order, images, formulas, lists, quotations, and code blocks are preser… | codex/default (disputed) | cached |
| lilian-attention | MAJOR | code_or_math!, tables!, layout | The extraction preserves the complete article in order with correct metadata, boundaries, prose, images, lists, references, and code block.… | codex/default | cached |
| matklad-architecture | PASS | – | The extraction cleanly captures the full article with correct metadata (title, no byline, exact date). All nine paragraphs and the rust-ana… | claude/claude-haiku-4-5 | cached |
| medium-backprop | MAJOR | extra_content, images!, code_or_math!, layout | The metadata and full prose are accurate and ordered, and the extraction ends at the correct place. However, the missing figures and degrad… | codex/default | cached |
| mitchellh-large | PASS | – | The extraction captures the full article accurately with correct metadata, proper section boundaries, and complete content in correct order… | claude/claude-haiku-4-5 | cached |
| mtlynch-google | PASS | – | The extraction is clean and complete. Metadata is accurate (title, byline Michael Lynch, and date 2018-02-28), the article body is intact f… | claude/claude-haiku-4-5 | cached |
| nullprogram-sm | PASS | extra_content, layout | The extraction correctly identifies the title, date, and article content, with all sections present and in correct order. A URL navigation … | claude/claude-haiku-4-5 | cached |
| oneusefulthing-centaurs | PASS | layout | The extraction accurately captures the full article with correct title, byline, and publication date. All content is present in proper orde… | claude/claude-haiku-4-5 | cached |
| openai-4o | MAJOR | metadata!, missing_content, tables, extra_content | The main article is substantially present in the correct order and ends cleanly, with its images and prose retained. However, both author a… | codex/default | cached |
| openai-4o-zh | MINOR | metadata!, extra_content, missing_content, tables | The main prose, headings, date, selected image example, and ending are largely preserved in order. The extraction misses the author and par… | codex/default (disputed) | cached |
| overreacted-useeffect | PASS | – | The extraction is clean and complete. Title, date, and byline are correct; the article body begins with the first real paragraph after prop… | claude/claude-haiku-4-5 | cached |
| paulgraham-greatwork | MINOR | metadata! | The article text, title image, inline emphasis, and linked footnote references are preserved cleanly and in order throughout the visible po… | codex/default | cached |
| pragmaticengineer-product | PASS | missing_content | The extraction cleanly captures the article's full content with correct metadata, proper section structure, and preserved elements. A singl… | claude/claude-haiku-4-5 | cached |
| pytorch-genai2 | MINOR | metadata!, layout | The article is otherwise complete, correctly bounded, in order, and preserves its headings, code block, links, and images. The missing date… | codex/default | cached |
| quanta-understand | PASS | missing_content, images | The extraction preserves all major article sections in correct order with accurate metadata, but misses the introductory lede and the image… | claude/claude-haiku-4-5 | fresh |
| raschka-selfattention | MAJOR | code_or_math! | The title, author, date, article boundaries, prose, sections, code blocks, and figures are otherwise complete and correctly ordered. Howeve… | codex/default | cached |
| raschka-understanding-llms | PASS | missing_content | The extraction is strong and complete—all 19 papers are present with full detail, all sections are in order, and metadata is correct. The s… | claude/claude-haiku-4-5 | cached |
| regehr-ub | MAJOR | metadata!, code_or_math! | The article text is otherwise complete, correctly ordered, and cleanly bounded, with the correct author and publication day. However, the t… | codex/default | cached |
| ruanyifeng-curl | PASS | – | The extraction cleanly captures the complete curl reference article with accurate metadata (title: "curl 的用法指南", author: 阮一峰, date: 2019-09… | claude/claude-haiku-4-5 | cached |
| ruanyifeng-weekly | PASS | – | The extraction is clean and complete. All article content is present in correct order with proper markdown formatting; navigation, metadata… | claude/claude-haiku-4-5 | cached |
| ruder-optim | MAJOR | missing_content!, code_or_math!, images!, missing_content, images | The title, author, date, article boundaries, prose, code, references, and section order are largely correct. However, a substantive section… | codex/default | cached |
| rustblog-1.0 | PASS | – | The extraction cleanly captures the entire Rust 1.0 announcement with correct metadata (title, byline, publication date) and complete artic… | claude/claude-haiku-4-5 | cached |
| samaltman-ia | PASS | – | The extraction cleanly captures the article with correct metadata, complete body text in order, and proper markdown formatting. All seven d… | claude/claude-haiku-4-5 | fresh |
| simonw-llms-2024 | PASS | missing_content, other | The extraction captures the article's core content accurately, including all 18 major sections with correct title, byline, and publication … | claude/claude-haiku-4-5 | cached |
| simonw-wordcamp | PASS | missing_content, images | The title, author, date, opening, prose, links, code block, quotations, and nearly all images are extracted cleanly and in order. It has on… | codex/default (disputed) | cached |
| sivers-ff | PASS | – | The extraction is complete and accurate. Metadata (title, byline, date) are correct; the article body begins cleanly without navigation or … | claude/claude-haiku-4-5 | cached |
| stratechery-endbeginning | MINOR | metadata! | The article body is complete, correctly ordered, and cleanly preserves its headings, images, quotation, links, and footnote. The only defec… | codex/default | cached |
| vickiboykis-gguf | PASS | missing_content, code_or_math, layout | The extraction preserves the correct metadata, article boundaries, section order, code blocks, images, and nearly all prose. It has a local… | codex/default | fresh |
| waitbutwhy-ai | PASS | layout | The extraction cleanly captures the complete article with accurate title, byline, and publication date (2015-01-22). All sections are prese… | claude/claude-haiku-4-5 | cached |
| webdev-vitals | MAJOR | metadata!, extra_content, missing_content, tables! | Most prose, headings, lists, links, and the code sample survive in order, but the extraction misses the byline metadata and several callout… | codex/default | cached |
