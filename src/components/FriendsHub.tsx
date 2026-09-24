// Amis dans la vue agrandie : activité en cours, écrire (même sans conversation
// existante), appeler, ajouter un ami, gérer les demandes (demande user 15/09).
import { Focusable, TextField } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { useOpenChat } from "./ExpandedNav";
import { DANGER, ONLINE, listHalo } from "./Styled";
import { IcChat, IcPhone, IcRefresh } from "./Icons";
import { t, errText } from "../i18n";
import { openPersonMenu } from "./PersonMenu";

export type Presence = {
  status?: string;
  activity?: { type: number; name: string; details?: string; state?: string } | null;
  custom?: { text?: string; emoji?: string; emoji_id?: string | null; emoji_animated?: boolean } | null;
};
type Person = Presence & { id: string; username: string; global_name?: string | null; avatar?: string | null };
type Friends = { friends: Person[]; incoming: Person[]; outgoing: Person[] };
type Filter = "online" | "all" | "pending";

const STATUS_COLOR: Record<string, string> = { online: ONLINE, idle: "#f0b232", dnd: DANGER };

// « Joue à X · détails », « Écoute Spotify · titre — artiste », sinon le statut
// personnalisé. Exportée : la liste des MP affiche la même ligne.
export function activityLine(p?: Presence | null): string {
  const a = p?.activity;
  if (a && a.name) {
    const verbs: Record<number, string> = { 0: t("act_playing"), 1: t("act_streaming"), 2: t("act_listening"), 3: t("act_watching"), 5: t("act_competing") };
    const extra = a.type === 2 ? [a.details, a.state].filter(Boolean).join(" — ") : (a.details || "");
    return `${verbs[a.type] ?? t("act_playing")} ${a.name}${extra ? " · " + extra : ""}`;
  }
  const c = p?.custom;
  if (c?.text || c?.emoji) return `${c.emoji ? c.emoji + " " : ""}${c.text || ""}`.trim();
  return "";
}

export function Avatar({ person }: { person: Presence & { id: string; avatar?: string | null } }) {
  const url = person.avatar ? `https://cdn.discordapp.com/avatars/${person.id}/${person.avatar}.webp?size=64` : "https://cdn.discordapp.com/embed/avatars/0.png";
  const dot = STATUS_COLOR[person.status || ""];
  return <span style={{ position: "relative", width: 38, height: 38, flexShrink: 0 }}>
    <img src={url} width={38} height={38} style={{ width: 38, height: 38, borderRadius: "50%", objectFit: "cover" }} />
    {dot && <span style={{ position: "absolute", right: -1, bottom: -1, width: 12, height: 12, borderRadius: "50%", background: dot, border: "2px solid #11151d" }} />}
  </span>;
}

// `onSecondary` = bouton Y (menu de la personne), posé sur la rangée elle-même :
// sur un conteneur de liste, ces props cassent la navigation (cf. ChatFullscreen).
export function Btn({ onClick, children, on, grow, onSecondary }: { onClick: () => void; children: any; on?: boolean; grow?: boolean; onSecondary?: () => void }) {
  const [focused, setFocused] = useState(false);
  return <Focusable noFocusRing onClick={onClick} onActivate={onClick} onSecondaryButton={onSecondary} onSecondaryActionDescription={onSecondary ? t("xv_more") : undefined} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onGamepadFocus={() => setFocused(true)} onGamepadBlur={() => setFocused(false)} style={{ ...(grow ? { flex: 1, minWidth: 0 } : { flexShrink: 0 }), display: "flex", alignItems: "center", justifyContent: grow ? "flex-start" : "center", gap: 8, minHeight: 44, padding: "0 12px", borderRadius: 9, fontWeight: 600, background: on ? "rgba(88,101,242,.75)" : focused ? "rgba(88,101,242,.3)" : "rgba(255,255,255,.05)", ...listHalo(focused) }}>{children}</Focusable>;
}

