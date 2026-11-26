use crate::codex::{
    CodexAccount, CodexClient, DynamicTool, ToolCall, ToolCallHandler, ToolProgress, ToolReply,
    TurnOptions, TurnOutcome,
};
use crate::images::ImageCache;
use crate::materials::{
    image_urls_of_record, search_hits, valid_hex_16, AnnotationStore, MaterialStore,
    SaveArtifactInput, UpdateArtifactChange, ARTIFACT_TYPES, MAX_ARTIFACT_SOURCE,
};
use crate::sqlite_stores::{now_iso, session_title_for, ItemStore, SessionStore, TurnInput};
use crate::types::{
    AgentContext, AgentEvent, AgentRequest, AgentResult, AgentRun, AgentStatus, AgentToolRow,
    MaterialRecord, MaterialSummary, OpenUrlResult,
};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

pub const PAGE_CHARS: usize = 24_000;
pub const REPEAT_LIMIT: usize = 2;
pub const REPEAT_STOP: usize = 12;
pub const CALL_LIMIT: usize = 250;
pub const CALL_STOP: usize = 300;
pub const QUIT_MESSAGE: &str = "Stopped: Quire quit while the agent was answering.";

const RUNTIME_MODULES: &str =
    "quire (Quire's components), react, react-dom, recharts, d3 (and d3-*), lucide-react, lodash (and lodash/*)";

// ---------------------------------------------------------------------------
// Prompt builder (matching agent-prompt.ts)
// ---------------------------------------------------------------------------

const PREAMBLE: &str = "You are Quire's reading agent. You answer from the reader's library and quote its exact words.\n\n\
What you can do, through your tools: read any material in the library (material_read); read the reader's own highlights and notes on a material (material_annotations); search the library by content (library_search, library_recent) and see what arrived in the inbox (inbox_list); import a web page into the library (library_import); read the saved original of a page (material_source) and rebuild it; and write documents that are saved into the library as artifacts (artifact_write), which the reader can open, cite and keep. When the reader asks you to write, save, draft, synthesise or keep something, do it with artifact_write and reply with a one-line summary and the [artifact-id] citation; never say you cannot create files.\n\n\
Artifacts come in six types; choose the one that fits what the reader needs, not always Markdown: markdown for prose (the default), code for a single source file, react for anything interactive (a chart, dashboard, calculator, table to sort or filter, quiz), mermaid for a diagram (flow, sequence, timeline, mind map), html for a laid-out page, and svg for a drawn figure. To change an artifact, prefer artifact_update (replace one exact passage) over artifact_rewrite (replace the whole source); both keep the earlier version. artifact_write's description gives the rules an HTML artifact must follow.\n\n\
An artifact is what the reader keeps: it has to be worth rereading months later, so write it like a careful editor would publish it. Title: specific enough to find again, naming the subject and, when there is one, the finding. Lead: one to three sentences under the title that give the answer or the main finding before any heading; the rest supports it. Structure by idea, not by source: each heading states its section's point (\"Rerankers are the largest single gain\", not \"Reranking\" or \"Conclusion\"). Evidence: every claim drawn from a source carries its exact quote and citation; give numbers with their units and conditions; say where sources disagree, and mark your own inference as yours. Form: a table when three or more things are compared on the same attributes; a callout for what the reader must not miss (> [!TIP] Key takeaways, > [!WARNING] for a caveat, > [!NOTE] for context; the marker's line may carry a title when a list or a blank > line follows); a chart, timeline or diagram only when it shows something prose cannot, as its own react or mermaid artifact or inside one. Prose: plain, specific and short; no filler (\"it is important to note\", \"in conclusion\", \"delve\", \"值得注意的是\", \"综上所述\"), no talk about the document itself, no emoji. Write in the language the reader writes in. Before saving, reread it and cut every sentence that does not change what the reader understands.\n\n\
How to cite: refer to materials by their title in prose. Cite by writing the material id in square brackets immediately after the claim or quote it supports, e.g. …as the author puts it, \"exact words\" [0123456789abcdef]. Several sources for one claim go in one bracket: [id, id]. Never print an id bare, in backticks, in parentheses or in a list of ids, and never refer to a material by its id in prose. A claim needs the exact quote before the citation, so the reader can jump to it. Quire resolves every [id] for the reader: in an answer it shows the material's title, and in an artifact it becomes a numbered reference with a Sources list (titles, authors, where it appeared) appended after the text — so an artifact never needs its own references, bibliography or sources section.";

fn task_instruction(task: &str, material_id: Option<&str>) -> Option<String> {
    match task {
        "explain" => Some("Explain the selected passage (or, without a selection, this material) in plain terms. Keep the author's meaning; quote the exact words you rely on.".into()),
        "verify" => Some("Check the claims in the passage: which are supported by the material itself, which need outside evidence. Do not invent sources; say plainly what you cannot verify.".into()),
        "related" => Some("Find related material in the library with library_search and library_recent. For each related material give one line on how it relates, naming it by title and citing it as [id].".into()),
        "summary" => Some("Summarise this material: the thesis, the argument in order, the evidence, and what the author concedes. Quote sparingly and exactly.".into()),
        "synthesis" => Some("Write a synthesis across the materials the reader names, or that library_search finds for the topic. Every claim carries [material-id] and exact quotes. Then save it with artifact_write, listing every material id you used in sources, and reply with a one-line summary and the [artifact-id] citation.".into()),
        "rebuild" => {
            let id_token = material_id.map(|id| format!("[{id}]")).unwrap_or_else(|| "[<id>]".into());
            Some(format!("The extractor could not recover this page cleanly. Read the captured page text with material_source (page through it fully), then rewrite the article as faithful Markdown: title line, byline and date if present, the body in order with headings, paragraphs, lists, quotes, code blocks and links; leave out navigation, related-post cards, comments, share and subscribe blocks; never invent or summarise. Save it with artifact_write using lineage {id_token} (its `sources` argument) and reply with one line saying the page was rebuilt, followed by the [artifact-id] citation."))
        }
        "cleanup_transcript" => {
            let target_id = material_id.unwrap_or("<id>");
            Some(format!(
                "Refine the machine-generated transcript of material {target_id} into clean, speaker-attributed, semantically structured prose WITHOUT summarising, dropping substance, or translating.\n\
                1. Read all raw cues with transcript_read_raw (id \"{target_id}\", starting at offset 0 — which also returns `showNotes` with host/guest names and topic clues — and paging with nextOffset until nextOffset is null).\n\
                2. NEVER TRANSLATE: keep every sentence and speaker turn in the EXACT language it appears in the raw cues (Chinese stays Chinese, English stays English; in bilingual interviews where one speaker speaks Chinese and another speaks English, preserve each speaker's original language verbatim without translating either side). Ignore the system prompt's general \"Write in the language the reader writes in\" rule for the transcript body.\n\
                3. Split by speaker turns: infer speaker switches from questions vs answers, language/register shifts, forms of address, and names in `showNotes`/`byline`. Start EVERY speaker turn on its own new paragraph prefixed with `[MM:SS] **Speaker**: ` (use real names from `showNotes`/`byline` when clear, otherwise `**主持人**` / `**嘉宾**` for Chinese or `**Host**` / `**Guest**` for English).\n\
                4. Split by semantics & restore sentences: break run-on ASR streams into complete, properly punctuated sentences (`。？！` / `. ? !`), and split long monologues into focused single-idea paragraphs (~40–90 words or ~60–160 Chinese characters per paragraph). Give each split paragraph the exact `[MM:SS]` (or `[H:MM:SS]`) timestamp from the raw cue where that sentence/idea starts, strictly non-decreasing.\n\
                5. Repair homophones, proper nouns, technical terms, and mixed CJK/English spacing using `title` and `showNotes`; trim only pure non-lexical stutters (`嗯嗯`, `uh`, repeated false starts) while keeping word/character count within 70%–125% of the raw cues — never condense or skip sections.\n\
                6. Insert descriptive `## Section Title` headings at major topic transitions, written in the primary language of the episode's `title` / `showNotes` (e.g. Chinese headings for Chinese-titled podcasts).\n\
                7. Save in place with transcript_save_refined (id \"{target_id}\") and reply in one sentence (in the episode's primary language) confirming how many sections/turns were refined."
            ))
        }
        _ => None,
    }
}

fn material_head(m: &MaterialRecord) -> String {
    let mut lines = vec![format!("Material {}: {}", m.id, m.title)];
    if let Some(ref b) = m.byline {
        lines.push(format!("By {b}"));
    }
    lines.push(format!("URL: {}", m.url));
    lines.join("\n")
}

