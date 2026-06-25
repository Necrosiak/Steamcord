import { DialogButton } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t } from "../i18n";

interface DMRecipient { id: string; username: string; avatar: string | null; }
interface DMChannel {
  id: string;
  type: number;
  name: string;
  icon: string | null;
  recipients: DMRecipient[];
  active_call: boolean;
}

const Btn = DialogButton as any;

function DMAvatar({ ch }: { ch: DMChannel }) {
  if (ch.type === 3 && ch.icon) {
    return (
      <img
        src={`https://cdn.discordapp.com/channel-icons/${ch.id}/${ch.icon}.webp?size=32`}
        width={24} height={24}
        style={{ borderRadius: "50%", flexShrink: 0 }}
      />
    );
  }
  if (ch.recipients.length >= 1) {
    const r = ch.recipients[0];
    return (
      <img
        src={r.avatar
          ? `https://cdn.discordapp.com/avatars/${r.id}/${r.avatar}.webp?size=32`
          : `https://cdn.discordapp.com/embed/avatars/0.png`}
        width={24} height={24}
        style={{ borderRadius: "50%", flexShrink: 0 }}
      />
    );
  }
  return (
    <div style={{
      width: 24, height: 24, borderRadius: "50%",
      background: "#5865f2", flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 10, color: "#fff"
    }}>
      {ch.name[0]?.toUpperCase()}
    </div>
  );
}

function DMRow({ ch }: { ch: DMChannel }) {
  const [busy, setBusy] = useState(false);

  const onCall = async () => {
    setBusy(true);
    await call("dm_call", ch.id, ch.active_call);
    setTimeout(() => setBusy(false), 2000);
  };

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 6,
      padding: "6px 8px", marginBottom: 4, borderRadius: 6, boxSizing: "border-box",
      background: ch.active_call ? "rgba(35,165,90,0.12)" : "rgba(255,255,255,0.04)",
      border: ch.active_call ? "1px solid rgba(35,165,90,0.35)" : "1px solid transparent",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <DMAvatar ch={ch} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {ch.name}
          </div>
          {ch.type === 3 && ch.recipients.length > 0 && (
            <div style={{ fontSize: 10, opacity: 0.5 }}>{t("members", { count: ch.recipients.length + 1 })}</div>
          )}
        </div>
        {ch.active_call && (
          <span style={{ fontSize: 9, color: "#23a55a", flexShrink: 0 }}>● {t("in_call")}</span>
        )}
      </div>
      <Btn
        onClick={onCall}
        style={{
          width: "100%", margin: 0, padding: "4px 0", fontSize: 11,
          minHeight: 0, minWidth: 0, boxSizing: "border-box",
          background: ch.active_call ? "#23a55a" : undefined,
        }}
      >
        {busy ? "…" : ch.active_call ? `📞 ${t("join")}` : `📞 ${t("call")}`}
      </Btn>
    </div>
  );
}

export function DMBrowser() {
  const [channels, setChannels] = useState<DMChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    call<[], any>("get_dm_channels")
      .then(res => {
        if (Array.isArray(res)) {
          const sorted = [...res].sort((a, b) => (b.active_call ? 1 : 0) - (a.active_call ? 1 : 0));
          setChannels(sorted);
          setError(null);
        } else {
          setError(t("error") + JSON.stringify(res));
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    // Keep "EN CALL" / "Rejoindre" in sync — a call ending while the list is open
    // wouldn't update otherwise.
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, []);

  if (error)
    return <div style={{ padding: 8, color: "#ff6b6b", fontSize: 12 }}>{error}</div>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
        <Btn onClick={refresh} style={{ padding: "2px 8px", fontSize: 10, minHeight: 0 }}>↻</Btn>
      </div>
      {loading && channels.length === 0 ? (
        <div style={{ padding: 8, opacity: 0.6, fontSize: 13 }}>{t("loading")}</div>
      ) : channels.length === 0 ? (
        <div style={{ padding: 8, opacity: 0.6, fontSize: 13 }}>{t("no_dms")}</div>
      ) : (
        <div style={{ maxHeight: 280, overflowY: "auto" }}>
          {channels.map(ch => <DMRow key={ch.id} ch={ch} />)}
        </div>
      )}
    </div>
  );
}
