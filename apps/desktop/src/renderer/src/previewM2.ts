import type { AgentContext, AgentEvent, AgentRequest, AgentResult, AgentStatus, AgentTask, MaterialRecord, MaterialSummary, ReadApiM2 } from "../../shared/contracts";

// The M2 half of the browser preview. There is no Codex in a browser, so the agent reports
// itself unavailable — unless the demo switch is set, in which case a scripted answer streams
// through the same events the desktop bridge emits, so the panel can be exercised end to end.
//   localStorage["read:preview-agent"] = "demo"   → available, scripted streaming answers
//   localStorage["read:preview-agent"] = "auth"   → not signed in (exercises the sign-in path)

export const PREVIEW_AGENT_SWITCH = "read:preview-agent";
const UNAVAILABLE_REASON = "The agent runs in the desktop app with Codex installed.";
const AUTH_REASON = "Sign in to Codex to use the agent.";
const CHUNK_MS = 70;

type Mode = "off" | "demo" | "auth";
function mode(): Mode {
  const value = localStorage.getItem(PREVIEW_AGENT_SWITCH);
  return value === "demo" || value === "auth" ? value : "off";
}

/** One artifact the demo agent "wrote", so the Library row, the reader header and the lineage list can be seen without the engine. */
const demoArtifact: MaterialRecord = {
  id: "a9e1c0ffeed0d0d1",
  url: "agent://artifact/a9e1c0ffeed0d0d1",
  finalUrl: "agent://artifact/a9e1c0ffeed0d0d1",
  title: "Highlights without the DOM: a brief",
  fetchedAt: "2026-09-18T08:30:00.000Z",
  readingMinutes: 2,
  origin: "agent",
  mediaType: "text/markdown",
  quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "strong", safety: "safe", warnings: [] },
  lineage: ["526130b61f003c33", "5f725f31pdf00001"],
  tags: [],
  markdown: [
    "## Highlights without the DOM",
    "",
    "The CSS Custom Highlight API styles arbitrary ranges through a named registry, so a re-render never loses a mark [526130b61f003c33].",
    "Attention-based models motivate the same separation of *what* to mark from *where* it lives [5f725f31pdf00001].",
    "",
    "- Register once per document; replace ranges as the text changes.",
    "- Keep the styling in `::highlight()`; only colour and background apply.",
  ].join("\n"),
  problems: [],
};

/** Artifacts the preview lists when the demo switch is on; none otherwise. */
export function previewArtifacts(): MaterialRecord[] { return mode() === "demo" ? [demoArtifact] : []; }

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const taskIntro: Record<AgentTask, string> = {
  ask: "Here is what I found.",
  explain: "## What this is about",
  verify: "## Checking the claims",
  related: "## Related in your library",
  summary: "## Summary",
  synthesis: "## Synthesis",
  rebuild: "## Rebuilt",
};

/** The scripted answer: a heading, prose with emphasis, a fenced block, a list, a quote and a citation. */
function scriptedAnswer(request: AgentRequest, subject: string, citation: string | undefined): string {
  const about = request.context.kind === "selection" ? `the passage “${request.context.quote.slice(0, 60)}${request.context.quote.length > 60 ? "…" : ""}”` : subject;
  const asked = request.text.trim() ? `You asked: *${request.text.trim()}*\n\n` : "";
  const cite = citation ? ` A second source in your library agrees [${citation}].` : "";
  return [
    taskIntro[request.task],
    "",
    `${asked}This is a **scripted preview answer** about ${about}; the desktop app streams a real one from Codex. The registry keeps \`Highlight\` objects by name, and \`::highlight()\` styles them without touching the DOM.${cite}`,
    "",
    "```js",
    "const range = new Range();",
    "range.selectNodeContents(article);",
    "CSS.highlights.set(\"read-find\", new Highlight(range));",
    "```",
    "",
    "What matters:",
    "",
    "- Ranges are styled by name, so a re-render does not lose them.",
    "- Only a few properties apply inside `::highlight()` — colour and background, mostly.",
    "- Safari still trips on ranges that cross shadow roots.",
    "",
    "> Style ranges of text without touching the DOM.",
    "",
    "1. Register the highlight once per document.",
    "2. Replace its ranges as the text changes.",
    "",
    "Want me to go deeper on any of these? [Read the spec](https://drafts.csswg.org/css-highlight-api-1/) for the details.",
  ].join("\n");
}

