import type { ReaderDocumentV1, ReaderDocumentV2 } from "./model";
import { readerDocumentSchema, readerDocumentV2Schema } from "./schema";

export const READER_PAYLOAD_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxDepth: 96,
  maxNodes: 50_000,
  maxStringBytes: 2 * 1024 * 1024,
});

type PendingValue = {
  depth: number;
  value: unknown;
};

function utf8ByteLengthWithin(value: string, maxBytes: number) {
  if (value.length > maxBytes) return false;

  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) bytes += 1;
    else if (codeUnit < 0x800) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) return false;
  }
  return true;
}

function jsonStringBytesWithin(
  value: string,
  maxStringBytes: number,
  remainingPayloadBytes: number,
) {
  if (
    value.length > maxStringBytes ||
    value.length + 2 > remainingPayloadBytes
  ) {
    return undefined;
  }

  let stringBytes = 0;
  let jsonBytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit === 0x22 ||
      codeUnit === 0x5c ||
      codeUnit === 0x08 ||
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0c ||
      codeUnit === 0x0d
    ) {
      stringBytes += 1;
      jsonBytes += 2;
    } else if (codeUnit < 0x20) {
      stringBytes += 1;
      jsonBytes += 6;
    } else if (codeUnit < 0x80) {
      stringBytes += 1;
      jsonBytes += 1;
    } else if (codeUnit < 0x800) {
      stringBytes += 2;
      jsonBytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        stringBytes += 4;
        jsonBytes += 4;
        index += 1;
      } else {
        stringBytes += 3;
        jsonBytes += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      stringBytes += 3;
      jsonBytes += 6;
    } else {
      stringBytes += 3;
      jsonBytes += 3;
    }

    if (stringBytes > maxStringBytes || jsonBytes > remainingPayloadBytes) {
      return undefined;
    }
  }

  return jsonBytes;
}

function payloadIsWithinLimits(payload: unknown) {
  const stack: PendingValue[] = [{ depth: 1, value: payload }];
  const seen = new WeakSet<object>();
  let payloadBytes = 0;
  let nodes = 0;

  const consumeBytes = (bytes: number) => {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      payloadBytes + bytes > READER_PAYLOAD_LIMITS.maxBytes
    ) {
      return false;
    }
    payloadBytes += bytes;
    return true;
  };

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) return false;
    nodes += 1;
    if (
      nodes > READER_PAYLOAD_LIMITS.maxNodes ||
      current.depth > READER_PAYLOAD_LIMITS.maxDepth
    ) {
      return false;
    }

    const value = current.value;
    if (value === null) {
      if (!consumeBytes(4)) return false;
      continue;
    }
    if (typeof value === "string") {
      const bytes = jsonStringBytesWithin(
        value,
        READER_PAYLOAD_LIMITS.maxStringBytes,
        READER_PAYLOAD_LIMITS.maxBytes - payloadBytes,
      );
      if (bytes === undefined || !consumeBytes(bytes)) return false;
      continue;
    }
    if (typeof value === "boolean") {
      if (!consumeBytes(value ? 4 : 5)) return false;
      continue;
    }
    if (typeof value === "number") {
      if (!consumeBytes(Number.isFinite(value) ? String(value).length : 4)) {
        return false;
      }
      continue;
    }
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);

    if (Array.isArray(value)) {
      if (
        value.length > READER_PAYLOAD_LIMITS.maxNodes - nodes - stack.length ||
        !consumeBytes(2 + Math.max(0, value.length - 1))
      ) {
        return false;
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        if (!(index in value)) return false;
        stack.push({ depth: current.depth + 1, value: value[index] });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Object.keys(value);
    if (
      keys.length > READER_PAYLOAD_LIMITS.maxNodes - nodes - stack.length ||
      !consumeBytes(2 + Math.max(0, keys.length - 1))
    ) {
      return false;
    }

    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      const keyBytes = jsonStringBytesWithin(
        key,
        READER_PAYLOAD_LIMITS.maxStringBytes,
        READER_PAYLOAD_LIMITS.maxBytes - payloadBytes,
      );
      if (keyBytes === undefined || !consumeBytes(keyBytes + 1)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return false;
      stack.push({ depth: current.depth + 1, value: descriptor.value });
    }
  }

  return true;
}

export type ReaderDocumentResolution =
  | {
      document: ReaderDocumentV1;
      schema: "reader.document.v1";
      status: "ready";
    }
  | {
      document: ReaderDocumentV2;
      schema: "reader.document.v2";
      status: "ready";
    }
  | {
      reason: "invalid-payload" | "unregistered-schema";
      status: "fallback";
    };

export function resolveReaderDocument(
  schema: string,
  payload: unknown,
): ReaderDocumentResolution {
  if (schema !== "reader.document.v1" && schema !== "reader.document.v2") {
    return { reason: "unregistered-schema", status: "fallback" };
  }

  let decoded = payload;
  if (typeof payload === "string") {
    if (!utf8ByteLengthWithin(payload, READER_PAYLOAD_LIMITS.maxBytes)) {
      return { reason: "invalid-payload", status: "fallback" };
    }
    try {
      decoded = JSON.parse(payload) as unknown;
    } catch {
      return { reason: "invalid-payload", status: "fallback" };
    }
  }

  try {
    if (!payloadIsWithinLimits(decoded)) {
      return { reason: "invalid-payload", status: "fallback" };
    }

    if (schema === "reader.document.v1") {
      const parsed = readerDocumentSchema.safeParse(decoded);
      if (!parsed.success) {
        return { reason: "invalid-payload", status: "fallback" };
      }
      return { document: parsed.data, schema, status: "ready" };
    }

    const parsed = readerDocumentV2Schema.safeParse(decoded);
    if (!parsed.success) {
      return { reason: "invalid-payload", status: "fallback" };
    }
    return { document: parsed.data, schema, status: "ready" };
  } catch {
    return { reason: "invalid-payload", status: "fallback" };
  }
}