pub fn build_prompt(
    request: &AgentRequest,
    library: &[MaterialSummary],
    material: Option<&MaterialRecord>,
) -> String {
    let mut parts = vec![PREAMBLE.to_string()];
    match (&request.context, material) {
        (AgentContext::Library, _) | (_, None) => {
            if library.is_empty() {
                parts.push("The library is empty.".into());
            } else {
                let shown = library.len().min(40);
                let lines: Vec<String> = library
                    .iter()
                    .take(40)
                    .map(|m| match &m.byline {
                        Some(b) => format!("- {} {} — {b}", m.id, m.title),
                        None => format!("- {} {}", m.id, m.title),
                    })
                    .collect();
                let suffix = if library.len() > 40 {
                    format!(", {shown} of {}", library.len())
                } else {
                    String::new()
                };
                parts.push(format!("The library index (newest first{suffix}):\n{}", lines.join("\n")));
            }
        }
        (_, Some(mat)) => {
            if request.task == "rebuild" || request.task == "cleanup_transcript" {
                parts.push(material_head(mat));
            } else {
                let text = mat.markdown.as_deref().or(mat.plain.as_deref()).unwrap_or("");
                let head = material_head(mat);
                if text.is_empty() {
                    parts.push(format!("{head}\nThis material has no text representation (a scanned PDF, perhaps); say so if the question needs its content."));
                } else {
                    let chars: Vec<char> = text.chars().collect();
                    let shown: String = chars.iter().take(PAGE_CHARS).collect();
                    let more = if chars.len() > PAGE_CHARS {
                        format!(
                            "\n[{} more characters; read on with material_read id {} offset {PAGE_CHARS}]",
                            chars.len() - PAGE_CHARS,
                            mat.id
                        )
                    } else {
                        String::new()
                    };
                    parts.push(format!("{head}\n\n<material>\n{shown}\n</material>{more}"));
                }
            }
            if let AgentContext::Selection { quote, .. } = &request.context {
                parts.push(format!("The reader has selected this passage: «{quote}»"));
            }
        }
    }
    if let Some(instr) = task_instruction(&request.task, material.map(|m| m.id.as_str())) {
        parts.push(instr);
    }
    let trimmed = request.text.trim();
    if !trimmed.is_empty() {
        parts.push(if request.task == "ask" {
            trimmed.to_string()
        } else {
            format!("The reader adds: {trimmed}")
        });
    }
    parts.join("\n\n")
}

// ---------------------------------------------------------------------------
// Artifact editorial review (matching artifact-review.ts)
// ---------------------------------------------------------------------------

fn count_words(text: &str) -> usize {
    let mut cjk = 0usize;
    let mut rest = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c as u32, 0x3400..=0x9FFF | 0xF900..=0xFAFF) {
            cjk += 1;
            rest.push(' ');
        } else {
            rest.push(c);
        }
    }
    cjk + rest.split_whitespace().count()
}

