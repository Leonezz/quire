import { describe, expect, it } from "vitest";
import { ARTIFACT_CSP, artifactPage, artifactResponse, parseArtifactUrl } from "./artifact-protocol";

const ID = "0123456789abcdef";

describe("artifact protocol", () => {
  it("reads the artifact id and scheme from the URL, and nothing else", () => {
    expect(parseArtifactUrl(`quire-artifact://artifact/${ID}?v=3&scheme=dark`)).toEqual({ id: ID, dark: true });
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
    const response = await artifactResponse(`quire-artifact://artifact/${ID}?v=1`, async (id) => (id === ID ? "<p>ok</p>" : undefined));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(ARTIFACT_CSP);
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_CSP).toContain("connect-src 'none'");
    expect(ARTIFACT_CSP).not.toMatch(/https?:|\*/);
    expect(await response.text()).toContain("<p>ok</p>");
    expect((await artifactResponse(`quire-artifact://artifact/${"f".repeat(16)}`, async () => undefined)).status).toBe(404);
  });
});