function subjectOf(context: AgentContext, materials: MaterialSummary[]): string {
  if (context.kind === "library") return "your library";
  const title = materials.find((material) => material.id === context.materialId)?.title;
  return title ? `*${title}*` : "this material";
}

/** Splits the answer into chunks that end on word boundaries, so the stream reads naturally. */
function chunksOf(text: string, size = 18): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < text.length) {
    let end = Math.min(text.length, index + size);
    const space = text.lastIndexOf(" ", end);
    if (end < text.length && space > index + 4) end = space + 1;
    out.push(text.slice(index, end));
    index = end;
  }
  return out;
}

export function createPreviewM2(deps: { listMaterials: () => Promise<MaterialSummary[]> }): ReadApiM2 {
  const listeners = new Set<(event: AgentEvent) => void>();
  const emit = (event: AgentEvent) => { for (const listener of listeners) listener(event); };
  let running: { timers: number[]; finish: (result: AgentResult) => void } | undefined;

  const status = (): AgentStatus => {
    const current = mode();
    if (current === "demo") return { available: true, version: "preview-demo", account: "demo@preview", busy: running !== undefined };
    if (current === "auth") return { available: false, busy: false, reason: AUTH_REASON };
    return { available: false, busy: false, reason: UNAVAILABLE_REASON };
  };

  const stop = () => {
    if (!running) return;
    for (const timer of running.timers) window.clearTimeout(timer);
    const { finish } = running;
    running = undefined;
    finish({ ok: false, code: "TURN_INTERRUPTED", message: "the answer was cut short." });
  };

  return {
    agentStatus: async () => status(),
    agentLogin: async () => ({ available: false, busy: false, reason: "Signing in needs the desktop app with Codex installed; the browser preview cannot open the login flow." }),
    agentInterrupt: async () => { stop(); },
    onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    agentAsk: async (request) => {
      const current = mode();
      if (current === "auth") return { ok: false, code: "AUTH_REQUIRED", message: AUTH_REASON };
      if (current !== "demo") return { ok: false, code: "AGENT_UNAVAILABLE", message: UNAVAILABLE_REASON };
      if (running) return { ok: false, code: "TURN_RUNNING", message: "The agent is still answering; stop it first." };
      const materials = await deps.listMaterials();
      const contextId = request.context.kind === "library" ? undefined : request.context.materialId;
      const citation = materials.find((material) => material.id !== contextId && /^[a-f0-9]{16}$/.test(material.id))?.id;
      // What the scripted turn "retrieved": the material asked about and the one it cites.
      const sources = [contextId, citation].filter((id): id is string => id !== undefined);
      const text = scriptedAnswer(request, subjectOf(request.context, materials), citation);
      const threadId = request.threadId ?? newId("thread");
      const sessionId = request.sessionId ?? newId("session");
      const turnId = newId("turn");
      const chunks = chunksOf(text);
      return new Promise<AgentResult>((resolve) => {
        const timers: number[] = [];
        const finish = (result: AgentResult) => { running = undefined; resolve(result); };
        running = { timers, finish };
        const at = (ms: number, step: () => void) => { timers.push(window.setTimeout(step, ms)); };
        emit({ type: "started", threadId, turnId });
        at(120, () => emit({ type: "tool", turnId, name: "library_search", status: "running", summary: `"${request.context.kind === "library" ? "recent" : "highlight"}"` }));
        at(480, () => emit({ type: "tool", turnId, name: "library_search", status: "done", summary: `"${request.context.kind === "library" ? "recent" : "highlight"}" → ${Math.min(4, materials.length)} hits` }));
        chunks.forEach((delta, index) => at(300 + index * CHUNK_MS, () => emit({ type: "delta", turnId, delta })));
        at(300 + chunks.length * CHUNK_MS + 60, () => { emit({ type: "completed", turnId, sources }); finish({ ok: true, threadId, turnId, text, sessionId, sources }); });
      });
    },
  };
}
