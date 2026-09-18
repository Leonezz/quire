import { useCallback, useEffect, useState } from "react";
import type { ItemRecord, SourceRecord } from "../../shared/contracts";
import { read } from "./api";

export interface Lists {
  inbox: ItemRecord[];
  queue: ItemRecord[];
  sources: SourceRecord[];
  /** The last load failure, if any: shown in the shell, never swallowed. */
  error: string | undefined;
  refresh: () => Promise<void>;
}

/** Inbox, Queue and Sources, loaded together: on mount, when the engine reports a change, and after every decision. */
export function useLists(): Lists {
  const [inbox, setInbox] = useState<ItemRecord[]>([]);
  const [queue, setQueue] = useState<ItemRecord[]>([]);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const [nextInbox, nextQueue, nextSources] = await Promise.all([read.listInbox(), read.listQueue(), read.listSources()]);
      setInbox(nextInbox); setQueue(nextQueue); setSources(nextSources); setError(undefined);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not load the lists.");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => read.onSourcesChanged(() => { void refresh(); }), [refresh]);

  return { inbox, queue, sources, error, refresh };
}