pub fn review_artifact(artifact_type: &str, title: &str, source: &str, lineage: &[String]) -> Vec<String> {
    let mut notes = Vec::new();
    let generic_title = Regex::new(r"(?i)^(summary|notes?|synthesis|overview|report|analysis|untitled|artifact|document|draft|总结|笔记|摘要|综述|报告|分析|草稿)$").unwrap();
    if generic_title.is_match(title.trim()) {
        notes.push(format!(
            "\"{title}\" is not a title a reader can find again; name the subject, and the finding when there is one."
        ));
    } else if title.chars().count() > 90 {
        notes.push("Shorten the title to under 90 characters; move the detail into the lead.".into());
    }

    if artifact_type == "markdown" {
        let lead_h1 = Regex::new(r"^\s*#\s+[^\n]*\n").unwrap();
        let body = lead_h1.replace(source, "").to_string();
        let split_blocks = Regex::new(r"\n\s*\n").unwrap();
        let blocks: Vec<&str> = split_blocks.split(&body).map(str::trim).filter(|s| !s.is_empty()).collect();
        let heading_re = Regex::new(r"^#{2,6}\s").unwrap();
        let headings: Vec<&&str> = blocks.iter().filter(|b| heading_re.is_match(b)).collect();
        let total = count_words(&body);
        if !headings.is_empty() && blocks.first().is_some_and(|b| Regex::new(r"^#{1,6}\s").unwrap().is_match(b)) {
            notes.push("Open with a lead: one to three sentences under the title that give the answer or the main finding, before the first heading.".into());
        }
        if headings.is_empty() && total > 350 {
            notes.push(format!(
                "It runs {total} words without a heading; break it into sections whose headings state each section's point."
            ));
        }
        let gen_h = Regex::new(r"(?im)^#{2,4}\s+(introduction|conclusions?|summary|overview|background|discussion|final thoughts|key points|引言|简介|结论|总结|概述|背景|讨论|小结)\s*$").unwrap();
        if let Some(cap) = gen_h.captures(&body).and_then(|c| c.get(1)) {
            notes.push(format!(
                "A heading like \"{}\" says nothing; make each heading state its section's point (e.g. \"Rerankers are the largest single gain\").",
                cap.as_str()
            ));
        }
        let ref_h = Regex::new(r"(?im)^#{1,6}\s+(references|sources|bibliography|works cited|citations|参考文献|参考资料|资料来源|来源|引用)\s*$").unwrap();
        if ref_h.is_match(&body) {
            notes.push("Remove the hand-written references section: Quire numbers the citations and appends the Sources list itself.".into());
        }
        let cit_re = Regex::new(r"\[[a-f0-9]{16}(?:\s*[,;]\s*[a-f0-9]{16})*\]").unwrap();
        let citations = cit_re.find_iter(&body).count();
        if !lineage.is_empty() && citations == 0 {
            notes.push("No claim carries a citation: put the exact quote and [material-id] after every claim drawn from a source.".into());
        }
        let quoted_re = Regex::new(r#"["“][^"”\n]{8,}["”]\s*\[[a-f0-9]{16}"#).unwrap();
        let quoted = quoted_re.find_iter(&body).count();
        if citations >= 4 && quoted * 2 < citations {
            notes.push(format!(
                "Only {quoted} of {citations} citations follow an exact quote; quote the words each claim rests on so the reader can jump to them."
            ));
        }
    } else if artifact_type == "html" || artifact_type == "react" {
        let fixed_tw = Regex::new(r"\b(?:bg|text|border|from|to|via|fill|stroke|ring|divide)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b").unwrap();
        let fixed: Vec<String> = fixed_tw.find_iter(source).map(|m| m.as_str().to_string()).take(4).collect();
        if !fixed.is_empty() {
            notes.push(format!(
                "Fixed colours ({}) will not follow the reader's light and dark themes; use {}the --quire-* variables.",
                fixed.join(", "),
                if artifact_type == "react" { "the quire components and chart colours, or " } else { "" }
            ));
        }
        let has_cite = Regex::new(r"quire:material/[a-f0-9]{16}").unwrap().is_match(source)
            || (artifact_type == "react" && Regex::new(r"<Cite\b").unwrap().is_match(source));
        if !lineage.is_empty() && !has_cite {
            notes.push(format!(
                "No claim links to its source; cite with {} so the reader can check it.",
                if artifact_type == "react" {
                    "<Cite id=\"ID\" quote=\"exact words\">"
                } else {
                    "<a href=\"quire:material/ID\" data-quote=\"exact words\">"
                }
            ));
        }
    }
    notes.truncate(6);
    notes
}

// ---------------------------------------------------------------------------
// Dynamic Tools & Per-Turn Executor (matching agent-tools.ts)
// ---------------------------------------------------------------------------

pub fn agent_tools() -> Vec<DynamicTool> {
    let cite = "Cite by writing the material id in square brackets right after the claim or quote it supports, e.g. \"exact words\" [0123456789abcdef]; quote the material's exact words, never paraphrase inside quotation marks, and never print an id bare.";
    let paging = "The result is JSON text: in code, JSON.parse it before reading its fields. Start at offset 0 and pass each result's nextOffset as the next offset; stop when nextOffset is null. A page is answered at most twice per turn, so keep what you read.";
    let artifact_rules = format!(
        "Every artifact but markdown and code runs offline in a sandbox, sized to its content: fetch and remote URLs are blocked, and nothing can be loaded from the web. \
An html artifact is one self-contained document with inline <style> and <script>; it follows the reader's light or dark theme through the CSS variables --quire-bg, --quire-fg, --quire-muted, --quire-accent, --quire-border and --quire-font (use them instead of fixed colours), and may load Quire's own copies of libraries with <script src=\"quire-artifact://runtime/NAME.js\"></script>, NAME one of d3 (window.d3), lodash (window._), mermaid (window.mermaid) or tailwind (Tailwind utility classes). \
The reader shows the artifact's title above it, so do not open an html or react artifact with an <h1> or heading that restates the title; start with the content. \
Quire sets an html artifact's <body> in the reader's column, centred under that title: leave the body's width and margins to Quire, and write <body data-wide> only for a wide table or chart that needs the room. \
A react artifact is one component file (JSX or TSX) that `export default`s its component, which renders with no props; it may import only {RUNTIME_MODULES}, and keeps its state in React (no localStorage). \
Build it from Quire's components so it reads like the rest of the reader: import {{ Page, Lead, Section, Prose, Columns, Card, Callout, Stats, Stat, Figure, Legend, Cite, Quote, DataTable, Tabs, Timeline, Badge, ChartTooltip, chart }} from \"quire\". \
For anything else use Tailwind with the reader's colours (bg-surface, bg-bg, text-fg, text-muted, text-accent, border-line, text-positive, text-negative, bg-chart-1…8), never fixed colours such as bg-white or text-gray-900. \
A mermaid artifact is the diagram's Mermaid source alone, drawn in the reader's theme. \
To cite inside html or react, link the claim: <a href=\"quire:material/ID\" data-quote=\"exact words\">…</a> opens that material at the quote. An svg artifact is one <svg> element with a viewBox, drawn as a static image (no scripts)."
    );

    let id_schema = serde_json::json!({
        "type": "string",
        "pattern": "^[a-f0-9]{16}$",
        "description": "A material id, 16 hex characters, as returned by library_search, library_recent or the conversation."
    });

    vec![
        DynamicTool {
            name: "library_search".into(),
            description: format!("Find materials (title, byline, tags or body text) and inbox items (title, source) containing every word of the query; at most 8 words are used. Use it before claiming the library has or lacks something, and to find ids for material_read. Returns up to 20 hits with id, kind (material or item), title, subtitle, and for materials their materialKind, creators, publication, date, doi and arxivId when known. {cite}"),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": { "query": { "type": "string", "minLength": 1, "maxLength": 200 } },
                "required": ["query"],
                "additionalProperties": false
            }),
        },
        DynamicTool {
            name: "library_recent".into(),
            description: "The newest materials in the library (id, title, kind, creators, publication, date, doi, arxivId, byline, publishedAt, url, readingMinutes, origin). Use it to see what the reader has been reading, or when a question is about the library as a whole.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "How many, default 20." } },
                "additionalProperties": false
            }),
        },
        DynamicTool {
            name: "material_read".into(),
            description: format!("Read a material's text as Markdown (an artifact as its source: Markdown, code, HTML, React, Mermaid or SVG), {PAGE_CHARS} characters per call. {paging} Read before you summarise, verify or quote. {cite}"),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "id": id_schema,
                    "offset": { "type": "integer", "minimum": 0, "description": "Character offset; use the previous call's nextOffset." }
                },
                "required": ["id"],
                "additionalProperties": false
            }),
        },
        DynamicTool {
            name: "material_annotations".into(),
            description: "The reader's own highlights and notes on a material (quote, note, kind, color, createdAt). Use it to learn what the reader marked as important or asked about before answering about the material.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": { "id": id_schema },
                "required": ["id"],
                "additionalProperties": false
            }),
        },
        DynamicTool {
            name: "inbox_list".into(),
            description: "Undecided items from the reader's subscriptions (id, title, sourceTitle, gist, link, publishedAt): what arrived but has not been read, queued or dismissed. Use it for triage questions; read a full item by importing its link with library_import.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "How many, default 20." } },
                "additionalProperties": false
            }),
        },
        DynamicTool {
            name: "library_import".into(),
            description: "Fetch a public http(s) page and add it to the library as a material, returning its id, title and readingMinutes. A page already in the library is not fetched again: it comes back as stored, with existing: true. Use it only when the reader asked for an outside page or an inbox item's full text; then read it with material_read, and cite the new material as [id] after its title.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": { "url": { "type": "string", "minLength": 8, "maxLength": 4096 } },
                "required": ["url"],
                "additionalProperties": false
            }),
        },
        DynamicTool {
            name: "material_source".into(),
            description: format!("The captured raw page of a material as readable text with its structure (blank lines between blocks, # headings, - list items, fenced code, [text](href) links), {PAGE_CHARS} characters per call, navigation and chrome included. Use it for a rebuild when the extracted text is broken. {paging} Only materials fetched with capture on have it."),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "id": id_schema,
                    "offset": { "type": "integer", "minimum": 0, "description": "Character offset; use the previous call's nextOffset." }
                },
                "required": ["id"],
                "additionalProperties": false
            }),
        },
        DynamicTool {
            name: "artifact_write".into(),
            description: format!("Save a document you made into the library as an artifact the reader can open, keep and cite. `type` says what it is: \"markdown\" (the default), \"code\", \"html\", \"react\", \"mermaid\", or \"svg\". {artifact_rules} `sources` must list the id of every material you drew on; only ids you retrieved in this turn or the material the conversation is about are accepted. Returns {{ id, title, type, version }} and optional `review` notes; cite it as [id] after a one-line summary. {cite}"),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "minLength": 1, "maxLength": 200 },
                    "type": { "type": "string", "enum": ARTIFACT_TYPES, "description": "What the artifact is; markdown when omitted." },
                    "language": { "type": "string", "maxLength": 40 },
                    "content": { "type": "string", "minLength": 1, "maxLength": MAX_ARTIFACT_SOURCE },
                    "sources": { "type": "array", "items": id_schema, "minItems": 1, "maxItems": 50, "uniqueItems": true }
                },
                "required": ["title", "content", "sources"],
                "additionalProperties": false
            }),
        },
        DynamicTool {
            name: "artifact_update".into(),
            description: "Edit an artifact you or an earlier turn wrote, without writing it again: replace one exact passage of its source (old_str, which must occur exactly once; copy it from material_read, whitespace included) with new_str. Returns { id, title, type, version }.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "id": id_schema,
                    "old_str": { "type": "string", "minLength": 1, "maxLength": MAX_ARTIFACT_SOURCE },
                    "new_str": { "type": "string", "maxLength": MAX_ARTIFACT_SOURCE },
                    "sources": { "type": "array", "items": id_schema, "maxItems": 50, "uniqueItems": true }
                },
                "required": ["id", "old_str", "new_str"],
                "additionalProperties": false
            }),
        },
        DynamicTool {
            name: "artifact_rewrite".into(),
            description: format!("Replace the whole source of an artifact (same type) when most of it changes; for smaller changes use artifact_update. {artifact_rules} Returns {{ id, title, type, version }}."),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "id": id_schema,
                    "content": { "type": "string", "minLength": 1, "maxLength": MAX_ARTIFACT_SOURCE },
                    "title": { "type": "string", "minLength": 1, "maxLength": 200 },
                    "sources": { "type": "array", "items": id_schema, "maxItems": 50, "uniqueItems": true }
                },
                "required": ["id", "content"],
                "additionalProperties": false
            }),
        },
        DynamicTool {
            name: "transcript_read_raw".into(),
            description: format!("Read the raw unrefined timed cues (`[MM:SS] text`) of a podcast or video material, {PAGE_CHARS} characters per call. {paging} Use this before calling transcript_save_refined."),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "id": id_schema,
                    "offset": { "type": "integer", "minimum": 0, "description": "Character offset; use the previous call's nextOffset." }
                },
                "required": ["id"],
                "additionalProperties": false
            }),
        },
        DynamicTool {
            name: "transcript_save_refined".into(),
            description: "Save a refined, punctuated, speaker-attributed, semantically paragraphed transcript back onto a podcast or video material while preserving its raw cues, timestamps, and highlight anchors. Every paragraph and speaker turn must begin on its own line with a monotonic `[MM:SS]` (or `[H:MM:SS]`) timestamp and optional `**Speaker**: ` label, `## Heading` lines mark topic sections, and total word count must stay within 70%–125% of the raw cues (never summarise).".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "id": id_schema,
                    "markdown": { "type": "string", "minLength": 1, "maxLength": MAX_ARTIFACT_SOURCE }
                },
                "required": ["id", "markdown"],
                "additionalProperties": false
            }),
        },
    ]
}

fn quote_of(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() > 40 {
        format!("\"{}…\"", chars[..39].iter().collect::<String>())
    } else {
        format!("\"{s}\"")
    }
}

fn page_slice(content: &str, offset: usize) -> Result<serde_json::Value, String> {
    let chars: Vec<char> = content.chars().collect();
    if offset > chars.len() {
        return Err(format!("Offset {offset} is past the end of the text ({} characters).", chars.len()));
    }
    let end = chars.len().min(offset + PAGE_CHARS);
    let slice: String = chars[offset..end].iter().collect();
    let next_offset = if end < chars.len() {
        serde_json::Value::Number(serde_json::Number::from(end))
    } else {
        serde_json::Value::Null
    };
    Ok(serde_json::json!({
        "content": slice,
        "offset": offset,
        "nextOffset": next_offset,
        "totalCharacters": chars.len(),
    }))
}

fn bib_fields(mat: Option<&MaterialRecord>, as_material_kind: bool) -> serde_json::Map<String, serde_json::Value> {
    let mut m = serde_json::Map::new();
    let Some(mat) = mat else { return m };
    let key_name = if as_material_kind { "materialKind" } else { "kind" };
    m.insert(key_name.into(), serde_json::Value::String(mat.kind.clone()));
    if let Some(ref c) = mat.meta.creators {
        if !c.is_empty() {
            let names: Vec<String> = c.iter().map(|x| x.name.clone()).collect();
            m.insert("creators".into(), serde_json::to_value(names).unwrap());
        }
    }
    if let Some(ref p) = mat.meta.publication {
        m.insert("publication".into(), serde_json::Value::String(p.clone()));
    }
    if let Some(ref d) = mat.meta.date {
        m.insert("date".into(), serde_json::Value::String(d.clone()));
    }
    if let Some(ref d) = mat.meta.doi {
        m.insert("doi".into(), serde_json::Value::String(d.clone()));
    }
    if let Some(ref a) = mat.meta.arxiv_id {
        m.insert("arxivId".into(), serde_json::Value::String(a.clone()));
    }
    m
}

