import { describe, expect, it } from "vitest";
import { scopeFamily, scopeKey, scopeOfKey, type Scope } from "./useScope";

describe("scope keys", () => {
  it("round-trips every kind of scope", () => {
    const scopes: Scope[] = [{ kind: "inbox" }, { kind: "queue" }, { kind: "agent" }, { kind: "sources" }, { kind: "library", id: "papers" }, { kind: "tag", id: "react:hooks" }, { kind: "source", id: "src_1" }];
    for (const scope of scopes) expect(scopeOfKey(scopeKey(scope))).toEqual(scope);
  });
  it("rejects keys that name no scope", () => {
    expect(scopeOfKey("tags:all")).toBeUndefined();
    expect(scopeOfKey("library:everything")).toBeUndefined();
    expect(scopeOfKey("tag:")).toBeUndefined();
    expect(scopeOfKey("nope")).toBeUndefined();
  });
  it("groups scopes into list-width families", () => {
    expect(scopeFamily({ kind: "tag", id: "x" })).toBe("library");
    expect(scopeFamily({ kind: "source", id: "x" })).toBe("items");
    expect(scopeFamily({ kind: "sources" })).toBe("sources");
  });
});
