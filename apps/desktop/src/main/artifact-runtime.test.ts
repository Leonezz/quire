import { describe, expect, it } from "vitest";
import { compileReact, reactDocument, runtimeFilesOf } from "./artifact-runtime";

describe("artifact runtime", () => {
  it("compiles JSX and TypeScript, and loads only the libraries the component imports", () => {
    const compiled = compileReact(`import { useState } from "react";
import * as d3 from "d3";
import { Sun } from "lucide-react";
type Props = { start: number };
export default function Counter({ start = 0 }: Props) {
  const [count, setCount] = useState<number>(start);
  return <button onClick={() => setCount(count + 1)}><Sun />{d3.format(",")(count)}</button>;
}`);
    expect(compiled.files).toEqual(["react", "d3", "lucide"]);
    expect(compiled.code).toContain("React.createElement");
    expect(compiled.code).not.toContain(": Props");
  });

  it("says which modules exist when a component imports one Quire does not ship", () => {
    expect(() => compileReact("import axios from 'axios';\nexport default () => { axios.get('x'); return null; };")).toThrow(/"axios" is not available.*recharts/);
    expect(() => compileReact("const App = () => <p>hi</p>;")).toThrow(/export default/);
    expect(() => compileReact("export default () => <p>")).toThrow(/does not compile/);
  });

  it("maps d3 and lodash submodules to their bundles", () => {
    expect(runtimeFilesOf("d3-scale")).toEqual(["d3"]);
    expect(runtimeFilesOf("lodash/debounce")).toEqual(["lodash"]);
    expect(runtimeFilesOf("recharts")).toEqual(["react", "recharts"]);
    expect(runtimeFilesOf("fs")).toBeUndefined();
  });

  it("keeps the component's text from closing its script element", () => {
    const page = reactDocument("export default () => <p>{'</script><script>alert(1)</script>'}</p>;");
    expect(page).not.toContain("</script><script>alert");
    expect(page.match(/<\/script>/g)?.length).toBe(3); // Tailwind, React, the component

  });
});
