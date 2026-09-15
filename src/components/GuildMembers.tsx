// Membres d'un serveur dans la vue agrandie, groupés comme dans Discord (rôles
// affichés à part, puis hors ligne), avec rôles, activité, et les gestes
// Message / Ajouter en ami (demande user 15/09).
import { Focusable } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { useOpenChat } from "./ExpandedNav";
import { Avatar, Btn, activityLine, Presence } from "./FriendsHub";
import { ONLINE } from "./Styled";
import { IcChat, IcRefresh } from "./Icons";
import { t, errText } from "../i18n";
import { openPersonMenu } from "./PersonMenu";

type GroupRow = { type: "group"; id: string; title: string; count: number };
type MemberRow = Presence & {
  type: "member"; id: string; username: string; global_name?: string | null; nick?: string | null;
  avatar?: string | null; color?: string | null; bot?: boolean; roles: string[]; relationship: number; self?: boolean;
};
type Row = GroupRow | MemberRow;

// RelationshipStore : 1 = ami, 3 = demande reçue, 4 = demande envoyée.
const REL_FRIEND = 1, REL_OUTGOING = 4;

function Member({ m }: { m: MemberRow }) {
  const openChat = useOpenChat();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = m.nick || m.global_name || m.username;
  const sub = activityLine(m) || m.roles.join(" · ") || `@${m.username}`;
  const run = async (fn: () => Promise<any>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const message = () => run(async () => {
    const r: any = await call("open_dm", m.id);
    if (r?.id) openChat(r.id, name, true);
  });
  const addFriend = () => run(async () => {
    const r: any = await call("friend_add", m.id);
    if (r?.ok) setSent(true);
    else setError(r?.captcha ? t("friend_add_captcha") : (r?.message || t("friend_add_failed")));
  });
  const label = (text: string) => <span style={{ alignSelf: "center", padding: "0 10px", fontSize: 12, opacity: .6, flexShrink: 0 }}>{text}</span>;
  return <div style={{ marginBottom: 4 }}>
    <Focusable flow-children="row" style={{ display: "flex", gap: 6 }}>
      <Btn grow onClick={m.self ? () => {} : message} onSecondary={m.self ? undefined : () => openPersonMenu({ id: m.id, name, relationship: sent ? 4 : m.relationship }, openChat)}>
        <Avatar person={m} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: "block", fontWeight: 650, color: m.color || undefined, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
            {name}{m.bot ? " · BOT" : ""}
          </span>
          <span style={{ display: "block", marginTop: 2, fontSize: 11, fontWeight: 400, opacity: .62, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{sub}</span>
        </span>
        {!m.self && <IcChat />}
      </Btn>
      {m.self ? label(t("member_you"))
        : busy ? <Btn onClick={() => {}}>…</Btn>
        : m.relationship === REL_FRIEND ? label(t("member_friend"))
        : (m.relationship === REL_OUTGOING || sent) ? label(t("member_sent"))
        : m.bot ? null
        : <Btn tint={ONLINE} onClick={addFriend}>{t("member_add")}</Btn>}
    </Focusable>
    {error && <div style={{ color: "#ff7474", fontSize: 12, margin: "3px 4px 0" }}>{error}</div>}
  </div>;
}

export function GuildMembers({ guildId }: { guildId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [end, setEnd] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = async (start: number) => {
    setLoading(true);
    try {
      const r: any = await call("get_guild_members", guildId, start);
      if (!alive.current) return;
      const next: Row[] = Array.isArray(r?.rows) ? r.rows : [];
      setRows((prev) => (start === 0 || !prev ? next : [...prev, ...next]));
      setEnd(r?.end || 0);
      setTotalRows(r?.total_rows || 0);
      setError(null);
    } catch (e) {
      if (alive.current) setError(errText(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  };

  useEffect(() => {
    alive.current = true;
    load(0);
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId]);

  if (error && !rows) return <div style={{ color: "#ff7474" }}>{error}</div>;
  if (!rows) return <div style={{ opacity: .65 }}>{t("loading")}</div>;

  return <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
    <Focusable flow-children="row" style={{ flexShrink: 0, display: "flex", gap: 6, marginBottom: 8 }}>
      <Btn onClick={() => load(0)}><IcRefresh /></Btn>
    </Focusable>
    {/* Seule la liste défile (même règle que le reste de la vue). */}
    <Focusable flow-children="column" style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 8 }}>
      {rows.map((row, i) => row.type === "group"
        ? <div key={`g${row.id}-${i}`} style={{ fontSize: 11, fontWeight: 800, letterSpacing: .7, opacity: .5, margin: `${i ? 12 : 2}px 0 6px` }}>{row.title.toUpperCase()} — {row.count}</div>
        : <Member key={row.id} m={row} />)}
      {rows.length === 0 && <div style={{ opacity: .6, margin: "6px 4px" }}>{t("members_empty")}</div>}
      {end < totalRows && <Btn onClick={() => load(end)}>{loading ? "…" : t("members_more")}</Btn>}
    </Focusable>
  </div>;
}
