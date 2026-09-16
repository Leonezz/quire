import { describe, expect, it } from "vitest";

import { READER_PAYLOAD_LIMITS, resolveReaderDocument } from "./registry";

const fallback = { reason: "invalid-payload", status: "fallback" } as const;

function v1Document(value = "Readable text") {
  return {
    children: [
      {
        children: [{ type: "text", value }],
        type: "paragraph",
      },
    ],
    type: "root",
  };
}

function v2Document(value = "Readable text") {
  return {
    children: [
      {
        children: [{ type: "text", value }],
        type: "paragraph",
      },
    ],
    losses: [],
    type: "root",
  };
}

describe("resolveReaderDocument", () => {
  it("accepts normal v1 and v2 object or JSON payloads", () => {
    expect(
      resolveReaderDocument("reader.document.v1", v1Document()),
    ).toMatchObject({
      document: v1Document(),
      schema: "reader.document.v1",
      status: "ready",
    });
    expect(
      resolveReaderDocument("reader.document.v2", JSON.stringify(v2Document())),
    ).toMatchObject({
      document: v2Document(),
      schema: "reader.document.v2",
      status: "ready",
    });
  });

  it("returns fallback for malformed JSON", () => {
    expect(
      resolveReaderDocument("reader.document.v2", '{"type":"root"'),
    ).toEqual(fallback);
  });

  it("rejects a 1,200-deep valid-shaped section tree before recursive schema traversal", () => {
    let child: Record<string, unknown> = {
      children: [{ type: "text", value: "leaf" }],
      type: "paragraph",
    };
    for (let depth = 0; depth < 1_200; depth += 1) {
      child = { children: [child], type: "section" };
    }

    expect(() =>
      resolveReaderDocument("reader.document.v2", {
        children: [child],
        losses: [],
        type: "root",
      }),
    ).not.toThrow();
    expect(
      resolveReaderDocument("reader.document.v2", {
        children: [child],
        losses: [],
        type: "root",
      }),
    ).toEqual(fallback);
  });

  it("rejects JSON larger than the total payload byte budget before parsing", () => {
    const chunk = "x".repeat(READER_PAYLOAD_LIMITS.maxStringBytes - 64);
    const payload = JSON.stringify({
      children: Array.from({ length: 5 }, () => ({
        lang: null,
        meta: null,
        type: "code",
        value: chunk,
      })),
      type: "root",
    });
    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(
      READER_PAYLOAD_LIMITS.maxBytes,
    );

    expect(resolveReaderDocument("reader.document.v1", payload)).toEqual(
      fallback,
    );
  });

  it("rejects an individual string larger than its byte budget", () => {
    const payload = v2Document(
      "x".repeat(READER_PAYLOAD_LIMITS.maxStringBytes + 1),
    );

    expect(resolveReaderDocument("reader.document.v2", payload)).toEqual(
      fallback,
    );
  });

  it("rejects a payload whose JSON value count exceeds the node budget", () => {
    const payload = {
      children: Array.from(
        { length: Math.floor(READER_PAYLOAD_LIMITS.maxNodes / 2) + 1 },
        () => ({ type: "thematicBreak" }),
      ),
      losses: [],
      type: "root",
    };

    expect(resolveReaderDocument("reader.document.v2", payload)).toEqual(
      fallback,
    );
  });

  it("fails closed for cyclic objects and accessor-backed traversal traps", () => {
    const cyclicSection: { children: unknown[]; type: "section" } = {
      children: [],
      type: "section",
    };
    cyclicSection.children.push(cyclicSection);
    const cyclicDocument = {
      children: [cyclicSection],
      losses: [],
      type: "root",
    };

    const accessorDocument = v2Document() as Record<string, unknown>;
    Object.defineProperty(accessorDocument, "trap", {
      enumerable: true,
      get() {
        throw new Error("must not execute untrusted getters");
      },
    });

    expect(() =>
      resolveReaderDocument("reader.document.v2", cyclicDocument),
    ).not.toThrow();
    expect(resolveReaderDocument("reader.document.v2", cyclicDocument)).toEqual(
      fallback,
    );
    expect(() =>
      resolveReaderDocument("reader.document.v2", accessorDocument),
    ).not.toThrow();
    expect(
      resolveReaderDocument("reader.document.v2", accessorDocument),
    ).toEqual(fallback);
  });
});