fn read_key(tool: &str, raw: &serde_json::Value) -> Option<String> {
    if !matches!(
        tool,
        "library_search"
            | "library_recent"
            | "material_read"
            | "material_source"
            | "transcript_read_raw"
            | "material_annotations"
            | "inbox_list"
    ) {
        return None;
    }
    let obj = raw.as_object()?;
    let mut cloned = obj.clone();
    if (tool == "material_read" || tool == "material_source" || tool == "transcript_read_raw")
        && !cloned.contains_key("offset")
    {
        cloned.insert("offset".into(), serde_json::json!(0));
    }
    let mut keys: Vec<&String> = cloned.keys().collect();
    keys.sort();
    let pairs: Vec<(&String, &serde_json::Value)> = keys.into_iter().map(|k| (k, &cloned[k])).collect();
    Some(format!("{tool} {}", serde_json::to_string(&pairs).unwrap_or_default()))
}

struct TurnExecutorState {
    calls: usize,
    reads: HashMap<String, usize>,
}

struct TurnExecutionContext {
    seen: Mutex<HashSet<String>>,
    guard_state: Mutex<TurnExecutorState>,
    exec_lock: tokio::sync::Mutex<Option<(String, String)>>, // holds CaptureCache (id, text)
    store: Arc<MaterialStore>,
    items: ItemStore,
    annotations: AnnotationStore,
    images: ImageCache,
    on_library_changed: Arc<dyn Fn() + Send + Sync>,
}

impl TurnExecutionContext {
    fn check_guard(&self, call: &ToolCall) -> Option<ToolReply> {
        let mut st = self.guard_state.lock().unwrap();
        st.calls += 1;
        if st.calls > CALL_LIMIT {
            let stop = if st.calls >= CALL_STOP {
                Some(format!(
                    "The agent made {CALL_STOP} tool calls in one turn and was stopped. Ask again with a narrower request."
                ))
            } else {
                None
            };
            let err = format!(
                "This turn has made {} tool calls; at most {CALL_LIMIT} are answered. Stop calling tools and answer with what you have.",
                st.calls
            );
            return Some(ToolReply {
                success: false,
                text: serde_json::json!({ "ok": false, "error": err }).to_string(),
                summary: Some(format!("{} refused: too many tool calls in this turn", call.tool)),
                stop_turn: stop,
            });
        }
        let key = read_key(&call.tool, &call.arguments)?;
        let count = st.reads.entry(key).or_insert(0);
        *count += 1;
        if *count <= REPEAT_LIMIT {
            return None;
        }
        let stop = if *count >= REPEAT_STOP {
            Some(format!(
                "The agent called {} with the same arguments {} times without making progress and was stopped.",
                call.tool, *count
            ))
        } else {
            None
        };
        let err = format!(
            "{} was already answered {REPEAT_LIMIT} times with these exact arguments in this turn, and the answer has not changed. Use the result you have.",
            call.tool
        );
        Some(ToolReply {
            success: false,
            text: serde_json::json!({ "ok": false, "error": err }).to_string(),
            summary: Some(format!("{} refused: repeated with the same arguments", call.tool)),
            stop_turn: stop,
        })
    }

    async fn execute_one(&self, call: ToolCall) -> Result<(serde_json::Value, String), (bool, String)> {
        let arg_err = |m: String| (true, m);
        let run_err = |m: String| (false, m);
        let check_obj = |allowed: &[&str]| -> Result<serde_json::Map<String, serde_json::Value>, (bool, String)> {
            let obj = call
                .arguments
                .as_object()
                .ok_or_else(|| arg_err("Arguments must be a JSON object.".into()))?;
            let extra: Vec<&str> = obj
                .keys()
                .map(String::as_str)
                .filter(|k| !allowed.contains(k))
                .collect();
            if !extra.is_empty() {
                return Err(arg_err(format!(
                    "Unknown argument(s): {}. Allowed: {}.",
                    extra.join(", "),
                    allowed.join(", ")
                )));
            }
            Ok(obj.clone())
        };
        let check_text = |obj: &serde_json::Map<String, serde_json::Value>, key: &str, max: usize| -> Result<String, (bool, String)> {
            let s = obj
                .get(key)
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| arg_err(format!("\"{key}\" must be a non-empty string.")))?;
            if s.chars().count() > max {
                return Err(arg_err(format!("\"{key}\" is longer than {max} characters.")));
            }
            Ok(s.to_string())
        };
        let check_id = |obj: &serde_json::Map<String, serde_json::Value>, key: &str| -> Result<String, (bool, String)> {
            let s = obj
                .get(key)
                .and_then(|v| v.as_str())
                .filter(|s| valid_hex_16(s))
                .ok_or_else(|| arg_err(format!("\"{key}\" must be a 16-character hex material id.")))?;
            Ok(s.to_string())
        };

        let mut cache_guard = self.exec_lock.lock().await;

