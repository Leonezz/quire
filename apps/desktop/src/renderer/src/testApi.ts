import { vi } from "vitest";
import type { ReadApi } from "../../shared/contracts";

/** A `read` whose every method is a vi.fn rejecting by default: a test stubs what it exercises, and anything else fails loudly. */
export function mockRead(overrides: Partial<ReadApi> = {}): ReadApi {
  const names: (keyof ReadApi)[] = [
    "onLibraryChanged", "importCorpus", "setTheme", "openUrl", "openFile", "getMaterial", "resolveImage", "listAnnotations", "saveAnnotation", "deleteAnnotation", "getMaterialBytes", "listMaterials",
    "detectSource", "addSource", "listSources", "syncSource", "syncAllSources", "pauseSource", "removeSource", "onSourcesChanged", "listInbox", "listQueue", "getItem", "readItem", "decideItem", "reorderQueue", "recordReadingEvent", "readingStats", "search",
    "agentStatus", "agentAsk", "agentInterrupt", "agentLogin", "onAgentEvent",
    "queryLibrary", "updateMaterialMeta", "listTags", "deleteMaterials", "keepItem", "getSettings", "updateSettings", "listAgentSessions", "getAgentSession", "deleteAgentSession", "onAgentSessionsChanged",
  ];
  const base = Object.fromEntries(names.map((name) => [name, vi.fn(async () => { throw new Error(`read.${name} is not stubbed in this test`); })])) as unknown as ReadApi;
  const subscriptions = { onLibraryChanged: () => () => undefined, onSourcesChanged: () => () => undefined, onAgentEvent: () => () => undefined, onAgentSessionsChanged: () => () => undefined };
  return { ...base, ...subscriptions, version: "test", platform: "test", ...overrides };
}

/** A promise the test settles by hand, to order responses. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
