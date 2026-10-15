// Builds the libraries an artifact can use inside its sandbox (main/artifact-runtime.ts) into
// out/artifact-runtime/<name>.js. Each file is one classic script that registers its module on
// window.QuireModules; React is bundled once, and every library that imports it reads that copy, so
// an artifact loads only the files its imports name. Run before `electron-vite dev|build`.
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "out", "artifact-runtime");
const require = createRequire(join(root, "package.json"));

// Module name → the runtime file that registers it. Keep in step with RUNTIME_MODULES in main/artifact-runtime.ts.
const LIBRARIES = {
  react: { modules: { react: "react", "react-dom": "react-dom", "react-dom/client": "react-dom/client", "react/jsx-runtime": "react/jsx-runtime" } },
  recharts: { modules: { recharts: "recharts" } },
  d3: { modules: { d3: "d3" }, global: "d3" },
  lucide: { modules: { "lucide-react": "lucide-react" } },
  lodash: { modules: { lodash: "lodash" }, global: "_", default: true },
  mermaid: { modules: { mermaid: "mermaid" }, global: "mermaid", default: true },
  // Quire's own components for React artifacts (src/artifact-kit).
  quire: { modules: { quire: "./src/artifact-kit/index.tsx" } },
};

// Inside every library but the React one, React resolves to the copy react.js registered.
const SHARED = ["react", "react-dom", "react-dom/client", "react/jsx-runtime"];
const sharedReact = {
  name: "shared-react",
  setup(builder) {
    builder.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => (SHARED.includes(args.path) ? { path: args.path, namespace: "quire-shared" } : undefined));
    builder.onLoad({ filter: /.*/, namespace: "quire-shared" }, (args) => ({ contents: `module.exports = window.QuireModules[${JSON.stringify(args.path)}];`, loader: "js" }));
  },
};

await mkdir(out, { recursive: true });
for (const [name, library] of Object.entries(LIBRARIES)) {
  const lines = ["window.QuireModules = window.QuireModules || {};"];
  Object.entries(library.modules).forEach(([module, specifier], index) => {
    lines.push(`import * as m${index} from ${JSON.stringify(specifier)};`);
    lines.push(`window.QuireModules[${JSON.stringify(module)}] = m${index};`);
  });
  if (library.global) lines.push(`window[${JSON.stringify(library.global)}] = ${library.default ? "m0.default" : "m0"};`);
  await build({
    stdin: { contents: lines.join("\n"), resolveDir: root, loader: "js" },
    bundle: true, minify: true, format: "iife", jsx: "automatic", platform: "browser", target: "chrome130", legalComments: "none",
    define: { "process.env.NODE_ENV": "\"production\"" },
    plugins: name === "react" ? [] : [sharedReact],
    outfile: join(out, `${name}.js`), logLevel: "warning",
  });
}
await copyFile(require.resolve("@tailwindcss/browser"), join(out, "tailwind.js"));
console.log(`artifact runtime → ${out}`);
