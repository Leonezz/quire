# Extraction quality judge — 2026-09-23

66 cases: 35 PASS · 13 MINOR · 18 MAJOR · 0 error. This run judged 1 (0 fresh, 1 cached); 65 rows are from earlier runs. Judge: policy single · codex/default; rubric 2026-09-23.3. 13 case(s) had an input cut to fit the prompt. 2 evidence quote(s) could not be found verbatim in the inputs.

Opinions: codex/default 1 opinion, 31,968 tokens. Disputed 0. 65 result(s) predate the hybrid judge and carry no opinions.

## Issues by kind

| kind | cases | issues | major |
|---|---:|---:|---:|
| missing_content | 25 | 33 | 14 |
| layout | 25 | 31 | 1 |
| code_or_math | 20 | 23 | 12 |
| metadata | 19 | 21 | 19 |
| extra_content | 12 | 13 | 4 |
| images | 9 | 9 | 3 |
| tables | 8 | 9 | 2 |

## Cases

`kind!` marks a major issue. `decided by` is the backend whose opinion became the verdict; `(disputed)` means the other backend's verdict differed. Evidence quotes live in `eval/judge/out/<slug>.json` (not committed).

| slug | verdict | kinds | summary | decided by | origin |
|---|---|---|---|---|---|
| acoup-gondor1 | PASS | – | The extraction cleanly preserves the article’s correct title, author, publication date, full body, headings, blockquotes, links, and images… | – | previous |
| acx-sleeper | PASS | – | The extraction cleanly preserves the correct title, author, publication date, full article text, section order, quotations, list, links, an… | – | previous |
| anthropic-mapping | PASS | – | The extraction cleanly preserves the article’s metadata, full body, figures and captions, list, links, and Policy Memo ending while excludi… | – | previous |
| arxiv-2609-24983 | MINOR | metadata!, code_or_math, tables | The article is otherwise extracted comprehensively and in order, with the correct title and date, clean boundaries, figures, headings, list… | – | previous |
| brendangregg-cpu | PASS | code_or_math | The article metadata, boundaries, prose, headings, images, links, lists, and section order are preserved. Both terminal-output examples rem… | – | previous |
| ciechanowski-gps | PASS | metadata, tables | The article text is comprehensive, correctly ordered, and begins in the right place, with accurate author and date metadata. The main defec… | – | previous |
| cloudflare-pingora | PASS | – | The extraction cleanly preserves the correct title, authors, publication date, full article structure, lists, links, and figures. It starts… | – | previous |
| codinghorror-nocode | PASS | extra_content, code_or_math | The title, author, date, complete article text, quotations, list, links, and main image were extracted accurately and in order. Reading qua… | – | previous |
| colah-lstm | PASS | code_or_math, layout | The article is otherwise complete, correctly bounded, and has accurate metadata, headings, prose, links, diagrams, and section order. Its m… | – | previous |
| csstricks-flexbox | MAJOR | missing_content!, layout | The title, author, date, central instructional sections, code blocks, lists, and explicit images are largely preserved. However, substantia… | – | previous |
| danluu-files | PASS | – | The extraction cleanly captures the complete article in order, with correct metadata boundaries and intact headings, quotations, lists, lin… | – | previous |
| distill-featurevis | MAJOR | metadata, missing_content!, code_or_math!, images!, layout | The main prose and section order are largely preserved through Author Contributions, and the title and date are correct. However, two autho… | – | previous |
| eugeneyan-llm-patterns | MAJOR | extra_content!, metadata! | The extraction is substantial and internally readable, but it cannot be validated against the entirely empty SOURCE; under the supplied evi… | – | previous |
| fasterthanlime-golang | MAJOR | metadata!, layout!, code_or_math!, extra_content! | The prose is substantially complete and in order, with the correct title and publication date. However, the invented byline, missing sectio… | – | previous |
| githubblog-copilotx | MINOR | missing_content | The extraction cleanly captures the title, author, publication date, article boundaries, media links, lists, and nearly all body content in… | – | previous |
| godev-pipelines | MAJOR | code_or_math! | The metadata, article boundaries, prose, section order, and overall completeness are correct. However, pervasive corruption of the Go code … | – | previous |
| gradient-icl | MINOR | code_or_math, layout | The article metadata, boundaries, section order, prose, quotations, links, and figures are otherwise complete and accurate. Only minor form… | – | previous |
| gwern-scaling | MINOR | metadata!, missing_content, layout | The title, publication date, main prose, quotations, links, images, lists, and visible ordering are largely preserved. A short introductory… | – | previous |
| hamel-evals | PASS | – | The extraction cleanly preserves the correct title, author, publication date, full article body, code blocks, table, images, lists, heading… | – | previous |
| harvard-annotated-transformer | MAJOR | metadata!, missing_content, code_or_math! | The prose, headings, blockquotes, and code are otherwise comprehensive and remain in order. However, the missing author metadata and system… | – | previous |
| hf-rlhf | MAJOR | missing_content!, code_or_math | The title, authors, date, main prose, headings, lists, and figures are largely preserved. However, the article is substantially truncated b… | – | previous |
| hillelwayne-engineers | PASS | missing_content, layout | The extraction preserves the title, date, article boundaries, section order, prose, headings, quotations, links, and appendix. Its only not… | – | previous |
| huyenchip-llm-eng | PASS | tables | The extraction is complete, correctly bounded, and preserves the article’s metadata, structure, code, lists, quotations, and figures. The o… | – | previous |
| interconnects-o1 | PASS | extra_content, images, layout | The metadata, prose, quotations, main figures, and ending footnote are otherwise complete and correctly ordered. Reading quality is good, w… | – | previous |
| jalammar-transformer | PASS | tables | The extraction preserves the title, author, publication date, full instructional article, section order, lists, captions, and figures. It r… | – | previous |
| jaykmody-gpt | PASS | missing_content, code_or_math | The extraction preserves the article's metadata, prose, section order, code blocks, lists, links, and images very well. Its main defects ar… | – | previous |
| joelonsoftware-test | PASS | missing_content, layout | The extraction has correct metadata and clean article boundaries, and nearly the entire article remains in order. It omits one linked sente… | – | previous |
| joshwcomeau-rerender | MAJOR | metadata!, missing_content!, code_or_math!, images, layout | Most of the article remains readable and in order, but the missing publication date and passages, badly broken code playgrounds, omitted fi… | – | previous |
| jvns-firecracker | MINOR | missing_content! | The title, metadata, opening, section order, image, lists, quotation, and code blocks are otherwise preserved well. Only the short final su… | – | previous |
| jxnl-rag | PASS | missing_content | The title, byline, date, body start, section order, headings, and lists are preserved well. Only the final promotional course-link line is … | – | previous |
| karpathy-recipe | PASS | – | The extraction cleanly preserves the complete article in order, with correct metadata, boundaries, headings, lists, links, and code blocks. | codex/default | cached |
| karpathy-rnn | MAJOR | missing_content!, code_or_math, layout | The title, absent byline, date, article boundaries, and most rich content are extracted well. However, a substantial complete section is mi… | – | previous |
| karpathy-software2 | MAJOR | metadata!, extra_content!, images!, layout | The prose is otherwise present in order and ends cleanly, with the title and byline correctly identified. However, the wrong metadata date,… | – | previous |
| kentcdodds-context | MAJOR | metadata! | The article body is complete, well bounded, correctly ordered, and preserves its headings, lists, links, images, and code blocks. The missi… | – | previous |
| latentspace-ai-engineer | MINOR | metadata!, layout | The article body is complete, correctly ordered, cleanly bounded, and preserves its headings, lists, quote, and images. The main defect is … | – | previous |
| lesswrong-lethalities | MINOR | metadata!, layout | The article title, author, full body, section order, and ending were extracted cleanly without page chrome or comments. The publication dat… | – | previous |
| lilian-agent | PASS | missing_content, layout, code_or_math | The extraction preserves the title, metadata, clean article start, section order, prose, images, lists, and code blocks. It is highly compl… | – | previous |
| lilian-attention | MAJOR | code_or_math!, tables!, layout | The extraction preserves the correct metadata, article boundaries, prose, images, section order, code block, and references. However, perva… | – | previous |
| matklad-architecture | MINOR | missing_content! | The title, date, body start, formatting, and nearly all article content are preserved cleanly. The final series-reference paragraph is miss… | – | previous |
| medium-backprop | MAJOR | extra_content, images!, code_or_math!, layout | The metadata, prose, section order, and ending are accurate and complete. However, all article figures are absent and the code and math for… | – | previous |
| mitchellh-large | PASS | layout | The extraction preserves the correct metadata and essentially all article content in order, with clean boundaries. Only minor list and foot… | – | previous |
| mtlynch-google | PASS | – | The extraction cleanly preserves the full article in order, with correct metadata, a proper article-only start and end, and intact headings… | – | previous |
| nullprogram-sm | PASS | extra_content, layout | The article is complete, correctly ordered, and ends cleanly, with accurate title, absent byline, and date metadata. Code, headings, links,… | – | previous |
| oneusefulthing-centaurs | PASS | layout | The extraction is complete, cleanly bounded, and preserves the article's metadata, prose, links, and images. Its only defect is one missing… | – | previous |
| openai-4o | MAJOR | metadata!, missing_content, tables | The main prose, section order, title, opening, ending, and sample images are largely preserved. However, both author and publication-date m… | – | previous |
| openai-4o-zh | MINOR | metadata!, extra_content, missing_content, tables | The main article is readable, ordered, and reaches the correct ending, with its title and date captured correctly. The author is missing, s… | – | previous |
| overreacted-useeffect | PASS | layout | The extraction accurately preserves the title, date, article opening, section order, code blocks, lists, links, and figures throughout the … | – | previous |
| paulgraham-greatwork | MINOR | metadata! | The article title, body, image, emphasis, and linked footnote markers are preserved cleanly and in order throughout the visible text. The o… | – | previous |
| pragmaticengineer-product | MINOR | extra_content! | The title, author, publication date, opening, and complete article text are captured accurately with intact structure. However, the extract… | – | previous |
| pytorch-genai2 | MINOR | metadata!, layout | The article is otherwise complete, correctly bounded, and preserves its headings, code block, links, images, and overall order. The missing… | – | previous |
| quanta-understand | PASS | missing_content, images | The extraction preserves the correct metadata and the complete main argument in order, ending cleanly at the article’s conclusion. Only the… | – | previous |
| raschka-selfattention | MAJOR | code_or_math! | The metadata, article boundaries, section order, prose, code blocks, and figures are otherwise complete and clean. However, the pervasive u… | – | previous |
| raschka-understanding-llms | PASS | missing_content | The title, byline, date, article boundaries, section order, lists, quotations, and nearly all images are preserved well. The only notable l… | – | previous |
| regehr-ub | MAJOR | metadata!, code_or_math! | The prose is complete, correctly ordered, and cleanly bounded, with the correct byline and publication day. However, the article title is w… | – | previous |
| ruanyifeng-curl | PASS | – | The extraction cleanly captures the correct metadata and the complete article in order, stopping at the article’s explicit ending. Headings… | – | previous |
| ruanyifeng-weekly | PASS | – | The extraction cleanly captures the correct metadata and the complete article in order, from its opening paragraph through “（完）”, while exc… | – | previous |
| ruder-optim | MAJOR | missing_content, code_or_math!, images, layout | The metadata, article boundaries, prose, code blocks, references, and overall section order are largely correct. However, central mathemati… | – | previous |
| rustblog-1.0 | PASS | layout | The extraction preserves the correct metadata and the complete article in order, with clean article boundaries. Its only noticeable defect … | – | previous |
| samaltman-ia | PASS | – | The extraction preserves the correct title, absent byline, publication day, complete article text in order, and clean ending. The cover ima… | – | previous |
| simonw-llms-2024 | PASS | missing_content, images | The extraction preserves the correct metadata, article boundaries, section order, prose, lists, quotes, code, and nearly all media. It only… | – | previous |
| simonw-wordcamp | PASS | missing_content, images | The extraction preserves the correct metadata, clean article start, prose, quotations, code, and nearly all figures in order. It only drops… | – | previous |
| sivers-ff | PASS | – | The extraction cleanly preserves the article’s title, author, date, full body, and boundaries while excluding the page chrome, reply form, … | – | previous |
| stratechery-endbeginning | MINOR | metadata! | The article body is complete, correctly ordered, and cleanly bounded, with headings, quotation, images, links, and footnote preserved. The … | – | previous |
| vickiboykis-gguf | PASS | extra_content, missing_content, code_or_math | The extraction is accurate and well ordered overall, with correct metadata, boundaries, code, headings, images, and quotations. It has an o… | – | previous |
| waitbutwhy-ai | PASS | missing_content, layout, extra_content | The title, author, date, main article text, headings, lists, and images are extracted accurately and in order. The main defects are omitted… | – | previous |
| webdev-vitals | MAJOR | metadata!, extra_content, missing_content!, tables! | The main prose, headings, code sample, title, publication date, and article ending are largely preserved. However, the author metadata is w… | – | previous |
