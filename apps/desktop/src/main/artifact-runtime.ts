import { transform } from "sucrase";

// The artifact types that run on a bundled runtime in the sandbox (artifact-protocol.ts): a React
// component and a Mermaid diagram. The libraries are built by scripts/build-artifact-runtime.mjs into
// out/artifact-runtime and served on quire-artifact://runtime/<file>.js; each registers its module
// on window.QuireModules. A React artifact is compiled here (JSX and TypeScript to CommonJS, by
// sucrase) and gets a `require` that answers from those modules, so it imports what the reader's
// own React artifacts in Claude import: react, recharts, d3, lucide-react, lodash; Tailwind classes work.

export const RUNTIME_HOST = "runtime";
export const RUNTIME_FILES = ["react", "recharts", "d3", "lucide", "lodash", "mermaid", "tailwind"] as const;
export type RuntimeFile = (typeof RUNTIME_FILES)[number];

/** The runtime file that registers a module, with the files it needs first; undefined for a module Quire does not ship. */
export function runtimeFilesOf(module: string): RuntimeFile[] | undefined {
  if (module === "react" || module === "react-dom" || module === "react-dom/client" || module === "react/jsx-runtime") return ["react"];
  if (module === "recharts") return ["react", "recharts"];
  if (module === "lucide-react") return ["react", "lucide"];
  if (module === "d3" || /^d3-[a-z-]+$/.test(module)) return ["d3"];
  if (module === "lodash" || /^lodash\/[a-zA-Z]+$/.test(module)) return ["lodash"];
  return undefined;
}

export const RUNTIME_MODULES = "react, react-dom, recharts, d3 (and d3-*), lucide-react, lodash (and lodash/*)";

export interface CompiledReact { code: string; files: RuntimeFile[] }

/** A React artifact compiled to a CommonJS module body, and the runtime files its imports need; throws with a message the agent can act on. */
export function compileReact(source: string): CompiledReact {
  let code: string;
  try {
    code = transform(source, { transforms: ["jsx", "typescript", "imports"], production: true, jsxPragma: "React.createElement", jsxFragmentPragma: "React.Fragment", filePath: "artifact.tsx" }).code;
  } catch (error) {
    throw new Error(`The component does not compile: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files = new Set<RuntimeFile>(["react"]);
  for (const match of code.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)) {
    const needed = runtimeFilesOf(match[2]!);
    if (!needed) throw new Error(`"${match[2]}" is not available in the artifact sandbox. Available modules: ${RUNTIME_MODULES}. Nothing can be loaded from the network.`);
    for (const file of needed) files.add(file);
  }
  if (!/\bexports\.\s*default\s*=/.test(code)) throw new Error("A React artifact must `export default` its component.");
  return { code, files: RUNTIME_FILES.filter((file) => files.has(file)) };
}

/** Text that cannot close the <script> element it is written into. */
function scriptSafe(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

function runtimeScripts(files: readonly RuntimeFile[]): string {
  return files.map((file) => `<script src="quire-artifact://${RUNTIME_HOST}/${file}.js"></script>`).join("");
}

/** Shows an error in place of the artifact and reports it to the reader (the bridge forwards it). */
const SHOW_ERROR = `const quireShowError = (error) => {
  const message = error && error.message ? error.message : String(error);
  const root = document.getElementById("root") || document.body;
  const box = document.createElement("pre");
  box.setAttribute("style", "white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace;color:var(--quire-muted);border:1px solid var(--quire-border);border-radius:8px;padding:12px;margin:16px");
  box.textContent = message;
  root.replaceChildren(box);
  if (window.quire) window.quire.reportError(message);
};`;

/** The document a React artifact runs as: Tailwind, its runtime files, then the component mounted under an error boundary. */
export function reactDocument(source: string): string {
  const { code, files } = compileReact(source);
  const runner = `(() => {
  ${SHOW_ERROR}
  const modules = window.QuireModules || {};
  const require = (name) => {
    let found = modules[name];
    if (!found && /^d3-/.test(name)) found = modules.d3;
    if (!found && /^lodash\\//.test(name)) { const lodash = modules.lodash && modules.lodash.default; const fn = lodash && lodash[name.slice(7)]; if (fn) return fn; }
    if (!found) throw new Error("Module not available in the artifact sandbox: " + name);
    return { __esModule: true, default: "default" in found ? found.default : found, ...found };
  };
  try {
    const React = require("react");
    const { createRoot } = require("react-dom/client");
    const module = { exports: {} };
    (function (require, module, exports, React) {
${scriptSafe(code)}
    })(require, module, module.exports, React);
    const App = module.exports.default;
    if (typeof App !== "function" && !(App && typeof App === "object")) throw new Error("A React artifact must export default its component.");
    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error }; }
      componentDidCatch(error) { quireShowError(error); }
      render() { return this.state.error ? null : this.props.children; }
    }
    createRoot(document.getElementById("root")).render(React.createElement(Boundary, null, React.createElement(App)));
  } catch (error) { quireShowError(error); }
})();`;
  return `<!doctype html><html><head>${runtimeScripts(["tailwind", ...files])}</head><body><div id="root"></div><script>${runner}</script></body></html>`;
}

/** The document a Mermaid artifact runs as: the diagram drawn in the reader's scheme, and redrawn when it changes. */
export function mermaidDocument(source: string, dark: boolean): string {
  const runner = `(() => {
  ${SHOW_ERROR}
  const source = ${scriptSafe(JSON.stringify(source))};
  let scheme = ${JSON.stringify(dark ? "dark" : "light")};
  let drawn = 0;
  const draw = async () => {
    const root = document.getElementById("root");
    const font = getComputedStyle(document.documentElement).getPropertyValue("--quire-font").trim();
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: scheme === "dark" ? "dark" : "neutral", ...(font ? { fontFamily: font } : {}) });
    try {
      const { svg } = await window.mermaid.render("quire-diagram-" + (drawn += 1), source);
      root.innerHTML = svg;
    } catch (error) { quireShowError(error); }
  };
  addEventListener("message", (event) => {
    if (event.source !== parent || !event.data || event.data.quire !== 1 || event.data.type !== "theme") return;
    if ((event.data.scheme === "dark" || event.data.scheme === "light") && event.data.scheme !== scheme) { scheme = event.data.scheme; draw(); }
  });
  draw();
})();`;
  return `<!doctype html><html><head>${runtimeScripts(["mermaid"])}<style>#root{display:flex;justify-content:center;padding:16px}#root svg{max-width:100%;height:auto}</style></head><body><div id="root"></div><script>${runner}</script></body></html>`;
}
