import { addEventListener, call, removeEventListener } from "@decky/api";
import { useEffect, useState } from "react";
import { errText } from "../i18n";

// Shared policy for voice, text QAM and Big Screen. Retain the last good list
// on transient errors; keyed rows are updated without unmounting the list.
export function useDmChannels<T>(enabled = true) {
  const [channels, setChannels] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true, running = false, pending = false;
    const refresh = async () => {
      if (!live) return;
      if (running) { pending = true; return; }
      running = true;
      try {
        const result = await call<[], T[]>("get_dm_channels");
        if (!Array.isArray(result)) throw new Error("Invalid conversation list");
        if (live) { setChannels(result); setError(null); }
      } catch (e) { if (live) setError(errText(e)); }
      finally {
        running = false;
        if (live && pending) { pending = false; void refresh(); }
      }
    };
    addEventListener("dm_channels_changed", refresh);
    void refresh();
    const timer = setInterval(refresh, 4000); // recovery / call-state fallback
    return () => { live = false; clearInterval(timer); removeEventListener("dm_channels_changed", refresh); };
  }, [enabled]);
  return { channels, error };
}
