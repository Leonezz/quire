import type { AgentContext, AgentEvent, AgentRequest, AgentRun, AgentStatus, AgentTask, AgentTurnRecord, MaterialRecord, MaterialSummary, ReadApiM2 } from "../../shared/contracts";
import { rebuiltArtifactOf } from "./previewRebuild";
import { appendTurn, createSession, getSession, setThread, titleFor } from "./previewSessions";

// The M2 half of the browser preview. There is no Codex in a browser, so the agent reports
// itself unavailable — unless the demo switch is set, in which case a scripted answer streams
// through the same events the desktop bridge emits, so the panel can be exercised end to end.
//   localStorage["read:preview-agent"] = "demo"   → available, scripted streaming answers
//   localStorage["read:preview-agent"] = "auth"   → not signed in (exercises the sign-in path)
// As the engine does, `agentAsk` returns as soon as the scripted turn is running; the answer streams
// on whether or not a panel is mounted, `listAgentRuns` reports what has streamed so far, one turn
// per session runs at a time and different sessions run side by side. Turns are appended to a stored
// session (see previewSessions.ts), and a "rebuild" writes an artifact and marks the material (see
// previewRebuild.ts). Runs live in memory: a reload forgets them (the stored user turn stays open).

export const PREVIEW_AGENT_SWITCH = "read:preview-agent";
const UNAVAILABLE_REASON = "The agent runs in the desktop app with Codex installed.";
const AUTH_REASON = "Sign in to Codex to use the agent.";
const CHUNK_MS = 70;
/** A citation the scripted answer fabricates on purpose: it is never retrieved, so the pill must show as unverified. */
const FABRICATED_ID = "deadbeefdeadbeef";
/** The sample article (dev/sample-material.json) and a sentence from its body, so the quoted citation can jump to it. */
const QUOTED_ID = "526130b61f003c33";
const QUOTED_PASSAGE = "styling arbitrary text ranges on a document by using JavaScript to create the ranges";

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
  views: [{ id: "markdown", label: "Markdown", url: "agent://artifact/a9e1c0ffeed0d0d1", mediaType: "text/markdown", status: "ready" }],
  primaryView: "markdown",
  readyViews: ["markdown"],
  quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "strong", safety: "safe", warnings: [] },
  lineage: ["526130b61f003c33", "5f725f31pdf00001"],
  tags: [],
  kind: "note",
  extracted: { kind: "note", title: "Highlights without the DOM: a brief", date: "2026-09-18" },
  meta: { kind: "note", title: "Highlights without the DOM: a brief", date: "2026-09-18" },
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

/**
 * The scripted answer: a heading, prose with emphasis, a fenced block, a list, a quote and citations in every
 * form the agent writes them — `[id]`, an id in inline code, a bare id, and a quoted passage followed by its id.
 */
