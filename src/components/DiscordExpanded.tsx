// Vue Discord étendue native Steam : aucune BrowserView CEF pré-Vesktop.
import { Focusable, ModalRoot, NavEntryPositionPreferences, showModal } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { ChatView } from "./ChatFullscreen";
import { ExpandedNavContext } from "./ExpandedNav";
import { useSteamcordState } from "../hooks/useSteamcordState";
import { EVENT_ACTIVE, EventDetail, SCEvent, whenLabel } from "./EventsPanel";
import { ACCENT, DANGER, FULL_BLEED, ONLINE, chromeHideMarkerRef, focusHalo } from "./Styled";
import { IcBell, IcChat, IcGear, IcHome, IcPhone, IcUser } from "./Icons";
import { t } from "../i18n";
import { FaUserFriends } from "react-icons/fa";
import { FriendsHub, activityLine } from "./FriendsHub";
import { GuildMembers } from "./GuildMembers";
import { openPersonMenu } from "./PersonMenu";
import { useOpenChat } from "./ExpandedNav";

const ModalRootAny = ModalRoot as any;
type Recipient = { id: string; avatar: string | null; status?: string; activity?: any; custom?: any };
type Dm = { id: string; name: string; icon: string | null; type: number; recipients: Recipient[]; active_call?: boolean };
type Mode = "dms" | "friends" | "servers" | "events" | "call" | "settings";
// Une page du bloc de droite. Un chat retient la section d'où il a été ouvert,
// pour garder la barre latérale allumée dessus.
type Page = { kind: "section"; mode: Mode }
  | { kind: "chat"; mode: Mode; channelId: string; name: string; isDm: boolean }
  | { kind: "members"; mode: Mode; guildId: string; name: string };
const NAV_MAX = 30;

// La navigation manette appelle scrollIntoView sur l'élément focalisé, et le
// navigateur fait défiler TOUS les ancêtres, overflow:hidden compris : la carte
// entière montait et la barre latérale sortait de l'écran (retour user 15/09).
// Seule la colonne de droite a le droit de défiler ; les autres sont ramenées.
const pinTop = (e: any) => { if (e.currentTarget.scrollTop) e.currentTarget.scrollTop = 0; };

