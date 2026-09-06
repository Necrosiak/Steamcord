import { DialogButton, Focusable } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { t, errText } from "../i18n";
import { useFillHeight, focusHalo, ACCENT } from "./Styled";
import { useQamUi } from "../qamUi";
import { useBackHandler } from "../backNav";
import { IcRefresh, IcSpeaker, IcChevronUp, IcChevronDown, IcEye, IcEyeSlash, IcReorder } from "./Icons";

interface ChannelMember { id: string; avatar: string | null; }
interface VoiceChannel { id: string; name: string; members: ChannelMember[]; }
interface Guild { id: string; name: string; icon: string | null; channels: VoiceChannel[]; hidden?: boolean; }

const Btn = DialogButton as any;

function MemberAvatars({ members }: { members: ChannelMember[] }) {
  const { px } = useQamUi();
  if (!members || members.length === 0) return null;
  const shown = members.slice(0, 4);
  const extra = members.length - shown.length;
  const av = px(20);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: px(3), flexShrink: 0 }}>
      {shown.map(m => (
        <img
          key={m.id}
          src={m.avatar
            ? `https://cdn.discordapp.com/avatars/${m.id}/${m.avatar}.webp?size=32`
            : `https://cdn.discordapp.com/embed/avatars/0.png`}
          width={av} height={av}
          style={{ borderRadius: "50%", border: "1px solid rgba(255,255,255,0.15)", objectFit: "cover", flexShrink: 0 }}
        />
      ))}
      {extra > 0 && <span style={{ fontSize: px(11), opacity: 0.5 }}>+{extra}</span>}
      <span style={{ fontSize: px(12), opacity: 0.5, marginLeft: px(2) }}>{members.length}</span>
    </div>
  );
}

// Puce icône minuscule (↑/↓/œil) — même style compact pour les 3, séparée du
// bouton principal de la rangée pour ne pas intercepter son clic. Exportée :
// l'onglet textuel réutilise le même mécanisme réordonner/masquer (mêmes prefs
// backend, cf. main.py _apply_guild_prefs).
export function TinyIconBtn({ onClick, disabled, title, children }: { onClick: () => void; disabled?: boolean; title?: string; children: any }) {
  const { px } = useQamUi();
  const s = px(28);
  return (
    <Btn
      onClick={(e: any) => { e?.stopPropagation?.(); if (!disabled) onClick(); }}
      disabled={disabled}
      title={title}
      style={{
        width: s, minWidth: s, height: s, padding: 0, margin: 0, minHeight: s,
        display: "flex", alignItems: "center", justifyContent: "center",
        overflow: "visible", lineHeight: 1,
        opacity: disabled ? 0.25 : 0.7, fontSize: px(13), flexShrink: 0,
      }}
    >
      {children}
    </Btn>
  );
}

