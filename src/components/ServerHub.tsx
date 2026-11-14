// Arborescence Discord unifiée : un serveur, puis ses événements, ses salons
// texte et ses salons vocaux. Reprend TOUT ce que le QAM sait faire sur les
// serveurs (événements, membres en vocal, masquer, réorganiser, actualiser),
// en réutilisant ses composants plutôt qu'en les réécrivant.
import { Focusable, showModal } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { useOpenChat, useOpenMembers } from "./ExpandedNav";
import { FaUsers } from "react-icons/fa";
import { DANGER, ONLINE, listHalo } from "./Styled";
import { IcChat, IcChevronDown, IcChevronUp, IcEye, IcEyeSlash, IcForum, IcRefresh, IcReorder, IcSpeaker, IcThread } from "./Icons";
import { GuildFolder, folderLabel, groupByFolder, folderColor, useOpenFolders } from "../guildFolders";
import { ThreadInfo, isForumChannel } from "../threads";
import { ThreadBrowser } from "./ThreadBrowser";
import { FolderIcon, MemberAvatars } from "./ChannelBrowser";
import { EVENT_ACTIVE, EventDetail, SCEvent, whenLabel } from "./EventsPanel";
import { t, errCode, errText } from "../i18n";

type Member = { id: string; avatar: string | null };
type TextChannel = { id: string; name: string; type?: number; threads?: ThreadInfo[] };
type VoiceChannel = { id: string; name: string; members?: Member[] };
type TextGuild = { id: string; name: string; icon: string | null; folder?: GuildFolder | null; channels: TextChannel[]; hidden?: boolean };
type VoiceGuild = { id: string; name: string; icon: string | null; folder?: GuildFolder | null; channels: VoiceChannel[]; hidden?: boolean };
type Guild = { id: string; name: string; icon: string | null; folder?: GuildFolder | null; hidden: boolean; text: TextChannel[]; voice: VoiceChannel[] };

const MAX_RETRIES = 10;

