import { describe, expect, it } from "vitest";
import { ARTIFACT_CSP, artifactPage, artifactResponse, parseArtifactUrl, parseRuntimeUrl, type ArtifactSources } from "./artifact-protocol";

const ID = "0123456789abcdef";

function sources(artifact?: Awaited<ReturnType<ArtifactSources["artifact"]>>): ArtifactSources {
  return { artifact: async (id) => (id === ID ? artifact : undefined), runtime: async (file) => (file === "react" ? "window.QuireModules={}" : undefined) };
}

describe("artifact protocol", () => {
  it("reads the artifact id and scheme from the URL, and nothing else", () => {
    expect(parseArtifactUrl(`quire-artifact://artifact/${ID}?v=3&scheme=dark`)).toEqual({ id: ID, dark: true, version: 3 });
    expect(parseArtifactUrl(`quire-artifact://artifact/${ID}?v=0`)).toEqual({ id: ID, dark: false });
    expect(parseArtifactUrl(`quire-artifact://artifact/${ID}/`)).toEqual({ id: ID, dark: false });
    expect(parseArtifactUrl(`quire-artifact://artifact/${ID}/../x`)).toBeUndefined();
    expect(parseArtifactUrl(`quire-artifact://other/${ID}`)).toBeUndefined();
    expect(parseArtifactUrl(`https://artifact/${ID}`)).toBeUndefined();
    expect(parseArtifactUrl("quire-artifact://artifact/nothex")).toBeUndefined();
  });

  it("puts the policy, theme and bridge first in the artifact's head, or wraps a fragment in a document", () => {
    const page = artifactPage("<!doctype html><html lang=\"en\"><head><title>T</title></head><body><p>Hi</p></body></html>", { dark: false });
    expect(page.indexOf("Content-Security-Policy")).toBeLessThan(page.indexOf("<title>"));
    expect(page.indexOf("window.quire")).toBeLessThan(page.indexOf("<title>"));
    expect(page).toContain("color-scheme:light");
    const fragment = artifactPage("<p>Only a paragraph</p>", { dark: true });
    expect(fragment).toMatch(/^<!doctype html><html><head>.*color-scheme:dark.*<\/head><body><p>Only a paragraph<\/p><\/body><\/html>$/s);
  });

  it("serves an HTML artifact with a policy that loads and connects nowhere, and 404s anything else", async () => {
    const response = await artifactResponse(`quire-artifact://artifact/${ID}?v=1`, sources({ type: "html", source: "<p>ok</p>" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(ARTIFACT_CSP);
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_CSP).toContain("connect-src 'none'");
    expect(ARTIFACT_CSP).not.toMatch(/https?:|\*/);
    expect(ARTIFACT_CSP).toContain("script-src 'unsafe-inline' 'unsafe-eval' quire-artifact://runtime");
    expect(await response.text()).toContain("<p>ok</p>");
    expect((await artifactResponse(`quire-artifact://artifact/${"f".repeat(16)}`, sources())).status).toBe(404);
  });

  it("serves the runtime libraries it ships, and only those", async () => {
    expect(parseRuntimeUrl("quire-artifact://runtime/react.js")).toBe("react");
    expect(parseRuntimeUrl("quire-artifact://runtime/d3.js")).toBe("d3");
    expect(parseRuntimeUrl("quire-artifact://runtime/../main/index.js")).toBeUndefined();
    expect(parseRuntimeUrl("quire-artifact://runtime/left-pad.js")).toBeUndefined();
    const script = await artifactResponse("quire-artifact://runtime/react.js", sources());
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await script.text()).toBe("window.QuireModules={}");
    expect((await artifactResponse("quire-artifact://runtime/d3.js", sources())).status).toBe(404);
  });

  it("runs a React artifact on its runtime, and shows why one does not compile", async () => {
    const page = await (await artifactResponse(`quire-artifact://artifact/${ID}`, sources({ type: "react", source: "import { LineChart } from 'recharts';\nexport default () => <LineChart />;" }))).text();
    expect(page).toContain('<script src="quire-artifact://runtime/react.js"></script><script src="quire-artifact://runtime/recharts.js"></script>');
    expect(page).toContain("React.createElement");
    const broken = await (await artifactResponse(`quire-artifact://artifact/${ID}`, sources({ type: "react", source: "export default () => <div>" }))).text();
    expect(broken).toContain("does not compile");
    const mermaid = await (await artifactResponse(`quire-artifact://artifact/${ID}?scheme=dark`, sources({ type: "mermaid", source: "graph TD; A-->B</script>" }))).text();
    expect(mermaid).toContain("quire-artifact://runtime/mermaid.js");
    expect(mermaid).toContain('let scheme = "dark"');
    expect(mermaid).not.toContain("A-->B</script>");
  });
});