function PersonRow({ person, pending, onDone }: { person: Person; pending?: "incoming" | "outgoing"; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openChat = useOpenChat();
  const name = person.global_name || person.username;
  const line = activityLine(person) || (pending === "incoming" ? t("friend_incoming") : pending === "outgoing" ? t("friend_outgoing") : `@${person.username}`);
  const run = async (fn: () => Promise<any>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  // Ouvre (ou crée) la conversation puis le chat plein écran par-dessus la vue.
  const message = () => run(async () => {
    const r: any = await call("open_dm", person.id);
    if (r?.id) openChat(r.id, name, true);
  });
  const phone = () => run(async () => {
    const r: any = await call("open_dm", person.id);
    if (r?.id) await call("dm_call", r.id, false);
  });
  const answer = (method: "friend_accept" | "friend_remove") => run(async () => {
    const r: any = await call(method, person.id);
    if (r?.ok) onDone(); else setError(r?.message || t("friend_add_failed"));
  });
  return <div style={{ marginBottom: 5 }}>
    <Focusable flow-children="row" style={{ display: "flex", gap: 6 }}>
      <Btn grow onClick={pending ? () => {} : message} onSecondary={() => openPersonMenu({ id: person.id, name, relationship: pending === "incoming" ? 3 : pending === "outgoing" ? 4 : 1 }, openChat, onDone)}>
        <Avatar person={person} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: "block", fontWeight: 650, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{name}</span>
          <span style={{ display: "block", marginTop: 2, fontSize: 11, fontWeight: 400, opacity: .62, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{line}</span>
        </span>
        {!pending && <IcChat />}
      </Btn>
      {busy ? <Btn onClick={() => {}}>…</Btn>
        : pending === "incoming" ? <><Btn onClick={() => answer("friend_accept")}>{t("friend_accept")}</Btn><Btn onClick={() => answer("friend_remove")}>{t("friend_decline")}</Btn></>
        : pending === "outgoing" ? <Btn onClick={() => answer("friend_remove")}>{t("friend_cancel")}</Btn>
        : <Btn onClick={phone}><IcPhone /> {t("call")}</Btn>}
    </Focusable>
    {error && <div style={{ color: "#ff7474", fontSize: 12, margin: "3px 4px 0" }}>{error}</div>}
  </div>;
}

export function FriendsHub() {
  const [data, setData] = useState<Friends | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("online");
  const [newName, setNewName] = useState("");
  const [addMsg, setAddMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const alive = useRef(true);

  const refresh = () => call<[], Friends>("get_friends")
    .then((r) => { if (alive.current && r) { setData(r); setError(null); } })
    .catch((e) => { if (alive.current) setError(errText(e)); });

  useEffect(() => {
    alive.current = true;
    refresh();
    // Les activités changent souvent (jeu lancé, morceau suivant) : 15 s suffit.
    const timer = setInterval(refresh, 15000);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);

  const sendRequest = async () => {
    const name = newName.trim();
    if (!name || adding) return;
    setAdding(true); setAddMsg(null);
    try {
      const r: any = await call("friend_request", name);
      if (r?.ok) { setAddMsg(t("friend_add_sent")); setNewName(""); refresh(); }
      else setAddMsg(r?.captcha ? t("friend_add_captcha") : `${t("friend_add_failed")}${r?.message ? " : " + r.message : ""}`);
    } catch (e) {
      setAddMsg(`${t("friend_add_failed")} : ${errText(e)}`);
    } finally {
      setAdding(false);
    }
  };

  if (error && !data) return <div style={{ color: "#ff7474" }}>{error}</div>;
  if (!data) return <div style={{ opacity: .65 }}>{t("loading")}</div>;

  const online = data.friends.filter((f) => f.status && f.status !== "offline");
  const pendingCount = data.incoming.length + data.outgoing.length;
  const shown = filter === "online" ? online : data.friends;

  return <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
    <Focusable flow-children="row" style={{ flexShrink: 0, display: "flex", gap: 6, marginBottom: 8 }}>
      <Btn on={filter === "online"} onClick={() => setFilter("online")}>{t("friends_online")} · {online.length}</Btn>
      <Btn on={filter === "all"} onClick={() => setFilter("all")}>{t("friends_all")} · {data.friends.length}</Btn>
      <Btn on={filter === "pending"} onClick={() => setFilter("pending")}>{t("friends_pending")}{pendingCount ? ` · ${pendingCount}` : ""}</Btn>
      <Btn onClick={refresh}><IcRefresh /></Btn>
    </Focusable>
    {/* Seule la liste défile : barre de filtres et ajout restent en place. */}
    <Focusable flow-children="column" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "3px 8px 3px 3px" }}>
      {filter === "pending" ? <>
        <Focusable flow-children="row" style={{ display: "flex", gap: 6, alignItems: "flex-end", marginBottom: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <TextField label={t("friend_add_label")} value={newName} onChange={(e: any) => setNewName(String(e?.target?.value ?? "").slice(0, 64))} />
          </div>
          <Btn onClick={sendRequest}>{adding ? "…" : t("friend_add_send")}</Btn>
        </Focusable>
        {addMsg && <div style={{ fontSize: 12, opacity: .85, margin: "0 4px 10px" }}>{addMsg}</div>}
        {data.incoming.map((p) => <PersonRow key={p.id} person={p} pending="incoming" onDone={refresh} />)}
        {data.outgoing.map((p) => <PersonRow key={p.id} person={p} pending="outgoing" onDone={refresh} />)}
        {pendingCount === 0 && <div style={{ opacity: .6, margin: "6px 4px" }}>{t("friends_no_pending")}</div>}
      </> : <>
        {shown.map((p) => <PersonRow key={p.id} person={p} onDone={refresh} />)}
        {shown.length === 0 && <div style={{ opacity: .6, margin: "6px 4px" }}>{t("friends_none")}</div>}
      </>}
    </Focusable>
  </div>;
}
