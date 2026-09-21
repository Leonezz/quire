// Runs the PDF reflow eval (harness.test.ts through the eval package's vitest) with the TypeSafe key
// read from ~/.config/quire/typesafe-api-key into the environment; the key never touches the repo.
//   node run.mjs [--rules-only] [--force] [--max-pages N] [--budget TOKENS] [slug ...]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const slugs = args.filter((arg, index) => !arg.startsWith("--") && !["--max-pages", "--budget"].includes(args[index - 1] ?? ""));

let key = "";
if (!flag("--rules-only")) {
  const keyPath = process.env.TYPESAFE_API_KEY_FILE ?? join(homedir(), ".config", "quire", "typesafe-api-key");
  try { key = readFileSync(keyPath, "utf8").trim(); }
  catch (error) { console.error(`Cannot read the TypeSafe key from ${keyPath} (${error.message}); pass --rules-only to evaluate the rules alone.`); process.exit(1); }
  if (!key) { console.error(`The key file ${keyPath} is empty.`); process.exit(1); }
}

const env = {
  ...process.env,
  TYPESAFE_API_KEY: key,
  PDF_EVAL_ONLY: slugs.join(","),
  PDF_EVAL_FORCE: flag("--force") ? "1" : "",
  PDF_EVAL_RULES_ONLY: flag("--rules-only") ? "1" : "",
  ...(option("--max-pages") ? { PDF_EVAL_MAX_PAGES: option("--max-pages") } : {}),
  ...(option("--budget") ? { PDF_EVAL_BUDGET: option("--budget") } : {}),
};
const vitest = join(root, "..", "node_modules", ".bin", "vitest");
const result = spawnSync(vitest, ["run", "--config", join(root, "vitest.config.ts"), "--reporter=dot"], { cwd: root, env, stdio: "inherit" });
process.exit(result.status ?? 1);
