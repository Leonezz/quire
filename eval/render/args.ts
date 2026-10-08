// Flags of `pnpm --filter @read/eval render`.

export interface RenderFlags {
  slugs: string[];
  force: boolean;
  maxTiles: number;
  maxReferenceTiles: number;
  width: number;
  build: boolean;
  concurrency: number;
}

export const USAGE = "Usage: render [slug ...] [--force] [--max-tiles N (8)] [--max-reference-tiles N (6)] [--width PX (1280)] [--no-build] [--concurrency N (3)]";

const DEFAULTS = { maxTiles: 8, maxReferenceTiles: 6, width: 1280, concurrency: 3 } as const;
const VALUED = { "--max-tiles": "maxTiles", "--max-reference-tiles": "maxReferenceTiles", "--width": "width", "--concurrency": "concurrency" } as const;
const LIMITS: Record<keyof typeof DEFAULTS, [number, number]> = { maxTiles: [1, 100], maxReferenceTiles: [0, 100], width: [320, 3840], concurrency: [1, 16] };

function positiveInt(name: string, raw: string | undefined, [min, max]: [number, number]): number {
  if (raw === undefined || raw.startsWith("--")) throw new Error(`${name} needs a value. ${USAGE}`);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer, got "${raw}". ${USAGE}`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}, got ${value}.`);
  return value;
}

/** Parses argv (without node and the script); throws with the usage on anything unknown or malformed. */
export function parseRenderArgs(argv: readonly string[]): RenderFlags {
  const numbers: Record<keyof typeof DEFAULTS, number> = { ...DEFAULTS };
  const slugs: string[] = [];
  let force = false;
  let build = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--force") force = true;
    else if (arg === "--no-build") build = false;
    else if (arg in VALUED) {
      const key = VALUED[arg as keyof typeof VALUED];
      numbers[key] = positiveInt(arg, argv[i + 1], LIMITS[key]);
      i += 1;
    } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}. ${USAGE}`);
    else if (!slugs.includes(arg)) slugs.push(arg);
  }
  return { slugs, force, build, ...numbers };
}