function ServerIcon({ guild, open }: { guild: Guild; open: boolean }) {
  // Carré arrondi au repos, cercle une fois ouvert : même repère que le QAM.
  const common = { width: 42, height: 42, borderRadius: open ? "50%" : 12, objectFit: "cover" as const, flexShrink: 0, transition: "border-radius .12s ease" };
  return guild.icon ? <img src={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=64`} width={42} height={42} style={common} /> : <div style={{ ...common, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, background: "linear-gradient(135deg,#5865f2,#8b5cf6)" }}>{guild.name[0]?.toUpperCase()}</div>;
}

function Row({ children, onClick, active, flex }: { children: any; onClick: () => void; active?: boolean; flex?: boolean }) {
  const [focused, setFocused] = useState(false);
  return <Focusable noFocusRing onClick={onClick} onActivate={onClick} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onGamepadFocus={() => setFocused(true)} onGamepadBlur={() => setFocused(false)} style={{ ...(flex ? { flex: 1, minWidth: 0 } : {}), display: "flex", alignItems: "center", gap: 10, minHeight: 48, padding: "8px 11px", borderRadius: 9, marginBottom: 4, background: active ? "rgba(88,101,242,.45)" : focused ? "rgba(88,101,242,.24)" : "rgba(255,255,255,.045)", ...listHalo(focused) }}>{children}</Focusable>;
}

function ToolBtn({ onClick, disabled, on, children }: { onClick: () => void; disabled?: boolean; on?: boolean; children: any }) {
  const [focused, setFocused] = useState(false);
  const act = () => { if (!disabled) onClick(); };
  return <Focusable noFocusRing onClick={act} onActivate={act} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onGamepadFocus={() => setFocused(true)} onGamepadBlur={() => setFocused(false)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, minWidth: 44, height: 40, padding: "0 12px", marginBottom: 4, borderRadius: 9, fontSize: 13, fontWeight: 600, flexShrink: 0, opacity: disabled ? .3 : 1, color: on ? "#fff" : undefined, background: on ? "rgba(88,101,242,.75)" : focused ? "rgba(88,101,242,.35)" : "rgba(255,255,255,.06)", ...listHalo(focused) }}>{children}</Focusable>;
}

const ellipsis = { flex: 1, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" } as const;

function ThreadRow({ thread, onOpen }: { thread: ThreadInfo; onOpen: (t: ThreadInfo) => void }) {
  return <div style={{ marginLeft: 22 }}><Row onClick={() => onOpen(thread)}>
    <span style={{ width: 22, display: "flex", justifyContent: "center", opacity: .6 }}><IcThread /></span>
    <span style={{ ...ellipsis, opacity: thread.archived ? .6 : 1 }}>{thread.name}</span>
    {thread.archived ? <span style={{ opacity: .5, fontSize: 11 }}>{t("thread_archived")}</span>
      : thread.count ? <span style={{ opacity: .5, fontSize: 12 }}>{thread.count}</span> : null}
  </Row></div>;
}

const sectionTitle = (label: string, first?: boolean) => <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: .7, opacity: .5, margin: `${first ? 4 : 12}px 0 7px` }}>{label}</div>;

export function ServerHub() {
  const openChat = useOpenChat();
  const openMembers = useOpenMembers();
  const [guilds, setGuilds] = useState<Guild[] | null>(null);
  const [events, setEvents] = useState<SCEvent[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [openFolders, toggleFolder] = useOpenFolders();
  // Salon dont la liste complète des fils (ou le forum) est dépliée.
  const [threadsOf, setThreadsOf] = useState<string | null>(null);
  const retries = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  // `guilds` garde TOUT, masqués compris (flag `hidden`) : l'affichage filtre.
  // Même piège que le QAM — retirer un masqué du state ferait disparaître le
  // bouton qui permet de le récupérer.
  const refresh = () => {
    Promise.all([call<[boolean], any>("get_text_channels", true), call<[boolean], any>("get_guilds_vc", true)]).then(([texts, voices]) => {
      if (!alive.current) return;
      const byId = new Map<string, Guild>();
      for (const item of Array.isArray(voices) ? voices as VoiceGuild[] : []) byId.set(item.id, { id: item.id, name: item.name, icon: item.icon, folder: item.folder ?? null, hidden: !!item.hidden, text: [], voice: item.channels || [] });
      for (const item of Array.isArray(texts) ? texts as TextGuild[] : []) {
        const existing = byId.get(item.id);
        if (existing) { existing.text = item.channels || []; existing.hidden = existing.hidden || !!item.hidden; existing.folder = existing.folder ?? item.folder ?? null; }
        else byId.set(item.id, { id: item.id, name: item.name, icon: item.icon, folder: item.folder ?? null, hidden: !!item.hidden, text: item.channels || [], voice: [] });
      }
      retries.current = 0;
      setError(null);
      setGuilds([...byId.values()]);
    }).catch((e: any) => {
      if (!alive.current) return;
      const s = errCode(e);
      setError(errText(e));
      // Discord qui démarre encore ou se reconnecte : on réessaie seul (#28).
      if ((s.includes("stores_not_ready") || s.includes("discord_reconnecting")) && retries.current < MAX_RETRIES) {
        retries.current += 1;
        timer.current = setTimeout(refresh, 1000 * retries.current);
      }
    });
    call<[], SCEvent[]>("get_events").then((r) => { if (alive.current) setEvents(Array.isArray(r) ? r : []); }).catch(() => {});
  };

  useEffect(() => {
    alive.current = true;
    refresh();
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);

  const join = (channelId: string, guildId: string) => {
    setJoining(channelId);
    call("join_vc", channelId, guildId).catch((e: any) => setError(errText(e))).finally(() => setTimeout(() => setJoining(null), 1500));
  };

  // Mêmes préférences backend que le QAM (set_guild_order / set_guild_hidden) :
  // un ordre ou un masquage fait ici se retrouve dans le panneau, et inversement.
  const move = (guildId: string, delta: number) => {
    setGuilds((prev) => {
      if (!prev) return prev;
      const visible = prev.filter((g) => !g.hidden);
      const visIdx = visible.findIndex((g) => g.id === guildId);
      const target = visIdx + delta;
      if (visIdx < 0 || target < 0 || target >= visible.length) return prev;
      const a = prev.findIndex((g) => g.id === guildId);
      const b = prev.findIndex((g) => g.id === visible[target].id);
      const next = [...prev];
      [next[a], next[b]] = [next[b], next[a]];
      call("set_guild_order", next.map((g) => g.id)).catch(() => {});
      return next;
    });
  };
  const toggleHidden = (guild: Guild) => {
    const hidden = !guild.hidden;
    call("set_guild_hidden", guild.id, hidden).catch(() => {});
    setGuilds((prev) => prev && prev.map((g) => g.id === guild.id ? { ...g, hidden } : g));
  };

  if (error && !guilds) return <div style={{ color: "#ff7474" }}>{error}</div>;
  if (!guilds) return <div style={{ opacity: .65 }}>{t("loading_servers")}</div>;

  const hiddenCount = guilds.filter((g) => g.hidden).length;
  const shown = showHidden ? guilds : guilds.filter((g) => !g.hidden);
  const eventsOf = (id: string) => events.filter((ev) => ev.guild_id === id);

  return <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
    <Focusable flow-children="row" style={{ flexShrink: 0, display: "flex", gap: 6, marginBottom: 8 }}>
      {(showHidden || hiddenCount > 0) && <ToolBtn on={showHidden} onClick={() => setShowHidden((v) => !v)}>
        {showHidden ? <><IcEyeSlash /> {t("servers_show_visible")}</> : <><IcEye /> {t("servers_hidden_count", { count: hiddenCount })}</>}
      </ToolBtn>}
      <ToolBtn on={editMode} onClick={() => setEditMode((v) => !v)}><IcReorder /> {editMode ? t("servers_edit_done") : t("servers_edit_mode")}</ToolBtn>
      <ToolBtn onClick={refresh}><IcRefresh /></ToolBtn>
    </Focusable>
    {error && <div style={{ flexShrink: 0, color: "#ff7474", marginBottom: 6 }}>{error}</div>}
    {/* flex:1 + minHeight:0 : la liste est bornée à sa colonne et défile SEULE ;
        sans borne elle grandissait et c'était la vue entière qui défilait. */}
    <Focusable flow-children="column" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "3px 8px 3px 3px" }}>
      {(editMode || showHidden ? shown.map((guild, index) => ({ kind: "guild" as const, guild, index })) : groupByFolder(shown)).map((entry) => {
        if (entry.kind === "guild") return renderGuild(entry.guild, entry.index);
        // Dossier Discord (#101) : replié par défaut, ses serveurs dessous.
        // Masquer/réorganiser affichent la liste à plat, serveur par serveur.
        const f = entry.folder;
        const guildsIn = entry.items.map((it) => it.guild);
        const isOpen = openFolders.has(f.id);
        const inVoice = guildsIn.reduce((n, g) => n + g.voice.reduce((m, c) => m + (c.members?.length ?? 0), 0), 0);
        return <div key={"folder-" + f.id} style={{ marginBottom: 7 }}>
          <Row active={isOpen} onClick={() => toggleFolder(f.id)}>
            <FolderIcon folder={f} guilds={guildsIn} open={isOpen} size={42} />
            <span style={{ ...ellipsis, fontWeight: 750 }}>{folderLabel(f, guildsIn)}</span>
            <span style={{ opacity: .55, fontSize: 12 }}>{t("folder_count", { count: guildsIn.length })}</span>
            {inVoice > 0 && <span style={{ color: ONLINE, fontSize: 12, fontWeight: 700 }}><IcSpeaker /> {inVoice}</span>}
            <span style={{ opacity: .55, display: "flex" }}>{isOpen ? <IcChevronUp /> : <IcChevronDown />}</span>
          </Row>
          {isOpen && <div style={{ margin: "3px 0 0 12px", paddingLeft: 10, borderLeft: `2px solid ${folderColor(f)}` }}>
            {entry.items.map((it) => renderGuild(it.guild, it.index))}
          </div>}
        </div>;
      })}
    </Focusable>
  </div>;

  function renderGuild(guild: Guild, i: number) {
        const isOpen = open === guild.id;
        const inVoice = guild.voice.reduce((n, c) => n + (c.members?.length ?? 0), 0);
        const evs = eventsOf(guild.id);
        const liveEvents = evs.filter((ev) => ev.status === EVENT_ACTIVE).length;
        const toggleOpen = () => setOpen((current) => current === guild.id ? null : guild.id);
        const row = <Row flex={editMode || showHidden} active={isOpen} onClick={toggleOpen}>
          <ServerIcon guild={guild} open={isOpen} />
          <span style={{ flex: 1, minWidth: 0, fontWeight: 750, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{guild.name}</span>
          {liveEvents > 0 ? <span style={{ color: DANGER, fontSize: 12, fontWeight: 700 }}>● {t("event_live")}</span>
            : evs.length > 0 ? <span style={{ opacity: .6, fontSize: 12 }}>{t("events")} · {evs.length}</span> : null}
          {inVoice > 0 && <span style={{ color: ONLINE, fontSize: 12, fontWeight: 700 }}><IcSpeaker /> {inVoice}</span>}
          <span style={{ opacity: .55, display: "flex" }}>{isOpen ? <IcChevronUp /> : <IcChevronDown />}</span>
        </Row>;
        return <div key={guild.id} style={{ marginBottom: 7, opacity: guild.hidden ? .5 : 1 }}>
          {(editMode || showHidden) ? <Focusable flow-children="row" style={{ display: "flex", gap: 5 }}>
            {row}
            {editMode && !showHidden && <>
              <ToolBtn disabled={i === 0} onClick={() => move(guild.id, -1)}><IcChevronUp /></ToolBtn>
              <ToolBtn disabled={i === shown.length - 1} onClick={() => move(guild.id, 1)}><IcChevronDown /></ToolBtn>
            </>}
            <ToolBtn onClick={() => toggleHidden(guild)}>{guild.hidden ? <IcEye /> : <IcEyeSlash />}</ToolBtn>
          </Focusable> : row}
          {isOpen && <div style={{ margin: "3px 0 9px 19px", padding: "6px 0 3px 15px", borderLeft: "2px solid rgba(88,101,242,.7)" }}>
            {/* Les membres du serveur, comme le panneau de droite de Discord. */}
            {openMembers && <Row onClick={() => openMembers(guild.id, guild.name)}><span style={{ width: 28, display: "flex", justifyContent: "center", opacity: .75 }}><FaUsers /></span><span style={{ flex: 1 }}>{t("xv_members")}</span><span style={{ opacity: .55 }}>›</span></Row>}
            {evs.length > 0 && sectionTitle(t("events").toUpperCase(), true)}
            {evs.map((ev) => {
              const live = ev.status === EVENT_ACTIVE;
              const meta = [live ? "" : whenLabel(ev.start), ev.location, ev.count ? `${ev.count} ${t("event_interested_count")}` : ""].filter(Boolean).join(" · ");
              return <Focusable key={ev.id} flow-children="row" style={{ display: "flex", gap: 5 }}>
                <Row flex onClick={() => showModal(<EventDetail ev={ev} />)}>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "block", fontWeight: 650, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                      {live && <span style={{ color: DANGER, fontSize: 12, fontWeight: 700 }}>● {t("event_live")} </span>}{ev.name}
                    </span>
                    {meta && <span style={{ display: "block", fontSize: 11, opacity: .58, marginTop: 2, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{meta}</span>}
                  </span>
                </Row>
                {live && ev.channel_id && <ToolBtn onClick={() => join(ev.channel_id as string, ev.guild_id)}>{t("event_join")}</ToolBtn>}
              </Focusable>;
            })}
            {guild.text.length > 0 && sectionTitle(t("xv_text_channels"), evs.length === 0)}
            {guild.text.map((channel) => {
              // Fils (#100) : ceux que Discord a déjà actifs s'affichent sous
              // leur salon ; le bouton Fils charge la liste complète (archives
              // comprises). Un forum n'a pas de messages propres : il se déplie
              // directement sur ses publications.
              const forum = isForumChannel(channel.type);
              const full = threadsOf === channel.id;
              const toggleThreads = () => setThreadsOf((c) => c === channel.id ? null : channel.id);
              const openThread = (th: ThreadInfo) => openChat(th.id, th.name, false);
              const known = channel.threads || [];
              return <div key={channel.id}>
                {forum
                  ? <Row active={full} onClick={toggleThreads}><span style={{ width: 28, display: "flex", justifyContent: "center", opacity: .75 }}><IcForum /></span><span style={ellipsis}>{channel.name}</span><span style={{ opacity: .55, display: "flex" }}>{full ? <IcChevronUp /> : <IcChevronDown />}</span></Row>
                  : <Focusable flow-children="row" style={{ display: "flex", gap: 5 }}>
                    <Row flex onClick={() => openChat(channel.id, channel.name, false)}><span style={{ width: 28, textAlign: "center", opacity: .65, fontSize: 20 }}>#</span><span style={ellipsis}>{channel.name}</span><IcChat /></Row>
                    <ToolBtn on={full} onClick={toggleThreads}><IcThread />{known.length > 0 ? ` ${known.length}` : ""}</ToolBtn>
                  </Focusable>}
                {full ? <div style={{ marginLeft: 22 }}><ThreadBrowser channelId={channel.id} channelName={channel.name} forum={forum} onOpen={openThread} Row={Row} Btn={ToolBtn} size={14} /></div>
                  : known.map((th) => <ThreadRow key={th.id} thread={th} onOpen={openThread} />)}
              </div>;
            })}
            {guild.voice.length > 0 && sectionTitle(t("xv_voice_channels"), evs.length === 0 && guild.text.length === 0)}
            {/* Un salon vocal a aussi son chat écrit (même id que le salon) :
                A rejoint, droite puis A ouvre ce chat (demande user 15/09). */}
            {guild.voice.map((channel) => <Focusable key={channel.id} flow-children="row" style={{ display: "flex", gap: 5 }}>
              <Row flex onClick={() => join(channel.id, guild.id)} active={joining === channel.id}><span style={{ width: 28, textAlign: "center", opacity: .75 }}><IcSpeaker /></span><span style={{ flex: 1, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{joining === channel.id ? t("connecting") : channel.name}</span><MemberAvatars members={channel.members || []} /></Row>
              {/* Bouton libellé, comme « Appeler » sur les MP (retour user 15/09). */}
              <ToolBtn onClick={() => openChat(channel.id, channel.name, false)}><IcChat /> {t("xv_voice_chat")}</ToolBtn>
            </Focusable>)}
            {evs.length === 0 && guild.text.length === 0 && guild.voice.length === 0 && <div style={{ opacity: .55, padding: "6px 4px" }}>{t("xv_no_channels_access")}</div>}
          </div>}
        </div>;
  }
}