// Rangée principale d'un serveur (icône + nom + indicateur actif + chevron
// d'expansion). Extraite pour être réutilisée identique en mode normal (seule,
// un focus stop) et en mode réorganisation (flex:1 à côté des puces ↑/↓/œil).
// Rangée de serveur. Elle n'utilisait PAS focusHalo, seule de tout le plugin :
// le focus natif du DialogButton posait un fond clair, du texte sombre et un
// bord dur, là où le reste (SkullKey, Toolkit, les boutons vocaux) a l'anneau
// blanc + lueur d'accent. C'est ce qui la faisait dépareiller.
//
// L'icône du serveur reprend le geste de Discord : carré arrondi au repos,
// CERCLE quand le serveur est ouvert. Ça donne un repère visuel gratuit — on
// voit lequel est déplié sans lire le chevron.
function GuildRowBtn({ guild, totalActive, expanded, onClick, flex }: {
  guild: Guild; totalActive: number; expanded: boolean; onClick: () => void; flex?: boolean;
}) {
  const { px } = useQamUi();
  const [focused, setFocused] = useState(false);
  const ic = px(26);
  const radius = expanded ? "50%" : `${px(9)}px`;
  return (
    <Btn
      onClick={onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        display: "flex", alignItems: "center", gap: px(9),
        width: flex ? undefined : "100%", flex: flex ? 1 : undefined,
        minWidth: 0, minHeight: px(42), padding: `${px(6)}px ${px(9)}px`,
        overflow: "visible", lineHeight: 1.2, color: "#fff",
        borderRadius: px(10), margin: 0, boxSizing: "border-box",
        background: focused
          ? "rgba(88,101,242,0.85)"
          : expanded ? "rgba(88,101,242,0.26)" : "rgba(255,255,255,0.05)",
        ...focusHalo(ACCENT, focused),
      }}
    >
      {guild.icon
        ? <img src={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=64`}
            width={ic} height={ic}
            style={{ width: ic, height: ic, borderRadius: radius, flexShrink: 0, objectFit: "cover",
                     transition: "border-radius .12s ease" }} />
        : <div style={{ width: ic, height: ic, borderRadius: radius, background: "#5865f2", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: px(12), fontWeight: 700, color: "#fff",
            transition: "border-radius .12s ease" }}>
            {guild.name[0]}
          </div>
      }
      <span style={{ flex: 1, textAlign: "left", fontSize: px(13), fontWeight: expanded ? 600 : 500,
                     overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{guild.name}</span>
      {/* Pastille plutôt qu'un « ● 3 » vert nu : le compte se lit d'un coup
          d'œil sans se confondre avec le nom du serveur. */}
      {totalActive > 0 && (
        <span style={{
          fontSize: px(10), fontWeight: 700, color: "#3ba55c", flexShrink: 0,
          background: "rgba(59,165,92,0.16)", borderRadius: px(8),
          padding: `${px(1)}px ${px(6)}px`,
        }}>{totalActive}</span>
      )}
      <span style={{ opacity: 0.45, flexShrink: 0, display: "flex" }}>
        {expanded ? <IcChevronUp /> : <IcChevronDown />}
      </span>
    </Btn>
  );
}

// Salon vocal sous un serveur déplié. Le rail vertical à gauche rattache
// visuellement les salons à LEUR serveur : sans lui, une liste dépliée se
// confond avec la liste des serveurs dès qu'on a fait défiler un peu.
function ChannelRowBtn({ channel, joining, onClick }: {
  channel: VoiceChannel; joining: boolean; onClick: () => void;
}) {
  const { px } = useQamUi();
  const [focused, setFocused] = useState(false);
  return (
    <Btn
      onClick={onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        width: "100%", padding: `${px(5)}px ${px(9)}px`, marginBottom: px(2), margin: 0,
        marginTop: px(2), fontSize: px(12), minHeight: px(32), boxSizing: "border-box",
        borderRadius: px(8), color: "#fff", lineHeight: 1.2, overflow: "visible",
        display: "flex", alignItems: "center", gap: px(7),
        background: joining
          ? ACCENT
          : focused ? "rgba(88,101,242,0.7)" : "rgba(255,255,255,0.04)",
        ...focusHalo(ACCENT, focused, 1.01),
      }}
    >
      <span style={{ opacity: 0.55, fontSize: px(11), flexShrink: 0, display: "flex" }}><IcSpeaker /></span>
      <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {joining ? t("connecting") : channel.name}
      </span>
      <MemberAvatars members={channel.members} />
    </Btn>
  );
}

export function ChannelBrowser() {
  const fill = useFillHeight();
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  // Les puces ↑/↓/œil restent CACHÉES par défaut (demande user) : un bouton
  // dédié les révèle, plutôt que d'encombrer chaque rangée en permanence.
  const [editMode, setEditMode] = useState(false);
  useBackHandler(() => { setExpanded(null); return true; }, expanded !== null);

  // `guilds` contient TOUJOURS l'ensemble complet (masqués inclus, avec leur
  // flag `hidden`) — c'est `visibleGuilds` ci-dessous qui filtre pour
  // l'affichage. Piège évité : si on retirait les masqués du state au moment
  // même où on les masque, `hiddenCount` retombait à 0 juste après un masquage
  // (plus aucune trace qu'il en existait un) → le bouton "afficher les
  // masqués" ne réapparaissait jamais → impossible de les récupérer.
  // #28 : ouvrir l'onglet pendant que Discord démarre encore échouait DÉFINITIVEMENT
  // — les stores Vencord n'étaient pas résolus, et il fallait quitter puis rouvrir
  // pour retenter. On réessaie tout seul tant que l'échec est transitoire (Discord
  // qui démarre ou se reconnecte), sans jamais boucler à l'infini.
  const retries = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const MAX_RETRIES = 10;

  const refresh = () => {
    call<[boolean], any>("get_guilds_vc", true).then(res => {
      if (!alive.current) return;
      if (Array.isArray(res)) { retries.current = 0; setError(null); setGuilds(res); }
      else setError(t("error") + JSON.stringify(res));
    }).catch(e => {
      if (!alive.current) return;
      const s = String(e);
      const transient = s.includes("stores_not_ready") || s.includes("discord_reconnecting");
      setError(errText(e));
      if (transient && retries.current < MAX_RETRIES) {
        retries.current += 1;
        // 1 s, 2 s, 3 s… : court au début (le cas courant se résout en quelques
        // secondes), sans marteler le backend si Discord ne revient jamais.
        timer.current = setTimeout(refresh, 1000 * retries.current);
      }
    });
  };

  useEffect(() => {
    alive.current = true;
    refresh();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const join = async (channelId: string, guildId: string) => {
    setJoining(channelId);
    await call("join_vc", channelId, guildId).catch(e => setError(errText(e)));
    setTimeout(() => setJoining(null), 2000);
  };

  // Préférence 100% locale à Steamcord (persistée côté backend) — le tri natif
  // Discord ne survit pas à un redémarrage du client, vérifié en vrai. Chaque
  // déplacement "cristallise" l'ordre AFFICHÉ courant : un nouveau serveur
  // (jamais dans cette liste) atterrira après ceux déjà ordonnés, jamais perdu.
  // Opère sur les positions RÉELLES dans `guilds` (pas dans la liste visible
  // filtrée) pour ne jamais déplacer un masqué par accident.
  const move = (guildId: string, delta: number) => {
    setGuilds(prev => {
      const visible = prev.filter(g => !g.hidden);
      const visIdx = visible.findIndex(g => g.id === guildId);
      const targetVisIdx = visIdx + delta;
      if (visIdx < 0 || targetVisIdx < 0 || targetVisIdx >= visible.length) return prev;
      const otherId = visible[targetVisIdx].id;
      const a = prev.findIndex(g => g.id === guildId);
      const b = prev.findIndex(g => g.id === otherId);
      const next = [...prev];
      [next[a], next[b]] = [next[b], next[a]];
      call("set_guild_order", next.map(g => g.id)).catch(() => {});
      return next;
    });
  };

  const toggleHidden = (guild: Guild) => {
    const nextHidden = !guild.hidden;
    call("set_guild_hidden", guild.id, nextHidden).catch(() => {});
    setGuilds(prev => prev.map(g => (g.id === guild.id ? { ...g, hidden: nextHidden } : g)));
  };

  if (error)
    return <div style={{ padding: 8, color: "#ff6b6b", fontSize: 12 }}>{error}</div>;

  if (guilds.length === 0)
    return <div style={{ padding: 8, opacity: 0.6, fontSize: 13 }}>{t("loading_servers")}</div>;

  const hiddenCount = guilds.filter(g => g.hidden).length;
  const visibleGuilds = showHidden ? guilds : guilds.filter(g => !g.hidden);

  return (
    <div>
      <Focusable flow-children="row" style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 4, marginBottom: 4 }}>
        {(showHidden || hiddenCount > 0) && (
          <Btn
            onClick={() => setShowHidden(s => !s)}
            title={showHidden ? t("servers_show_visible") : t("servers_hidden_count", { count: hiddenCount })}
            style={{ padding: "2px 6px", fontSize: 10, minHeight: 0, display: "flex", alignItems: "center", gap: 3 }}
          >
            {showHidden ? <IcEyeSlash /> : <IcEye />}
            {!showHidden && <span>{hiddenCount}</span>}
          </Btn>
        )}
        <TinyIconBtn
          onClick={() => setEditMode(m => !m)}
          title={editMode ? t("servers_edit_done") : t("servers_edit_mode")}
        >
          <span style={{ color: editMode ? "#5865f2" : undefined }}><IcReorder /></span>
        </TinyIconBtn>
        <TinyIconBtn onClick={refresh}><IcRefresh /></TinyIconBtn>
      </Focusable>
      <div ref={fill.ref} style={{ maxHeight: fill.height, overflowY: "auto" }}>
        {visibleGuilds.map((guild, i) => {
          const totalActive = guild.channels.reduce((n, c) => n + (c.members?.length ?? 0), 0);
          return (
            <div key={guild.id} style={{ marginBottom: 5, opacity: guild.hidden ? 0.5 : 1 }}>
              {/* Œil visible dès qu'on parcourt les masqués (récupérer un
                  serveur doit être direct, pas coincé derrière le mode
                  réorganisation) ; ↑/↓ restent réservés au mode réorganisation. */}
              {(editMode || showHidden) ? (
                <Focusable flow-children="row" style={{ display: "flex", alignItems: "center", gap: 3 }}>
                  <GuildRowBtn guild={guild} totalActive={totalActive} expanded={expanded === guild.id}
                    onClick={() => setExpanded(expanded === guild.id ? null : guild.id)} flex />
                  {editMode && !showHidden && (
                    <>
                      <TinyIconBtn onClick={() => move(guild.id, -1)} disabled={i === 0} title={t("server_move_up")}><IcChevronUp /></TinyIconBtn>
                      <TinyIconBtn onClick={() => move(guild.id, 1)} disabled={i === visibleGuilds.length - 1} title={t("server_move_down")}><IcChevronDown /></TinyIconBtn>
                    </>
                  )}
                  <TinyIconBtn onClick={() => toggleHidden(guild)} title={guild.hidden ? t("server_unhide") : t("server_hide")}>
                    {guild.hidden ? <IcEye /> : <IcEyeSlash />}
                  </TinyIconBtn>
                </Focusable>
              ) : (
                <GuildRowBtn guild={guild} totalActive={totalActive} expanded={expanded === guild.id}
                  onClick={() => setExpanded(expanded === guild.id ? null : guild.id)} />
              )}

              {expanded === guild.id && (
                <div style={{
                  marginLeft: 13, marginTop: 3, paddingLeft: 9,
                  borderLeft: "2px solid rgba(88,101,242,0.35)",
                }}>
                  {guild.channels.map(ch => (
                    <ChannelRowBtn key={ch.id} channel={ch} joining={joining === ch.id}
                      onClick={() => join(ch.id, guild.id)} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
