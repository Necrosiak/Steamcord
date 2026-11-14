// Fils et forums (#100) : données côté frontend. Le rendu est dans
// components/ThreadBrowser.tsx, partagé par le QAM et la vue agrandie.
import { call } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { errCode } from "./i18n";

export interface ThreadInfo { id: string; name: string; parent_id?: string; archived?: boolean; count?: number; last?: string; tags?: string[] }
export interface ForumTag { id: string; name: string; emoji: string | null }
export interface ThreadParent { kind: "forum" | "text"; can_create: boolean; require_tag: boolean; tags: ForumTag[] }
type ThreadPage = { threads: ThreadInfo[]; has_more?: boolean; next?: number; total?: number | null; parent?: ThreadParent };

// Salons qui ne reçoivent pas de messages directs : chaque publication est un fil.
export const isForumChannel = (type?: number) => type === 15 || type === 16;

export interface ThreadFilter { name: string; tags: string[] }
export const NO_FILTER: ThreadFilter = { name: "", tags: [] };

// Liste des fils d'un salon (ou publications d'un forum), chargée à la
// demande puis page par page (`more`). Tout changement de filtre repart de
// la première page ; une réponse arrivée après coup est ignorée.
export function useThreads(channelId: string | null, filter: ThreadFilter = NO_FILTER) {
  const [threads, setThreads] = useState<ThreadInfo[] | null>(null);
  const [parent, setParent] = useState<ThreadParent | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const next = useRef(0);
  const seq = useRef(0);
  const key = filter.name + "\u0000" + filter.tags.join(",");

  const load = (offset: number) => {
    if (!channelId) return;
    const mine = seq.current;
    setError(null);
    if (offset > 0) setLoadingMore(true);
    call<[string, number, string, string[]], ThreadPage>("get_threads", channelId, offset, filter.name, filter.tags)
      .then((r) => {
        if (seq.current !== mine) return;
        const page = Array.isArray(r?.threads) ? r.threads : [];
        next.current = Number(r?.next) || 0;
        setHasMore(!!r?.has_more);
        if (offset === 0) { setTotal(r?.total ?? null); if (r?.parent) setParent(r.parent); }
        // Une page suivante peut recroiser un fil déjà affiché (activité entre-temps).
        setThreads((prev) => {
          if (offset === 0 || !prev) return page;
          const seen = new Set(prev.map((t) => t.id));
          return prev.concat(page.filter((t) => !seen.has(t.id)));
        });
      })
      .catch((e: any) => { if (seq.current === mine) { setThreads((prev) => prev ?? []); setError(errCode(e)); } })
      .finally(() => { if (seq.current === mine) setLoadingMore(false); });
  };
  const reload = () => { seq.current++; setHasMore(false); next.current = 0; load(0); };

  useEffect(() => { seq.current++; setThreads(null); setHasMore(false); next.current = 0; load(0); return () => { seq.current++; }; }, [channelId, key]);
  useEffect(() => { setParent(null); }, [channelId]);
  return { threads, parent, total, error, hasMore, loadingMore, more: () => { if (!loadingMore) load(next.current); }, reload };
}

export function createThread(channelId: string, name: string, content: string, tags: string[]): Promise<ThreadInfo> {
  return call<[string, string, string, string[]], ThreadInfo>("create_thread", channelId, name, content, tags);
}

// Valeur saisie retardée : on ne relance pas une recherche à chaque lettre.
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}
