import { DialogButton, Focusable } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t, errText } from "../i18n";
import { useFillHeight } from "./Styled";
import { IcRefresh, IcSpeaker, IcChevronUp, IcChevronDown, IcEye, IcEyeSlash, IcReorder } from "./Icons";

interface ChannelMember { id: string; avatar: string | null; }
interface VoiceChannel { id: string; name: string; members: ChannelMember[]; }
interface Guild { id: string; name: string; icon: string | null; channels: VoiceChannel[]; hidden?: boolean; }

const Btn = DialogButton as any;

function MemberAvatars({ members }: { members: ChannelMember[] }) {
  if (!members || members.length === 0) return null;
  const shown = members.slice(0, 4);
  const extra = members.length - shown.length;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
      {shown.map(m => (
        <img
          key={m.id}
          src={m.avatar
            ? `https://cdn.discordapp.com/avatars/${m.id}/${m.avatar}.webp?size=16`
            : `https://cdn.discordapp.com/embed/avatars/0.png`}
          width={16} height={16}
          style={{ borderRadius: "50%", border: "1px solid rgba(255,255,255,0.15)" }}
        />
      ))}
      {extra > 0 && <span style={{ fontSize: 9, opacity: 0.5 }}>+{extra}</span>}
      <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 2 }}>{members.length}</span>
    </div>
  );
}

// Puce icône minuscule (↑/↓/œil) — même style compact pour les 3, séparée du
// bouton principal de la rangée pour ne pas intercepter son clic.
function TinyIconBtn({ onClick, disabled, title, children }: { onClick: () => void; disabled?: boolean; title?: string; children: any }) {
  return (
    <Btn
      onClick={(e: any) => { e?.stopPropagation?.(); if (!disabled) onClick(); }}
      disabled={disabled}
      title={title}
      style={{
        width: 22, minWidth: 22, height: 22, padding: 0, margin: 0, minHeight: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        opacity: disabled ? 0.25 : 0.7, fontSize: 11, flexShrink: 0,
      }}
    >
      {children}
    </Btn>
  );
}

// Rangée principale d'un serveur (icône + nom + indicateur actif + chevron
// d'expansion). Extraite pour être réutilisée identique en mode normal (seule,
// un focus stop) et en mode réorganisation (flex:1 à côté des puces ↑/↓/œil).
function GuildRowBtn({ guild, totalActive, expanded, onClick, flex }: {
  guild: Guild; totalActive: number; expanded: boolean; onClick: () => void; flex?: boolean;
}) {
  return (
    <Btn
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 7, width: flex ? undefined : "100%", flex: flex ? 1 : undefined, minWidth: 0, padding: "5px 8px" }}
    >
      {guild.icon
        ? <img src={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=32`}
            width={18} height={18} style={{ borderRadius: "50%", flexShrink: 0 }} />
        : <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#5865f2", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#fff" }}>
            {guild.name[0]}
          </div>
      }
      <span style={{ flex: 1, textAlign: "left", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{guild.name}</span>
      {totalActive > 0 && <span style={{ fontSize: 9, color: "#23a55a" }}>● {totalActive}</span>}
      <span style={{ opacity: 0.4, fontSize: 10 }}>{expanded ? "▲" : "▼"}</span>
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

  // `guilds` contient TOUJOURS l'ensemble complet (masqués inclus, avec leur
  // flag `hidden`) — c'est `visibleGuilds` ci-dessous qui filtre pour
  // l'affichage. Piège évité : si on retirait les masqués du state au moment
  // même où on les masque, `hiddenCount` retombait à 0 juste après un masquage
  // (plus aucune trace qu'il en existait un) → le bouton "afficher les
  // masqués" ne réapparaissait jamais → impossible de les récupérer.
  const refresh = () => {
    call<[boolean], any>("get_guilds_vc", true).then(res => {
      if (Array.isArray(res)) setGuilds(res);
      else setError(t("error") + JSON.stringify(res));
    }).catch(e => setError(errText(e)));
  };

  useEffect(() => { refresh(); }, []);

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
      <Focusable flow-children="horizontal" style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 4, marginBottom: 4 }}>
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
            <div key={guild.id} style={{ marginBottom: 3, opacity: guild.hidden ? 0.5 : 1 }}>
              {/* Œil visible dès qu'on parcourt les masqués (récupérer un
                  serveur doit être direct, pas coincé derrière le mode
                  réorganisation) ; ↑/↓ restent réservés au mode réorganisation. */}
              {(editMode || showHidden) ? (
                <Focusable flow-children="horizontal" style={{ display: "flex", alignItems: "center", gap: 3 }}>
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
                <div style={{ paddingLeft: 6, marginTop: 2 }}>
                  {guild.channels.map(ch => (
                    <Btn
                      key={ch.id}
                      onClick={() => join(ch.id, guild.id)}
                      style={{
                        width: "100%", padding: "4px 8px", marginBottom: 2, fontSize: 11,
                        background: joining === ch.id ? "#5865f2" : undefined,
                        display: "flex", alignItems: "center", gap: 6,
                      }}
                    >
                      <span style={{ opacity: 0.6, fontSize: 10 }}><IcSpeaker /></span>
                      <span style={{ flex: 1, textAlign: "left" }}>{joining === ch.id ? t("connecting") : ch.name}</span>
                      <MemberAvatars members={ch.members} />
                    </Btn>
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