function scriptedAnswer(request: AgentRequest, subject: string, citation: string | undefined, quoted: boolean): string {
  const about = request.context.kind === "selection" ? `the passage “${request.context.quote.slice(0, 60)}${request.context.quote.length > 60 ? "…" : ""}”` : subject;
  const asked = request.text.trim() ? `You asked: *${request.text.trim()}*\n\n` : "";
  const cite = citation ? ` A second source in your library agrees [${citation}]; its id in code reads \`${citation}\`, and bare in prose it is ${citation}.` : "";
  const passage = quoted ? ` The spec page puts it as “${QUOTED_PASSAGE}” [${QUOTED_ID}].` : "";
  const fabricated = ` A claim about Safari cites [${FABRICATED_ID}], which was never retrieved.`;
  return [
    taskIntro[request.task],
    "",
    `${asked}This is a **scripted preview answer** about ${about}; the desktop app streams a real one from Codex. The registry keeps \`Highlight\` objects by name, and \`::highlight()\` styles them without touching the DOM.${cite}${passage}${fabricated}`,
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

/** The scripted rebuild reply: what was done and the artifact it produced, cited so the pill resolves. */
function rebuildAnswer(material: MaterialRecord, artifactId: string): string {
  return [
    taskIntro.rebuild,
    "",
    `I rebuilt **${material.title}** from the captured page: the navigation, footer and cookie notice are gone and the article body is Markdown with its headings restored.`,
    "",
    `The rebuilt version is [${artifactId}]; the original stays as [${material.id}] for comparison.`,
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

export interface PreviewM2Deps {
  listMaterials: () => Promise<MaterialSummary[]>;
  getMaterial: (id: string) => Promise<MaterialRecord | undefined>;
  /** Stores the rebuilt artifact and marks the material, then fires library:changed. */
  markRebuilt: (materialId: string, artifact: MaterialRecord) => void;
}

/** The main process may ask the window to show a session (a notification was clicked); the preview never does. */
export interface PreviewOpenSessionApi { onAgentOpenSession: (listener: (sessionId: string) => void) => () => void }
/** The main process tells the window when the agent's availability changed (a setting was saved); the preview's never does. */
export interface PreviewAgentStatusApi { onAgentStatusChanged: (listener: () => void) => () => void }

interface ScriptedRun {
  turnId: string;
  threadId: string;
  task: AgentTask;
  prompt: string;
  answer: string;
  tools: AgentRun["tools"];
  startedAt: string;
  timers: readonly number[];
  /** Ends the turn: the event goes out first, then the agent record (and the artifact for a rebuild) is stored. */
  finish: (result: { ok: true } | { ok: false; code: "TURN_INTERRUPTED"; message: string }) => void;
}

export function createPreviewM2(deps: PreviewM2Deps): ReadApiM2 & PreviewOpenSessionApi & PreviewAgentStatusApi {
  const listeners = new Set<(event: AgentEvent) => void>();
  const emit = (event: AgentEvent) => { for (const listener of listeners) listener(event); };
  const runs = new Map<string, ScriptedRun>();
  const patchRun = (sessionId: string, update: (run: ScriptedRun) => ScriptedRun) => {
    const current = runs.get(sessionId);
    if (current) runs.set(sessionId, update(current));
  };

  const status = (): AgentStatus => {
    const current = mode();
    if (current === "demo") return { available: true, version: "preview-demo", account: "demo@preview", running: runs.size };
    if (current === "auth") return { available: false, running: 0, reason: AUTH_REASON };
    return { available: false, running: 0, reason: UNAVAILABLE_REASON };
  };

  const interrupt = (sessionId: string) => {
    const run = runs.get(sessionId);
    if (!run) return;
    for (const timer of run.timers) window.clearTimeout(timer);
    run.finish({ ok: false, code: "TURN_INTERRUPTED", message: "the answer was cut short." });
  };

  return {
    agentStatus: async () => status(),
    agentLogin: async () => ({ available: false, running: 0, reason: "Signing in needs the desktop app with Codex installed; the browser preview cannot open the login flow." }),
    agentInterrupt: async (sessionId) => { interrupt(sessionId); },
    listAgentRuns: async () => [...runs.entries()].map(([sessionId, run]) => ({ sessionId, turnId: run.turnId, threadId: run.threadId, task: run.task, prompt: run.prompt, answer: run.answer, tools: run.tools.map((tool) => ({ ...tool })), startedAt: run.startedAt })),
    onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onAgentOpenSession: () => () => undefined,
    onAgentStatusChanged: () => () => undefined,
    agentAsk: async (request) => {
      const current = mode();
      if (current === "auth") return { ok: false, code: "AUTH_REQUIRED", message: AUTH_REASON };
      if (current !== "demo") return { ok: false, code: "AGENT_UNAVAILABLE", message: UNAVAILABLE_REASON };
      if (request.sessionId && runs.has(request.sessionId)) return { ok: false, code: "TURN_RUNNING", message: "This conversation is still being answered; stop it first." };
      const materials = await deps.listMaterials();
      const contextId = request.context.kind === "library" ? undefined : request.context.materialId;
      const material = contextId ? await deps.getMaterial(contextId) : undefined;
      if (contextId && !material) return { ok: false, code: "TURN_FAILED", message: `Material ${contextId} is not in the library.` };
      const session = request.sessionId ? getSession(request.sessionId) : createSession(request.context, titleFor(request, material?.title));
      if (!session) return { ok: false, code: "TURN_FAILED", message: `Session ${request.sessionId} no longer exists; start a new one.` };
      const sessionId = session.id;
      appendTurn(sessionId, { role: "user", text: request.text, task: request.task });
      const rebuild = request.task === "rebuild" && material ? { material, artifact: rebuiltArtifactOf(material) } : undefined;
      const citation = materials.find((candidate) => candidate.id !== contextId && /^[a-f0-9]{16}$/.test(candidate.id))?.id;
      const quoted = materials.some((candidate) => candidate.id === QUOTED_ID);
      // What the scripted turn "retrieved": the material asked about, the one it cites (or wrote) and the one it quotes.
      const sources = rebuild ? [rebuild.material.id, rebuild.artifact.id] : [contextId, citation, quoted ? QUOTED_ID : undefined].filter((id): id is string => id !== undefined);
      const text = rebuild ? rebuildAnswer(rebuild.material, rebuild.artifact.id) : scriptedAnswer(request, subjectOf(request.context, materials), citation, quoted);
      const threadId = request.threadId ?? session.threadId ?? newId("thread");
      const turnId = newId("turn");
      const chunks = chunksOf(text);
      const finish: ScriptedRun["finish"] = (result) => {
        const run = runs.get(sessionId);
        if (!run) return;
        runs.delete(sessionId);
        const tools: NonNullable<AgentTurnRecord["tools"]> = run.tools.flatMap((tool) => (tool.status === "running" ? [] : [{ name: tool.name, status: tool.status, summary: tool.summary }]));
        if (result.ok) {
          emit({ type: "completed", sessionId, turnId, text, sources });
          setThread(sessionId, threadId);
          appendTurn(sessionId, { role: "agent", text, task: request.task, status: "completed", tools, sources });
          if (rebuild) deps.markRebuilt(rebuild.material.id, rebuild.artifact);
          return;
        }
        emit({ type: "failed", sessionId, turnId, code: result.code, message: result.message });
        appendTurn(sessionId, { role: "agent", text: result.message, task: request.task, status: "interrupted", tools });
      };
      const steps: { ms: number; step: () => void }[] = [];
      const at = (ms: number, step: () => void) => steps.push({ ms, step });
      const tool = (ms: number, name: string, state: "running" | "done", summary: string) => at(ms, () => {
        patchRun(sessionId, (run) => ({ ...run, tools: state === "running" ? [...run.tools, { name, status: state, summary }] : run.tools.map((entry) => (entry.name === name && entry.status === "running" ? { name, status: state, summary } : entry)) }));
        emit({ type: "tool", sessionId, turnId, name, status: state, summary });
      });
      // The result goes back before the first event, as the bridge's does.
      at(0, () => emit({ type: "started", sessionId, threadId, turnId }));
      if (rebuild) {
        tool(120, "material_source", "running", rebuild.material.title);
        tool(600, "material_source", "done", `${rebuild.material.title} → ${rebuild.material.capture?.byteLength ?? 0} bytes`);
        tool(700, "artifact_write", "running", `"${rebuild.artifact.title}"`);
        tool(1300, "artifact_write", "done", `"${rebuild.artifact.title}" → ${rebuild.artifact.id}`);
      } else {
        tool(120, "library_search", "running", `"${request.context.kind === "library" ? "recent" : "highlight"}"`);
        tool(480, "library_search", "done", `"${request.context.kind === "library" ? "recent" : "highlight"}" → ${Math.min(4, materials.length)} hits`);
      }
      const start = rebuild ? 1400 : 300;
      chunks.forEach((delta, index) => at(start + index * CHUNK_MS, () => { patchRun(sessionId, (run) => ({ ...run, answer: run.answer + delta })); emit({ type: "delta", sessionId, turnId, delta }); }));
      at(start + chunks.length * CHUNK_MS + 60, () => finish({ ok: true }));
      const timers = steps.map(({ ms, step }) => window.setTimeout(step, ms));
      runs.set(sessionId, { turnId, threadId, task: request.task, prompt: request.text, answer: "", tools: [], startedAt: new Date().toISOString(), timers, finish });
      return { ok: true, sessionId, turnId };
    },
  };
}