        match call.tool.as_str() {
            "library_search" => {
                let args = check_obj(&["query"])?;
                let query = check_text(&args, "query", 200)?;
                let mat_hits = self.store.search(&query).map_err(run_err)?;
                let item_hits = self.items.search(&query).map_err(run_err)?;
                let merged = search_hits(&query, &mat_hits, &item_hits);
                let mut hits_json = Vec::new();
                for hit in merged.into_iter().take(20) {
                    let mut val = serde_json::to_value(&hit).unwrap();
                    if hit.kind == "material" {
                        self.seen.lock().unwrap().insert(hit.id.clone());
                        if let Ok(Some(rec)) = self.store.get(&hit.id) {
                            if let Some(m) = val.as_object_mut() {
                                for (k, v) in bib_fields(Some(&rec), true) {
                                    m.insert(k, v);
                                }
                            }
                        }
                    }
                    hits_json.push(val);
                }
                let count = hits_json.len();
                let total_words = query.split_whitespace().count();
                let mut out = serde_json::json!({ "hits": hits_json });
                if total_words > 8 {
                    out["note"] = serde_json::Value::String("Only the first 8 words of the query were used.".into());
                }
                Ok((
                    out,
                    format!(
                        "library_search {} → {count} hit{}",
                        quote_of(&query),
                        if count == 1 { "" } else { "s" }
                    ),
                ))
            }
            "library_recent" => {
                let args = check_obj(&["limit"])?;
                let limit = match args.get("limit") {
                    None => 20usize,
                    Some(v) => {
                        let n = v
                            .as_u64()
                            .filter(|&n| (1..=100).contains(&n))
                            .ok_or_else(|| arg_err("\"limit\" must be an integer between 1 and 100.".into()))?;
                        n as usize
                    }
                };
                let list = self.store.list().map_err(run_err)?;
                let mut materials = Vec::new();
                for summary in list.into_iter().take(limit) {
                    self.seen.lock().unwrap().insert(summary.id.clone());
                    let rec = self.store.get(&summary.id).ok().flatten();
                    let mut m = serde_json::Map::new();
                    m.insert("id".into(), serde_json::json!(summary.id));
                    m.insert("title".into(), serde_json::json!(summary.title));
                    m.insert("url".into(), serde_json::json!(summary.url));
                    m.insert("readingMinutes".into(), serde_json::json!(summary.reading_minutes));
                    m.insert("origin".into(), serde_json::json!(summary.origin));
                    m.insert("kind".into(), serde_json::json!(summary.kind));
                    if let Some(b) = summary.byline {
                        m.insert("byline".into(), serde_json::json!(b));
                    }
                    if let Some(p) = summary.published_at {
                        m.insert("publishedAt".into(), serde_json::json!(p));
                    }
                    for (k, v) in bib_fields(rec.as_ref(), false) {
                        m.insert(k, v);
                    }
                    materials.push(serde_json::Value::Object(m));
                }
                let count = materials.len();
                Ok((
                    serde_json::json!({ "materials": materials }),
                    format!("library_recent → {count} material{}", if count == 1 { "" } else { "s" }),
                ))
            }
            "material_read" => {
                let args = check_obj(&["id", "offset"])?;
                let id = check_id(&args, "id")?;
                let offset = match args.get("offset") {
                    None => 0usize,
                    Some(v) => v
                        .as_u64()
                        .ok_or_else(|| arg_err("\"offset\" must be a non-negative integer.".into()))? as usize,
                };
                let mat = self
                    .store
                    .get(&id)
                    .map_err(run_err)?
                    .ok_or_else(|| run_err(format!("Material {id} is not in the library. Find ids with library_search or library_recent.")))?;
                let content = mat
                    .artifact_source
                    .as_deref()
                    .or(mat.markdown.as_deref())
                    .or(mat.plain.as_deref())
                    .ok_or_else(|| run_err(format!("Material {id} ({}) has no text to read; it is probably a scanned PDF.", mat.title)))?;
                self.seen.lock().unwrap().insert(id.clone());
                let paged = page_slice(content, offset).map_err(run_err)?;
                let mut out = serde_json::Map::new();
                out.insert("id".into(), serde_json::json!(id));
                out.insert("title".into(), serde_json::json!(mat.title));
                if let Some(ref b) = mat.byline {
                    out.insert("byline".into(), serde_json::json!(b));
                }
                out.insert("url".into(), serde_json::json!(mat.url));
                for (k, v) in bib_fields(Some(&mat), false) {
                    out.insert(k, v);
                }
                if let Some(po) = paged.as_object() {
                    for (k, v) in po {
                        out.insert(k.clone(), v.clone());
                    }
                }
                Ok((
                    serde_json::Value::Object(out),
                    format!("material_read {id} @{offset} → {}", quote_of(&mat.title)),
                ))
            }
            "material_source" => {
                let args = check_obj(&["id", "offset"])?;
                let id = check_id(&args, "id")?;
                let offset = match args.get("offset") {
                    None => 0usize,
                    Some(v) => v
                        .as_u64()
                        .ok_or_else(|| arg_err("\"offset\" must be a non-negative integer.".into()))? as usize,
                };
                let mat = self
                    .store
                    .get(&id)
                    .map_err(run_err)?
                    .ok_or_else(|| run_err(format!("Material {id} is not in the library. Find ids with library_search or library_recent.")))?;
                if mat.capture.is_none() {
                    return Err(run_err(format!(
                        "Material {id} ({}) has no captured page: it was fetched with capture off, dropped as a file, or is a PDF or an artifact. There is nothing to rebuild from; read it with material_read instead.",
                        mat.title
                    )));
                }
                self.seen.lock().unwrap().insert(id.clone());
                let text = if let Some((ref cid, ref ctext)) = *cache_guard {
                    if cid == &id {
                        ctext.clone()
                    } else {
                        let t = self
                            .store
                            .capture_text(&id)
                            .await
                            .map_err(run_err)?
                            .ok_or_else(|| run_err(format!("Material {id} ({}) has a capture record but its page file is missing.", mat.title)))?;
                        *cache_guard = Some((id.clone(), t.clone()));
                        t
                    }
                } else {
                    let t = self
                        .store
                        .capture_text(&id)
                        .await
                        .map_err(run_err)?
                        .ok_or_else(|| run_err(format!("Material {id} ({}) has a capture record but its page file is missing.", mat.title)))?;
                    *cache_guard = Some((id.clone(), t.clone()));
                    t
                };
                let paged = page_slice(&text, offset).map_err(run_err)?;
                let mut out = serde_json::Map::new();
                out.insert("id".into(), serde_json::json!(id));
                out.insert("title".into(), serde_json::json!(mat.title));
                out.insert("url".into(), serde_json::json!(mat.url));
                if let Some(po) = paged.as_object() {
                    for (k, v) in po {
                        out.insert(k.clone(), v.clone());
                    }
                }
                Ok((
                    serde_json::Value::Object(out),
                    format!("material_source {id} @{offset} → {}", quote_of(&mat.title)),
                ))
            }
            "material_annotations" => {
                let args = check_obj(&["id"])?;
                let id = check_id(&args, "id")?;
                if !self.store.has(&id) {
                    return Err(run_err(format!("Material {id} is not in the library.")));
                }
                self.seen.lock().unwrap().insert(id.clone());
                let list = self.annotations.list(&id).map_err(run_err)?;
                let mapped: Vec<serde_json::Value> = list
                    .into_iter()
                    .map(|a| {
                        let mut m = serde_json::Map::new();
                        m.insert("quote".into(), serde_json::json!(a.quote));
                        m.insert("kind".into(), serde_json::json!(a.kind));
                        m.insert("color".into(), serde_json::json!(a.color));
                        m.insert("createdAt".into(), serde_json::json!(a.created_at));
                        if let Some(n) = a.note {
                            m.insert("note".into(), serde_json::json!(n));
                        }
                        serde_json::Value::Object(m)
                    })
                    .collect();
                let count = mapped.len();
                Ok((
                    serde_json::json!({ "annotations": mapped }),
                    format!("material_annotations {id} → {count}"),
                ))
            }
            "inbox_list" => {
                let args = check_obj(&["limit"])?;
                let limit = match args.get("limit") {
                    None => 20usize,
                    Some(v) => {
                        let n = v
                            .as_u64()
                            .filter(|&n| (1..=100).contains(&n))
                            .ok_or_else(|| arg_err("\"limit\" must be an integer between 1 and 100.".into()))?;
                        n as usize
                    }
                };
                let items: Vec<serde_json::Value> = self
                    .items
                    .inbox()
                    .map_err(run_err)?
                    .into_iter()
                    .take(limit)
                    .map(|i| {
                        serde_json::json!({
                            "id": i.id,
                            "title": i.title,
                            "sourceTitle": i.source_title,
                            "gist": i.gist,
                            "link": i.link,
                            "publishedAt": i.published_at,
                        })
                    })
                    .collect();
                let count = items.len();
                Ok((
                    serde_json::json!({ "items": items }),
                    format!("inbox_list → {count} item{}", if count == 1 { "" } else { "s" }),
                ))
            }
            "library_import" => {
                let args = check_obj(&["url"])?;
                let url = check_text(&args, "url", 4096)?;
                match self.store.open_url(&url, "web", None).await {
                    OpenUrlResult::Ok { material, existing, .. } => {
                        self.seen.lock().unwrap().insert(material.id.clone());
                        if existing == Some(true) {
                            return Ok((
                                serde_json::json!({
                                    "id": material.id,
                                    "title": material.title,
                                    "readingMinutes": material.reading_minutes,
                                    "existing": true,
                                }),
                                format!("library_import → {} (already in the library)", quote_of(&material.title)),
                            ));
                        }
                        let urls = image_urls_of_record(&material);
                        let cache = self.images.clone();
                        tokio::spawn(async move {
                            let _ = cache.prefetch(urls, 3).await;
                        });
                        (self.on_library_changed)();
                        Ok((
                            serde_json::json!({
                                "id": material.id,
                                "title": material.title,
                                "readingMinutes": material.reading_minutes,
                            }),
                            format!("library_import → {}", quote_of(&material.title)),
                        ))
                    }
                    OpenUrlResult::Err { code, message, .. } => {
                        Err(run_err(format!("Could not import {url}: {message} ({code})")))
                    }
                }
            }
            "artifact_write" => {
                let args = check_obj(&["title", "type", "language", "content", "markdown", "sources"])?;
                let title = check_text(&args, "title", 200)?;
                let content_key = if !args.contains_key("content") && args.contains_key("markdown") {
                    "markdown"
                } else {
                    "content"
                };
                let source = check_text(&args, content_key, MAX_ARTIFACT_SOURCE)?;
                let art_type = args
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("markdown")
                    .to_string();
                if !ARTIFACT_TYPES.contains(&art_type.as_str()) {
                    return Err(arg_err(format!("\"type\" must be one of {}.", ARTIFACT_TYPES.join(", "))));
                }
                let language = if args.contains_key("language") {
                    Some(check_text(&args, "language", 40)?)
                } else {
                    None
                };
                let sources = self.check_sources(args.get("sources"), 1, &arg_err, &run_err)?;
                let saved = self
                    .store
                    .save_artifact(SaveArtifactInput {
                        title,
                        artifact_type: Some(art_type),
                        source: Some(source),
                        markdown: None,
                        language,
                        lineage: sources,
                    })
                    .await
                    .map_err(run_err)?;
                self.seen.lock().unwrap().insert(saved.id.clone());
                (self.on_library_changed)();
                Ok((
                    artifact_tool_value(&saved),
                    format!("artifact_write {} → {}", quote_of(&saved.title), saved.id),
                ))
            }
            "artifact_update" | "artifact_rewrite" => {
                let is_update = call.tool == "artifact_update";
                let args = if is_update {
                    check_obj(&["id", "old_str", "new_str", "sources"])?
                } else {
                    check_obj(&["id", "content", "title", "sources"])?
                };
                let id = check_id(&args, "id")?;
                let sources = match args.get("sources") {
                    Some(v) => Some(self.check_sources(Some(v), 0, &arg_err, &run_err)?),
                    None => None,
                };
                let change = if is_update {
                    let old_str = check_text(&args, "old_str", MAX_ARTIFACT_SOURCE)?;
                    let new_str = args
                        .get("new_str")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| arg_err(format!("\"new_str\" must be a string of at most {MAX_ARTIFACT_SOURCE} characters.")))?;
                    if new_str.chars().count() > MAX_ARTIFACT_SOURCE {
                        return Err(arg_err(format!(
                            "\"new_str\" must be a string of at most {MAX_ARTIFACT_SOURCE} characters."
                        )));
                    }
                    UpdateArtifactChange {
                        source: None,
                        edit: Some((old_str, new_str.to_string())),
                        title: None,
                        lineage: sources,
                    }
                } else {
                    let content = check_text(&args, "content", MAX_ARTIFACT_SOURCE)?;
                    let title = if args.contains_key("title") {
                        Some(check_text(&args, "title", 200)?)
                    } else {
                        None
                    };
                    UpdateArtifactChange {
                        source: Some(content),
                        edit: None,
                        title,
                        lineage: sources,
                    }
                };
                let saved = self.store.update_artifact(&id, change).await.map_err(run_err)?;
                self.seen.lock().unwrap().insert(saved.id.clone());
                (self.on_library_changed)();
                let ver = saved.artifact.as_ref().map(|a| a.version).unwrap_or(1);
                Ok((
                    artifact_tool_value(&saved),
                    format!("{} {} → {} v{ver}", call.tool, quote_of(&saved.title), saved.id),
                ))
            }
            "transcript_read_raw" => {
                let args = check_obj(&["id", "offset"])?;
                let id = check_id(&args, "id")?;
                let offset = match args.get("offset") {
                    None => 0usize,
                    Some(v) => v
                        .as_u64()
                        .ok_or_else(|| arg_err("\"offset\" must be a non-negative integer.".into()))? as usize,
                };
                let mat = self
                    .store
                    .get(&id)
                    .map_err(run_err)?
                    .ok_or_else(|| run_err(format!("Material {id} is not in the library.")))?;
                let raw_cues = self
                    .store
                    .read_raw_transcript(&id)
                    .map_err(run_err)?
                    .ok_or_else(|| run_err(format!("Material {id} ({}) has no raw transcript cues stored.", mat.title)))?;
                self.seen.lock().unwrap().insert(id.clone());
                let formatted = raw_cues
                    .iter()
                    .map(|c| {
                        let clock = crate::youtube::format_clock(c.start_sec);
                        match &c.speaker {
                            Some(sp) if !sp.trim().is_empty() => format!("[{clock}] {}: {}", sp.trim(), c.text),
                            _ => format!("[{clock}] {}", c.text),
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let paged = page_slice(&formatted, offset).map_err(run_err)?;
                let mut out = serde_json::Map::new();
                out.insert("id".into(), serde_json::json!(id));
                out.insert("title".into(), serde_json::json!(mat.title));
                if let Some(ref b) = mat.byline {
                    out.insert("byline".into(), serde_json::json!(b));
                }
                if let Some(ref pub_name) = mat.publication {
                    out.insert("publication".into(), serde_json::json!(pub_name));
                }
                out.insert("cueCount".into(), serde_json::json!(raw_cues.len()));
                if offset == 0 {
                    if let Ok(Some(notes_view)) = self.store.get_view(&id, "shownotes") {
                        if let Some(notes_txt) = notes_view.markdown.or(notes_view.plain) {
                            let snippet: String = notes_txt.chars().take(6000).collect();
                            if !snippet.trim().is_empty() {
                                out.insert("showNotes".into(), serde_json::json!(snippet));
                            }
                        }
                    }
                }
                if let Some(po) = paged.as_object() {
                    for (k, v) in po {
                        out.insert(k.clone(), v.clone());
                    }
                }
                Ok((
                    serde_json::Value::Object(out),
                    format!("transcript_read_raw {id} @{offset} → {} cues", raw_cues.len()),
                ))
            }
            "transcript_save_refined" => {
                let args = check_obj(&["id", "markdown"])?;
                let id = check_id(&args, "id")?;
                let markdown = check_text(&args, "markdown", MAX_ARTIFACT_SOURCE)?;
                let updated = self
                    .store
                    .refine_material_transcript(&id, &markdown)
                    .await
                    .map_err(run_err)?;
                self.seen.lock().unwrap().insert(updated.id.clone());
                (self.on_library_changed)();
                let para_count = updated.time_anchors.as_ref().map(|a| a.len()).unwrap_or(0);
                Ok((
                    serde_json::json!({
                        "id": updated.id,
                        "title": updated.title,
                        "paragraphs": para_count,
                        "transcriptOrigin": "agent_refined",
                    }),
                    format!("transcript_save_refined {} → {para_count} paragraphs", quote_of(&updated.title)),
                ))
            }
            other => Err(run_err(format!("Unknown tool {other}."))),
        }
    }

    fn check_sources(
        &self,
        raw: Option<&serde_json::Value>,
        min: usize,
        arg_err: &dyn Fn(String) -> (bool, String),
        run_err: &dyn Fn(String) -> (bool, String),
    ) -> Result<Vec<String>, (bool, String)> {
        let arr = raw
            .and_then(|v| v.as_array())
            .ok_or_else(|| arg_err(format!("\"sources\" must be {min} to 50 material ids.")))?;
        if arr.len() < min || arr.len() > 50 {
            return Err(arg_err(format!("\"sources\" must be {min} to 50 material ids.")));
        }
        let mut ids = Vec::with_capacity(arr.len());
        for item in arr {
            let id = item
                .as_str()
                .filter(|s| valid_hex_16(s))
                .ok_or_else(|| arg_err(format!("\"sources\" must be {min} to 50 material ids.")))?;
            ids.push(id.to_string());
        }
        let seen = self.seen.lock().unwrap();
        let unseen: Vec<&str> = ids.iter().map(String::as_str).filter(|id| !seen.contains(*id)).collect();
        if !unseen.is_empty() {
            return Err(run_err(format!(
                "These sources were not retrieved during this turn, so they cannot be cited: {}. Read them with material_read (or find them with library_search) first.",
                unseen.join(", ")
            )));
        }
        Ok(ids)
    }
}

fn artifact_tool_value(saved: &MaterialRecord) -> serde_json::Value {
    let art_type = saved
        .artifact
        .as_ref()
        .map(|a| a.artifact_type.as_str())
        .unwrap_or("markdown");
    let version = saved.artifact.as_ref().map(|a| a.version).unwrap_or(1);
    let src = saved
        .artifact_source
        .as_deref()
        .or(saved.markdown.as_deref())
        .unwrap_or("");
    let review = review_artifact(
        art_type,
        &saved.title,
        src,
        saved.lineage.as_deref().unwrap_or(&[]),
    );
    let mut out = serde_json::json!({
        "id": saved.id,
        "title": saved.title,
        "type": art_type,
        "version": version,
    });
    if !review.is_empty() {
        out["review"] = serde_json::to_value(review).unwrap();
        out["next"] = serde_json::Value::String(
            "The artifact is saved. Fix the review notes that apply with artifact_update (one pass), then reply.".into(),
        );
    }
    out
}

// ---------------------------------------------------------------------------
// Tool progress row folding (matching shared/agent-tool-rows.ts)
// ---------------------------------------------------------------------------

pub fn apply_tool_progress(rows: &[AgentToolRow], progress: &ToolProgress) -> Vec<AgentToolRow> {
    if progress.status == "running" {
        let mut next = rows.to_vec();
        next.push(AgentToolRow {
            name: progress.tool.clone(),
            status: "running".into(),
            summary: None,
            count: None,
        });
        return next;
    }
    let settled = AgentToolRow {
        name: progress.tool.clone(),
        status: progress.status.clone(),
        summary: progress.summary.clone(),
        count: None,
    };
    let running_idx = rows
        .iter()
        .rposition(|r| r.name == progress.tool && r.status == "running");
    let search_end = running_idx.unwrap_or(rows.len());
    let before_idx = rows[..search_end].iter().rposition(|r| r.status != "running");
    if let Some(bi) = before_idx {
        let b = &rows[bi];
        let same = b.name == settled.name
            && b.status == settled.status
            && b.summary.as_deref().unwrap_or("") == settled.summary.as_deref().unwrap_or("");
        let only_running_between = running_idx
            .is_none_or(|ri| rows[bi + 1..ri].iter().all(|r| r.status == "running"));
        if same && only_running_between {
            let mut folded = settled;
            folded.count = Some(b.count.unwrap_or(1) + 1);
            return rows
                .iter()
                .enumerate()
                .filter_map(|(i, r)| {
                    if i == bi {
                        Some(folded.clone())
                    } else if Some(i) == running_idx {
                        None
                    } else {
                        Some(r.clone())
                    }
                })
                .collect();
        }
    }
    if let Some(ri) = running_idx {
        let mut next = rows.to_vec();
        next[ri] = settled;
        next
    } else {
        let mut next = rows.to_vec();
        next.push(settled);
        next
    }
}

// ---------------------------------------------------------------------------
// AgentService
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct ActiveRun {
    key: u64,
    session_id: String,
    turn_id: Option<String>,
    thread_id: Option<String>,
    task: String,
    prompt: String,
    answer: String,
    tools: Vec<AgentToolRow>,
    started_at: String,
    interrupt_requested: bool,
}

fn account_label(acc: &CodexAccount) -> String {
    if acc.account_type == "chatgpt" {
        if let Some(ref email) = acc.email {
            if !email.is_empty() {
                return email.clone();
            }
        }
        if let Some(ref plan) = acc.plan_type {
            if !plan.is_empty() {
                return format!("ChatGPT {plan}");
            }
        }
        return "ChatGPT".into();
    }
    if acc.account_type == "apiKey" {
        return "API key".into();
    }
    acc.account_type.clone()
}

pub struct AgentService {
    client: Arc<CodexClient>,
    store: Arc<MaterialStore>,
    sessions: SessionStore,
    items: ItemStore,
    annotations: AnnotationStore,
    images: ImageCache,
    user_data: PathBuf,
    settings_fn: Arc<dyn Fn() -> (String, String) + Send + Sync>,
    on_event: Arc<dyn Fn(AgentEvent) + Send + Sync>,
    on_sessions_changed: Arc<dyn Fn() + Send + Sync>,
    on_library_changed: Arc<dyn Fn() + Send + Sync>,
    open_external: Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
    runs: Mutex<HashMap<String, ActiveRun>>,
    next_key: Mutex<u64>,
}

impl AgentService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        client: Arc<CodexClient>,
        store: Arc<MaterialStore>,
        sessions: SessionStore,
        items: ItemStore,
        annotations: AnnotationStore,
        images: ImageCache,
        user_data: impl Into<PathBuf>,
        settings_fn: Arc<dyn Fn() -> (String, String) + Send + Sync>,
        on_event: Arc<dyn Fn(AgentEvent) + Send + Sync>,
        on_sessions_changed: Arc<dyn Fn() + Send + Sync>,
        on_library_changed: Arc<dyn Fn() + Send + Sync>,
        open_external: Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
    ) -> Self {
        Self {
            client,
            store,
            sessions,
            items,
            annotations,
            images,
            user_data: user_data.into(),
            settings_fn,
            on_event,
            on_sessions_changed,
            on_library_changed,
            open_external,
            runs: Mutex::new(HashMap::new()),
            next_key: Mutex::new(1),
        }
    }

    pub async fn status(&self) -> AgentStatus {
        let running = self.runs.lock().map(|r| r.len() as u32).unwrap_or(0);
        let version = match self.client.version().await {
            Ok(v) => v,
            Err(e) => {
                return AgentStatus {
                    available: false,
                    version: None,
                    account: None,
                    reason: Some(e.message),
                    running,
                }
            }
        };
        match self.client.status_account().await {
            Ok(Some(acc)) => AgentStatus {
                available: true,
                version: Some(version),
                account: Some(account_label(&acc)),
                reason: None,
                running,
            },
            Ok(None) => AgentStatus {
                available: true,
                version: Some(version),
                account: None,
                reason: Some("Sign in to ChatGPT to use the agent.".into()),
                running,
            },
            Err(e) => {
                let is_init = e.code.starts_with("APP_SERVER");
                AgentStatus {
                    available: !is_init,
                    version: Some(version),
                    account: None,
                    reason: Some(if is_init {
                        format!("codex app-server did not start: {}", e.message)
                    } else {
                        format!("Could not read the account: {}", e.message)
                    }),
                    running,
                }
            }
        }
    }

    pub async fn login(&self) -> AgentStatus {
        let outcome: Result<(), String> = async {
            let auth_url = self.client.login().await.map_err(|e| e.message)?;
            if !auth_url.starts_with("https://") {
                return Err("Refusing to open a non-https login URL.".into());
            }
            (self.open_external)(&auth_url)?;
            self.client.wait_for_account().await.map_err(|e| e.message)?;
            Ok(())
        }
        .await;
        let mut st = self.status().await;
        if let Err(reason) = outcome {
            st.reason = Some(reason);
        }
        st
    }

    pub async fn ask(self: &Arc<Self>, request: AgentRequest) -> AgentResult {
        let material = match &request.context {
            AgentContext::Library => None,
            AgentContext::Material { material_id } | AgentContext::Selection { material_id, .. } => {
                match self.store.get(material_id) {
                    Ok(Some(m)) => Some(m),
                    _ => {
                        return AgentResult::Err {
                            ok: false,
                            code: "TURN_FAILED".into(),
                            message: format!("Material {material_id} is not in the library."),
                        }
                    }
                }
            }
        };

        if let Some(ref sid) = request.session_id {
            if self.runs.lock().unwrap().contains_key(sid) {
                return AgentResult::Err {
                    ok: false,
                    code: "TURN_RUNNING".into(),
                    message: "The agent is still answering in this conversation; wait for it or stop it.".into(),
                };
            }
        }

        let session = match &request.session_id {
            Some(sid) => match self.sessions.get(sid) {
                Ok(Some(s)) => s,
                _ => {
                    return AgentResult::Err {
                        ok: false,
                        code: "TURN_FAILED".into(),
                        message: format!("Session {sid} no longer exists; start a new one."),
                    }
                }
            },
            None => {
                let title = session_title_for(&request.task, &request.text, material.as_ref().map(|m| m.title.as_str()));
                match self.sessions.create(&request.context, &title) {
                    Ok(s) => s,
                    Err(msg) => {
                        return AgentResult::Err {
                            ok: false,
                            code: "TURN_FAILED".into(),
                            message: msg,
                        }
                    }
                }
            }
        };

        let library = self.store.list().unwrap_or_default();
        let prompt = build_prompt(&request, &library, material.as_ref());
        let cwd = self.user_data.join("agent");
        let _ = fs::create_dir_all(&cwd);

        let key = {
            let mut runs = self.runs.lock().unwrap();
            if runs.contains_key(&session.id) {
                return AgentResult::Err {
                    ok: false,
                    code: "TURN_RUNNING".into(),
                    message: "The agent is still answering in this conversation; wait for it or stop it.".into(),
                };
            }
            let mut nk = self.next_key.lock().unwrap();
            let k = *nk;
            *nk += 1;
            runs.insert(
                session.id.clone(),
                ActiveRun {
                    key: k,
                    session_id: session.id.clone(),
                    turn_id: None,
                    thread_id: None,
                    task: request.task.clone(),
                    prompt: prompt.clone(),
                    answer: String::new(),
                    tools: Vec::new(),
                    started_at: now_iso(),
                    interrupt_requested: false,
                },
            );
            k
        };

        let _ = self.sessions.append_turn(
            &session.id,
            TurnInput {
                role: "user".into(),
                text: request.text.clone(),
                task: Some(request.task.clone()),
                tools: None,
                sources: None,
                status: None,
            },
        );
        (self.on_sessions_changed)();

        let mut seed = HashSet::new();
        if let Some(ref m) = material {
            seed.insert(m.id.clone());
        }
        let exec_ctx = Arc::new(TurnExecutionContext {
            seen: Mutex::new(seed),
            guard_state: Mutex::new(TurnExecutorState {
                calls: 0,
                reads: HashMap::new(),
            }),
            exec_lock: tokio::sync::Mutex::new(None),
            store: self.store.clone(),
            items: self.items.clone(),
            annotations: self.annotations.clone(),
            images: self.images.clone(),
            on_library_changed: self.on_library_changed.clone(),
        });

        let exec_for_handler = exec_ctx.clone();
        let on_tool_call: ToolCallHandler = Arc::new(move |call: ToolCall| {
            let ctx = exec_for_handler.clone();
            Box::pin(async move {
                if let Some(refused) = ctx.check_guard(&call) {
                    return refused;
                }
                let tool_name = call.tool.clone();
                match ctx.execute_one(call).await {
                    Ok((mut val, summary)) => {
                        if let Some(obj) = val.as_object_mut() {
                            obj.insert("ok".into(), serde_json::Value::Bool(true));
                        }
                        ToolReply {
                            success: true,
                            text: val.to_string(),
                            summary: Some(summary),
                            stop_turn: None,
                        }
                    }
                    Err((is_arg, msg)) => {
                        let prefix = if is_arg { "Invalid arguments: " } else { "" };
                        ToolReply {
                            success: false,
                            text: serde_json::json!({ "ok": false, "error": format!("{prefix}{msg}") }).to_string(),
                            summary: Some(format!("{tool_name} failed: {msg}")),
                            stop_turn: None,
                        }
                    }
                }
            })
        });

        let (settle_tx, settle_rx) = oneshot::channel::<AgentResult>();
        let settle_slot = Arc::new(Mutex::new(Some(settle_tx)));

        let (model, effort) = (self.settings_fn)();
        let thread_id = request.thread_id.clone().or(session.thread_id.clone());
        let session_id = session.id.clone();

        let svc_started = self.clone();
        let sid_started = session_id.clone();
        let settle_started = settle_slot.clone();
        let on_started = Box::new(move |tid: String, turn_id: String| {
            let mut intr = false;
            if let Ok(mut runs) = svc_started.runs.lock() {
                if let Some(r) = runs.get_mut(&sid_started) {
                    if r.key == key {
                        r.thread_id = Some(tid.clone());
                        r.turn_id = Some(turn_id.clone());
                        intr = r.interrupt_requested;
                    }
                }
            }
            (svc_started.on_event)(AgentEvent::Started {
                session_id: sid_started.clone(),
                thread_id: tid.clone(),
                turn_id: turn_id.clone(),
            });
            if intr {
                let c = svc_started.client.clone();
                tokio::spawn(async move {
                    let _ = c.interrupt(&tid).await;
                });
            }
            if let Ok(mut slot) = settle_started.lock() {
                if let Some(tx) = slot.take() {
                    let _ = tx.send(AgentResult::Ok {
                        ok: true,
                        session_id: sid_started.clone(),
                        turn_id,
                    });
                }
            }
        });

        let svc_delta = self.clone();
        let sid_delta = session_id.clone();
        let on_delta = Box::new(move |delta: String| {
            let mut active_turn = None;
            if let Ok(mut runs) = svc_delta.runs.lock() {
                if let Some(r) = runs.get_mut(&sid_delta) {
                    if r.key == key {
                        r.answer.push_str(&delta);
                        active_turn = r.turn_id.clone();
                    }
                }
            }
            if let Some(turn_id) = active_turn {
                (svc_delta.on_event)(AgentEvent::Delta {
                    session_id: sid_delta.clone(),
                    turn_id,
                    delta,
                });
            }
        });

        let svc_tool = self.clone();
        let sid_tool = session_id.clone();
        let on_tool = Box::new(move |progress: ToolProgress| {
            let mut active_turn = None;
            if let Ok(mut runs) = svc_tool.runs.lock() {
                if let Some(r) = runs.get_mut(&sid_tool) {
                    if r.key == key {
                        r.tools = apply_tool_progress(&r.tools, &progress);
                        active_turn = r.turn_id.clone();
                    }
                }
            }
            if let Some(turn_id) = active_turn {
                (svc_tool.on_event)(AgentEvent::Tool {
                    session_id: sid_tool.clone(),
                    turn_id,
                    name: progress.tool,
                    status: progress.status,
                    summary: progress.summary,
                });
            }
        });

        let svc_bg = self.clone();
        tokio::spawn(async move {
            let outcome = svc_bg
                .client
                .run_turn(TurnOptions {
                    cwd,
                    thread_id,
                    prompt,
                    model: if model.is_empty() { None } else { Some(model) },
                    effort: if effort.is_empty() { None } else { Some(effort) },
                    dynamic_tools: agent_tools(),
                    on_tool_call,
                    on_started,
                    on_delta,
                    on_tool,
                })
                .await;

            match outcome {
                Ok(turn_out) => {
                    svc_bg.complete_run(key, &session_id, &request, material.as_ref(), turn_out, &exec_ctx);
                }
                Err(err) => {
                    let code = match err.code.as_str() {
                        "AGENT_UNAVAILABLE" | "AUTH_REQUIRED" | "TURN_RUNNING" | "TURN_INTERRUPTED" | "TURN_TIMEOUT" => {
                            err.code
                        }
                        _ => "TURN_FAILED".into(),
                    };
                    svc_bg.fail_run(key, &session_id, &request, &code, &err.message);
                    if let Ok(mut slot) = settle_slot.lock() {
                        if let Some(tx) = slot.take() {
                            let _ = tx.send(AgentResult::Err {
                                ok: false,
                                code,
                                message: err.message,
                            });
                        }
                    }
                }
            }
        });

        settle_rx.await.unwrap_or_else(|_| AgentResult::Err {
            ok: false,
            code: "TURN_FAILED".into(),
            message: "Turn failed before starting.".into(),
        })
    }

    fn take_run(&self, key: u64, session_id: &str) -> Option<ActiveRun> {
        let mut runs = self.runs.lock().ok()?;
        if runs.get(session_id).is_some_and(|r| r.key == key) {
            runs.remove(session_id)
        } else {
            None
        }
    }

    fn complete_run(
        &self,
        key: u64,
        session_id: &str,
        request: &AgentRequest,
        material: Option<&MaterialRecord>,
        outcome: TurnOutcome,
        exec_ctx: &TurnExecutionContext,
    ) {
        let Some(run) = self.take_run(key, session_id) else {
            return;
        };
        let sources: Vec<String> = exec_ctx.seen.lock().unwrap().iter().cloned().collect();
        let settled_tools: Vec<AgentToolRow> = run
            .tools
            .into_iter()
            .filter(|t| t.status != "running")
            .collect();
        let _ = self.sessions.set_thread(session_id, &outcome.thread_id);
        let _ = self.sessions.append_turn(
            session_id,
            TurnInput {
                role: "agent".into(),
                text: outcome.text.clone(),
                task: Some(request.task.clone()),
                tools: Some(settled_tools.clone()),
                sources: Some(sources.clone()),
                status: Some("completed".into()),
            },
        );
        (self.on_event)(AgentEvent::Completed {
            session_id: session_id.to_string(),
            turn_id: outcome.turn_id,
            text: outcome.text.clone(),
            sources,
        });
        (self.on_sessions_changed)();

        if request.task == "rebuild" {
            if let Some(mat) = material {
                self.mark_rebuilt(mat, &outcome.text, &settled_tools);
            }
        }
    }

    fn fail_run(&self, key: u64, session_id: &str, request: &AgentRequest, code: &str, message: &str) {
        let Some(run) = self.take_run(key, session_id) else {
            return;
        };
        let settled_tools: Vec<AgentToolRow> = run
            .tools
            .into_iter()
            .filter(|t| t.status != "running")
            .collect();
        let _ = self.sessions.append_turn(
            session_id,
            TurnInput {
                role: "agent".into(),
                text: message.to_string(),
                task: Some(request.task.clone()),
                tools: Some(settled_tools),
                sources: None,
                status: Some(if code == "TURN_INTERRUPTED" {
                    "interrupted".into()
                } else {
                    "failed".into()
                }),
            },
        );
        if let Some(turn_id) = run.turn_id {
            (self.on_event)(AgentEvent::Failed {
                session_id: session_id.to_string(),
                turn_id,
                code: code.to_string(),
                message: message.to_string(),
            });
        }
        (self.on_sessions_changed)();
    }

    fn mark_rebuilt(&self, material: &MaterialRecord, text: &str, tools: &[AgentToolRow]) {
        let art_re = Regex::new(r"^artifact_write .* → ([a-f0-9]{16})$").unwrap();
        let hex_re = Regex::new(r"\b[a-f0-9]{16}\b").unwrap();
        let mut candidates = Vec::new();
        for t in tools {
            if t.name == "artifact_write" && t.status == "done" {
                if let Some(s) = &t.summary {
                    if let Some(cap) = art_re.captures(s).and_then(|c| c.get(1)) {
                        candidates.push(cap.as_str().to_string());
                    }
                }
            }
        }
        for m in hex_re.find_iter(text) {
            let id = m.as_str().to_string();
            if !candidates.contains(&id) {
                candidates.push(id);
            }
        }
        for id in candidates {
            if let Ok(Some(art)) = self.store.get(&id) {
                if art.origin == "agent"
                    && art.lineage.as_ref().is_some_and(|l| l.contains(&material.id))
                {
                    if self.store.set_rebuilt_as(&material.id, &art.id).is_ok() {
                        (self.on_library_changed)();
                        return;
                    }
                }
            }
        }
    }

    pub fn list_runs(&self) -> Vec<AgentRun> {
        let Ok(runs) = self.runs.lock() else {
            return Vec::new();
        };
        runs.values()
            .filter_map(|r| {
                let turn_id = r.turn_id.clone()?;
                Some(AgentRun {
                    session_id: r.session_id.clone(),
                    turn_id,
                    thread_id: r.thread_id.clone(),
                    task: r.task.clone(),
                    prompt: r.prompt.clone(),
                    answer: r.answer.clone(),
                    tools: r.tools.clone(),
                    started_at: r.started_at.clone(),
                })
            })
            .collect()
    }

    pub async fn interrupt(&self, session_id: &str) {
        let tid = {
            let Ok(mut runs) = self.runs.lock() else {
                return;
            };
            let Some(r) = runs.get_mut(session_id) else {
                return;
            };
            if r.thread_id.is_none() {
                r.interrupt_requested = true;
                None
            } else {
                r.thread_id.clone()
            }
        };
        if let Some(thread_id) = tid {
            let _ = self.client.interrupt(&thread_id).await;
        }
    }

    pub fn shutdown(&self) {
        let drained: Vec<ActiveRun> = self
            .runs
            .lock()
            .map(|mut r| r.drain().map(|(_, v)| v).collect())
            .unwrap_or_default();
        for run in drained {
            let settled_tools: Vec<AgentToolRow> = run
                .tools
                .into_iter()
                .filter(|t| t.status != "running")
                .collect();
            let _ = self.sessions.append_turn(
                &run.session_id,
                TurnInput {
                    role: "agent".into(),
                    text: QUIT_MESSAGE.into(),
                    task: Some(run.task),
                    tools: Some(settled_tools),
                    sources: None,
                    status: Some("interrupted".into()),
                },
            );
        }
        self.client.stop();
    }
}
