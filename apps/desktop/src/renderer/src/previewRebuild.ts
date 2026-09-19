import type { MaterialMeta, MaterialRecord } from "../../shared/contracts";

// What the demo agent's "rebuild" produced: the artifact records it wrote and which material each
// rebuilt, in localStorage — so the Library row, the reader banner and the Info panel can follow
// a rebuild without the engine. Cleared with the key.

const REBUILT_KEY = "read:preview-rebuilt";
const HEX = "0123456789abcdef";

interface RebuiltState { artifacts: MaterialRecord[]; rebuiltAs: Record<string, string> }

function load(): RebuiltState {
  const raw = localStorage.getItem(REBUILT_KEY);
  if (!raw) return { artifacts: [], rebuiltAs: {} };
  try { return JSON.parse(raw) as RebuiltState; }
  catch (error) { throw new Error(`Preview rebuild state unreadable (${(error as Error).message}); clear localStorage key ${REBUILT_KEY}.`); }
}
function save(state: RebuiltState) { localStorage.setItem(REBUILT_KEY, JSON.stringify(state)); }

/** A fresh 16-hex id, the shape the engine gives materials (citation pills only recognise that shape). */
export function newMaterialId(): string {
  return Array.from({ length: 16 }, () => HEX[Math.floor(Math.random() * HEX.length)]).join("");
}

export function rebuiltArtifacts(): MaterialRecord[] { return load().artifacts; }
export function rebuiltAsOf(materialId: string): string | undefined { return load().rebuiltAs[materialId]; }

/** The artifact the demo agent writes for a rebuild: the capture's text as clean Markdown, with the original as its lineage. */
export function rebuiltArtifactOf(material: MaterialRecord): MaterialRecord {
  const id = newMaterialId();
  const body = (material.markdown ?? material.plain ?? "").trim();
  const paragraphs = body.split(/\n{2,}/).map((paragraph) => paragraph.replace(/\s+/g, " ").trim()).filter(Boolean);
  const fetchedAt = new Date().toISOString();
  const extracted: MaterialMeta = { kind: "note", title: `${material.title} (rebuilt)`, date: fetchedAt.slice(0, 10) };
  return {
    id,
    url: `agent://artifact/${id}`,
    finalUrl: `agent://artifact/${id}`,
    title: `${material.title} (rebuilt)`,
    fetchedAt,
    readingMinutes: Math.max(1, material.readingMinutes),
    origin: "agent",
    mediaType: "text/markdown",
    views: [{ id: "markdown", label: "Markdown", url: `agent://artifact/${id}`, mediaType: "text/markdown", status: "ready" }],
    primaryView: "markdown",
    readyViews: ["markdown"],
    quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "strong", safety: "safe", warnings: [] },
    lineage: [material.id],
    tags: [],
    kind: "note",
    extracted,
    meta: extracted,
    markdown: [`## ${material.title}`, "", `Rebuilt by the agent from the captured page [${material.id}].`, "", ...paragraphs.flatMap((paragraph) => [paragraph, ""])].join("\n"),
    problems: [],
  };
}

export function recordRebuild(materialId: string, artifact: MaterialRecord) {
  const state = load();
  save({ artifacts: [...state.artifacts, artifact], rebuiltAs: { ...state.rebuiltAs, [materialId]: artifact.id } });
}