function Avatar({ dm }: { dm: Dm }) {
  const name = dm.name || "?";
  const url = dm.type === 3 && dm.icon ? `https://cdn.discordapp.com/channel-icons/${dm.id}/${dm.icon}.webp?size=64`
    : dm.recipients?.[0]?.avatar ? `https://cdn.discordapp.com/avatars/${dm.recipients[0].id}/${dm.recipients[0].avatar}.webp?size=64` : null;
  const base = { width: 38, height: 38, borderRadius: "50%", objectFit: "cover" as const, flexShrink: 0 };
  return url ? <img src={url} width={38} height={38} style={base} /> : <div style={{ ...base, background: "linear-gradient(135deg,#5865f2,#8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{name[0]?.toUpperCase()}</div>;
}

function SidebarItem({ active, icon, label, badge, onPick }: { active: boolean; icon: any; label: string; badge?: any; onPick: () => void }) {
  const [focused, setFocused] = useState(false);
  return <Focusable onClick={onPick} onActivate={onPick} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onGamepadFocus={() => setFocused(true)} onGamepadBlur={() => setFocused(false)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px", borderRadius: 8, marginBottom: 5, background: active ? "rgba(88,101,242,.82)" : focused ? "rgba(255,255,255,.13)" : "transparent", fontWeight: active ? 700 : 500, ...focusHalo("#fff", focused, 1.02) }}>{icon}<span style={{ flex: 1 }}>{label}</span>{badge}</Focusable>;
}

function Tile({ children, onClick, flex, active, tint = ACCENT, onSecondary }: { children: any; onClick: () => void; flex?: boolean; active?: boolean; tint?: string; onSecondary?: () => void }) {
  const [focused, setFocused] = useState(false);
  return <Focusable onClick={onClick} onActivate={onClick} onSecondaryButton={onSecondary} onSecondaryActionDescription={onSecondary ? t("xv_more") : undefined} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onGamepadFocus={() => setFocused(true)} onGamepadBlur={() => setFocused(false)} style={{ ...(flex ? { flex: 1, minWidth: 0 } : { flexShrink: 0 }), display: "flex", alignItems: "center", gap: 11, padding: "10px 12px", borderRadius: 9, background: active ? "rgba(35,165,90,.38)" : focused ? "rgba(88,101,242,.28)" : "rgba(255,255,255,.045)", ...focusHalo(tint, focused, flex ? 1.01 : 1.03) }}>{children}</Focusable>;
}

// Une conversation privée = son chat ET son appel, sur la même ligne (comme
// Serveurs réunit salons texte et vocaux) : A ouvre le chat, droite puis A
// appelle ou rejoint l'appel en cours.
function DmRow({ dm, onOpen }: { dm: Dm; onOpen: () => void }) {
  const [busy, setBusy] = useState(false);
  const openChat = useOpenChat();
  // Y : menu de la personne pour un MP à deux (un groupe n'a pas de « personne »).
  const other = dm.type !== 3 ? dm.recipients?.[0] : undefined;
  const menu = other ? () => openPersonMenu({ id: other.id, name: dm.name || "MP", relationship: (other as any).relationship, dmChannelId: dm.id }, openChat) : undefined;
  const onCall = () => {
    if (busy) return;
    setBusy(true);
    call("dm_call", dm.id, !!dm.active_call).catch(() => {}).finally(() => setTimeout(() => setBusy(false), 2000));
  };
  // MP à deux : l'activité en cours de la personne passe avant « Message privé ».
  const sub = dm.active_call ? t("xv_call") : dm.type === 3 && dm.recipients?.length ? t("members", { count: dm.recipients.length + 1 }) : (activityLine(dm.recipients?.[0]) || t("private_message"));
  return <Focusable flow-children="row" style={{ display: "flex", gap: 6, marginBottom: 5 }}>
    <Tile flex onClick={onOpen} onSecondary={menu}>
      <Avatar dm={dm} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", fontWeight: 650, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{dm.name || "MP"}</span>
        <span style={{ display: "block", marginTop: 2, fontSize: 11, opacity: dm.active_call ? .9 : .58, color: dm.active_call ? ONLINE : undefined, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{sub}</span>
      </span>
      <IcChat />
    </Tile>
    <Tile onClick={onCall} active={dm.active_call} tint={ONLINE}>
      <span style={{ width: 104, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, fontWeight: 650 }}>{busy ? "…" : <><IcPhone /> {dm.active_call ? t("join") : t("call")}</>}</span>
    </Tile>
  </Focusable>;
}

// Tous les événements de tous les serveurs, en un seul endroit : sous chaque
// serveur ils n'apparaissent qu'une fois ce serveur ouvert, donc introuvables
// quand on ne sait pas lequel en a (retour user 15/09).
function EventRow({ ev }: { ev: SCEvent }) {
  const [busy, setBusy] = useState(false);
  const live = ev.status === EVENT_ACTIVE;
  const meta = [ev.guild, live ? "" : whenLabel(ev.start), ev.location, ev.count ? `${ev.count} ${t("event_interested_count")}` : ""].filter(Boolean).join(" · ");
  const join = () => {
    if (busy || !ev.channel_id) return;
    setBusy(true);
    call("join_vc", ev.channel_id, ev.guild_id).catch(() => {}).finally(() => setTimeout(() => setBusy(false), 1500));
  };
  return <Focusable flow-children="row" style={{ display: "flex", gap: 6, marginBottom: 5 }}>
    <Tile flex onClick={() => showModal(<EventDetail ev={ev} />)}>
      {ev.image ? <img src={`https://cdn.discordapp.com/guild-events/${ev.id}/${ev.image}.png?size=128`} style={{ width: 68, height: 38, objectFit: "cover", borderRadius: 6, flexShrink: 0 }} /> : <span style={{ width: 38, height: 38, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(88,101,242,.3)", flexShrink: 0 }}><IcBell /></span>}
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", fontWeight: 650, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
          {live && <span style={{ color: DANGER, fontSize: 12, fontWeight: 700 }}>● {t("event_live")} </span>}{ev.name}
        </span>
        {meta && <span style={{ display: "block", marginTop: 2, fontSize: 11, opacity: .58, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{meta}</span>}
      </span>
    </Tile>
    {live && ev.channel_id && <Tile onClick={join}><span style={{ width: 104, textAlign: "center", fontWeight: 650 }}>{busy ? "…" : t("event_join")}</span></Tile>}
  </Focusable>;
}

export function DiscordExpandedModal({ closeModal, serverContent, callContent, settingsContent }: { closeModal?: () => void; serverContent?: any; callContent?: any; settingsContent?: any }) {
  // Historique (demande user 15/09) : sections et chats s'empilent dans le bloc
  // de droite ; L1 recule, R1 avance, B recule puis ferme. Changer de page ne
  // coupe rien — appel, Go Live, direct : c'est seulement l'affichage.
  const [nav, setNav] = useState<{ pages: Page[]; index: number }>({ pages: [{ kind: "section", mode: "dms" }], index: 0 });
  const navRef = useRef(nav);
  navRef.current = nav;
  const page = nav.pages[nav.index];
  const mode = page.mode;
  const navigate = (next: Page) => setNav((cur) => {
    if (JSON.stringify(cur.pages[cur.index]) === JSON.stringify(next)) return cur;
    const pages = [...cur.pages.slice(0, cur.index + 1), next].slice(-NAV_MAX);
    return { pages, index: pages.length - 1 };
  });
  const go = (m: Mode) => navigate({ kind: "section", mode: m });
  const openChat = (channelId: string, name: string, isDm: boolean) => navigate({ kind: "chat", mode, channelId, name, isDm });
  const openMembers = (guildId: string, name: string) => navigate({ kind: "members", mode, guildId, name });
  const back = () => {
    if (navRef.current.index === 0) return false;
    setNav((cur) => ({ ...cur, index: Math.max(0, cur.index - 1) }));
    return true;
  };
  const forward = () => setNav((cur) => ({ ...cur, index: Math.min(cur.pages.length - 1, cur.index + 1) }));
  // Rejoindre un appel (salon vocal, MP, événement) → la vue passe sur « Appel en
  // cours » (demande user 15/09). Seulement quand l'appel CHANGE : rester sur
  // une autre page pendant l'appel reste possible, et L1/B ramène d'où l'on vient.
  const vcId: string | null = useSteamcordState()?.vc?.channel_id ?? null;
  const lastVcId = useRef<string | null>(null);
  useEffect(() => {
    if (vcId && vcId !== lastVcId.current) go("call");
    lastVcId.current = vcId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vcId]);
  // Un même appui peut arriver par deux chemins (prop du Focusable ET écouteur
  // DOM ci-dessous) : on n'agit qu'une fois.
  const lastNavAt = useRef(0);
  const navOnce = (fn: () => boolean | void) => {
    const now = Date.now();
    if (now - lastNavAt.current < 120) return true;
    lastNavAt.current = now;
    return fn();
  };
  // B, L1, R1 écoutés sur un VRAI nœud DOM, en capture. Quand le focus est dans
  // le chat intégré, B ne passait pas par onCancel : il remontait jusqu'à la
  // fenêtre, qui se fermait et rendait la main au QAM (retour user 15/09). Même
  // parade que backNav.tsx : les props d'un Focusable ne sont pas toujours
  // câblées, l'événement vgp_* de Steam, lui, arrive toujours.
  const attachNav = (el: HTMLDivElement | null) => {
    if (!el || (el as any).__scExpandedNav) return;
    (el as any).__scExpandedNav = true;
    el.addEventListener("vgp_oncancel", (e: Event) => {
      if (navRef.current.index === 0) return; // rien derrière : la vue se ferme normalement
      e.preventDefault();
      e.stopPropagation();
      (e as any).stopImmediatePropagation?.();
      navOnce(back);
    }, true);
    el.addEventListener("vgp_onbuttondown", (e: any) => {
      const b = e?.detail?.button;
      if (b === 5) navOnce(back);
      else if (b === 6) navOnce(forward);
    }, true);
  };
  const [dms, setDms] = useState<Dm[] | null>(null);
  const [events, setEvents] = useState<SCEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () => call<[], any>("get_dm_channels").then((next) => {
      if (!live) return;
      // Appels en cours en tête, comme la liste du QAM.
      const list: Dm[] = Array.isArray(next) ? next : [];
      setDms([...list].sort((a, b) => (b.active_call ? 1 : 0) - (a.active_call ? 1 : 0)));
      setError(null);
    }).catch((e: any) => { if (live) setError(String(e?.message ?? e)); });
    const loadEvents = () => call<[], SCEvent[]>("get_events").then((r) => { if (live) setEvents(Array.isArray(r) ? r : []); }).catch(() => { if (live) setEvents([]); });
    refresh();
    loadEvents();
    // Un appel qui démarre ou s'arrête pendant que la liste est ouverte doit
    // changer « Appeler » ↔ « Rejoindre » sans rouvrir la vue.
    const timer = setInterval(refresh, 4000);
    const eventsTimer = setInterval(loadEvents, 60000);
    return () => { live = false; clearInterval(timer); clearInterval(eventsTimer); };
  }, []);
  // La liste reste ouverte sous le chat : B ferme d'abord le chat puis rend la
  // même position de navigation, au lieu de renvoyer brutalement au QAM.
  const open = (id: string, name: string) => openChat(id, name, true);
  const liveEvents = (events || []).filter((ev) => ev.status === EVENT_ACTIVE).length;
  const titles: Record<Mode, [string, string]> = {
    dms: [t("xv_dms"), t("xv_dm_sub")],
    friends: [t("friends"), t("friends_sub")],
    servers: [t("tab_servers"), t("xv_servers_sub")],
    events: [t("events"), t("xv_events_sub")],
    call: [t("xv_call"), t("xv_call_sub")],
    settings: [t("xv_settings"), t("xv_settings_sub")],
  };
  const scroller = { flex: 1, minHeight: 0, overflowY: "auto" as const, paddingRight: 8 };
  const eventsBadge = events && events.length > 0
    ? <span style={{ fontSize: 12, fontWeight: 700, color: liveEvents ? DANGER : undefined, opacity: liveEvents ? 1 : .6 }}>{liveEvents ? `● ${liveEvents}` : events.length}</span>
    : undefined;
  const head: [string, string] = page.kind === "chat"
    ? [page.isDm ? page.name : `#${page.name}`, page.isDm ? t("private_message") : t("xv_text_channel")]
    : page.kind === "members" ? [page.name, t("xv_members")]
    : titles[mode];
  const canBack = nav.index > 0, canForward = nav.index < nav.pages.length - 1;
  return <ExpandedNavContext.Provider value={{ openChat, openMembers }}><ModalRootAny closeModal={closeModal} onCancel={() => { if (!navOnce(back)) closeModal?.(); }} bAllowFullSize>
    <div ref={attachNav} style={{ display: "contents" }}>
    <Focusable flow-children="row" onScroll={pinTop}
      // L1 = 5, R1 = 6 (GamepadButton de @decky/ui) ; même mécanisme que B dans backNav.
      onButtonDown={(e: any) => { const b = e?.detail?.button; if (b === 5) navOnce(back); else if (b === 6) navOnce(forward); }} style={{ ...FULL_BLEED, height: "80vh", display: "flex", overflow: "hidden", borderRadius: 12, background: "#11151d", boxShadow: "0 22px 60px rgba(0,0,0,.55)" }}>
      <div ref={chromeHideMarkerRef} style={{ display: "none" }} />
      <Focusable flow-children="column" onScroll={pinTop} style={{ width: 268, flexShrink: 0, padding: 14, overflow: "hidden", display: "flex", flexDirection: "column", background: "#20252f", borderRight: "1px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px 17px", fontSize: 18, fontWeight: 800 }}><IcHome /> Steamcord</div>
        <div style={{ fontSize: 11, letterSpacing: .8, fontWeight: 700, opacity: .48, padding: "0 10px 7px" }}>{t("xv_navigation")}</div>
        <SidebarItem active={mode === "dms"} icon={<IcUser />} label={t("xv_dms")} onPick={() => go("dms")} />
        <SidebarItem active={mode === "friends"} icon={<FaUserFriends />} label={t("friends")} onPick={() => go("friends")} />
        <SidebarItem active={mode === "servers"} icon={<IcChat />} label={t("tab_servers")} onPick={() => go("servers")} />
        <SidebarItem active={mode === "events"} icon={<IcBell />} label={t("events")} badge={eventsBadge} onPick={() => go("events")} />
        <SidebarItem active={mode === "call"} icon={<IcPhone />} label={t("xv_call")} onPick={() => go("call")} />
        <SidebarItem active={mode === "settings"} icon={<IcGear />} label={t("xv_settings")} onPick={() => go("settings")} />
        <div style={{ marginTop: "auto", padding: "12px 9px 2px", opacity: .48, fontSize: 11 }}>{t("xv_back")}</div>
      </Focusable>
      <Focusable flow-children="column" navEntryPreferPosition={NavEntryPositionPreferences.FIRST} onScroll={pinTop} style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column", padding: "24px 28px 18px" }}>
        <div style={{ flexShrink: 0, display: "flex", alignItems: "baseline", gap: 12, borderBottom: "1px solid rgba(255,255,255,.09)", paddingBottom: 15, marginBottom: 14 }}><div style={{ fontSize: 23, fontWeight: 800, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{head[0]}</div><div style={{ opacity: .52, fontSize: 13, flexShrink: 0 }}>{head[1]}</div>{(canBack || canForward) && <div style={{ marginLeft: "auto", opacity: .45, fontSize: 11, flexShrink: 0 }}>{canBack ? "L1 ◀" : ""}{canBack && canForward ? "  ·  " : ""}{canForward ? "▶ R1" : ""}</div>}</div>
        {page.kind === "chat" ? <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}><ChatView key={page.channelId} channelId={page.channelId} channelName={page.name} isDm={page.isDm} embedded /></div>
          : page.kind === "members" ? <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}><GuildMembers key={page.guildId} guildId={page.guildId} /></div>
          : mode === "friends" ? <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}><FriendsHub /></div>
          : mode === "servers" ? <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{serverContent || <div style={{ opacity: .6 }}>{t("loading_servers")}</div>}</div>
          : mode === "events" ? (events === null ? <div style={{ opacity: .65 }}>{t("loading")}</div>
            : events.length === 0 ? <div style={{ opacity: .62, lineHeight: 1.6 }}>{t("xv_no_events")}</div>
            : <Focusable flow-children="column" style={scroller}>
              {/* En direct d'abord, puis par date de début. */}
              {[...events].sort((a, b) => (b.status === EVENT_ACTIVE ? 1 : 0) - (a.status === EVENT_ACTIVE ? 1 : 0) || String(a.start || "").localeCompare(String(b.start || ""))).map((ev) => <EventRow key={ev.id} ev={ev} />)}
            </Focusable>)
          : mode === "call" ? <div style={scroller}>{callContent}</div>
          : mode === "settings" ? <div style={scroller}>{settingsContent || <div style={{ opacity: .6 }}>{t("xv_loading_settings")}</div>}</div>
          : error ? <div style={{ color: "#ff7474" }}>{error}</div>
          : dms === null ? <div style={{ opacity: .65 }}>{t("loading")}</div>
          : <Focusable flow-children="column" style={scroller}>
            {dms.map((dm) => <DmRow key={dm.id} dm={dm} onOpen={() => open(dm.id, dm.name || "MP")} />)}
            {dms.length === 0 && <div style={{ opacity: .6 }}>{t("no_dms")}</div>}
          </Focusable>}
      </Focusable>
    </Focusable>
  </div></ModalRootAny></ExpandedNavContext.Provider>;
}
