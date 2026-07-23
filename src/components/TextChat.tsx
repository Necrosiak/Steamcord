import { DialogButton, Focusable, showModal, TextField } from "@decky/ui";
import { addEventListener, call, removeEventListener } from "@decky/api";
import { useEffect, useState } from "react";
import { t, errText } from "../i18n";
import { useFillHeight, focusHalo, ACCENT } from "./Styled";
import { IcChat, IcLink, IcPaperclip, IcChevronUp, IcChevronDown, IcEye, IcEyeSlash, IcReorder } from "./Icons";
import { ChatFullscreenModal } from "./ChatFullscreen";
import { TinyIconBtn } from "./ChannelBrowser";

// Intervalle de polling au niveau module (évite useRef — déconseillé dans le
// QAM DeckyLoader). Une seule instance de TextChat à la fois (le parent monte
// une instance distincte par source via `key`).
let _textPoll: any = null;

interface TextChannel { id: string; name: string; type: number; }
interface Guild { id: string; name: string; icon: string | null; channels: TextChannel[]; hidden?: boolean; }
interface DMRecipient { id: string; username: string; avatar: string | null; }
interface DMChannel {
  id: string; type: number; name: string; icon: string | null;
  recipients: DMRecipient[]; active_call: boolean;
}
export interface MsgImage { url: string; proxy_url: string; w: number; h: number; }
export interface MsgReaction { emoji: string; count: number; me: boolean; }
export interface Message {
  id: string; author: string; author_id: string; avatar: string | null;
  bot: boolean; content: string; ts: string | null;
  images: MsgImage[]; files: number; reactions?: MsgReaction[];
  reply_to?: { author: string; content: string } | null;
}

export const Btn = DialogButton as any;

// Ouvre une URL dans le navigateur intégré du gamemode Steam (overlay web).
// Plusieurs API SteamClient tentées : selon le contexte de rendu (panneau QAM
// vs vraie modale plein écran — #20, ChatFullscreenModal), `window.SteamClient`
// n'expose pas forcément les mêmes espaces de noms (vérifié en direct au CDP :
// `.URL` est absent du contexte QuickAccess mais présent dans SharedJSContext),
// donc pas de garantie qu'un seul appel marche partout. `window.open` en tout
// dernier recours : marche dans n'importe quel contexte Chromium/CEF.
export const openUrl = (url: string) => {
  try {
    const sc = (window as any).SteamClient;
    if (sc?.URL?.ExecuteSteamURL) { sc.URL.ExecuteSteamURL("steam://openurl/" + url); return; }
    if (sc?.System?.OpenInSystemBrowser) { sc.System.OpenInSystemBrowser(url); return; }
  } catch {}
  try { window.open(url, "_blank"); } catch {}
};

// Miniature légère via le CDN média Discord (redimensionne côté serveur → peu de data).
export const thumbUrl = (img: MsgImage) => {
  const base = img.proxy_url || img.url;
  return base + (base.includes("?") ? "&" : "?") + "width=240&height=240";
};

// Extrait les liens http(s) du texte (dédupliqués, sans la ponctuation finale).
const URL_RE = /(https?:\/\/[^\s<>"')]+)/g;
const extractLinks = (text: string): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const u = m[1].replace(/[.,;:!?]+$/, "");
    if (!out.includes(u)) out.push(u);
  }
  return out;
};
// Libellé court et lisible d'un lien (hôte + début de chemin).
const shortLink = (url: string) => {
  try { const u = new URL(url); const p = u.pathname !== "/" ? u.pathname : ""; const s = u.host + p; return s.length > 38 ? s.slice(0, 37) + "…" : s; }
  catch { return url.length > 38 ? url.slice(0, 37) + "…" : url; }
};

// Couleur stable par auteur (comme Discord, agréable à scanner).
const NAME_COLORS = ["#5865f2", "#23a55a", "#f0b232", "#eb459e", "#f23f43", "#00a8fc", "#9b59b6"];
export const colorFor = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
};
export const shortTime = (ts: string | null) => {
  if (!ts) return "";
  try { const d = new Date(ts); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
};

// Émojis de réaction rapide (Unicode standard uniquement, cf. mapMsg côté JS —
// pas d'emoji custom serveur, ça demanderait de charger la liste d'émojis de
// la guilde, hors scope).
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

// Un message. `Btn` (DialogButton), PAS un `Focusable` brut : un simple
// Focusable avec onFocus/onGamepadFocus perd son statut d'arrêt de nav dès
// qu'un autre vrai composant interactif (lien Btn, image Focusable+onActivate)
// est présent ailleurs dans la liste — seuls ces derniers restaient atteignables
// (retour user, régression du 1er essai). DialogButton est le SEUL composant
// utilisé pour le tracking de focus custom partout ailleurs dans ce fichier/
// VoiceChatViews (`focusHalo`) : on suit exactement le même pattern ici.
export function MessageRow({ m, channelId, isMine, onLocalUpdate, onLocalDelete, onReply }: {
  m: Message; channelId?: string; isMine?: boolean;
  onLocalUpdate?: (patch: Partial<Message>) => void;
  onLocalDelete?: () => void;
  onReply?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(m.content);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pickingEmoji, setPickingEmoji] = useState(false);
  const [busy, setBusy] = useState(false);
  const links = extractLinks(m.content || "");
  const hasBody = !!m.content || (m.images?.length ?? 0) > 0 || (m.files ?? 0) > 0;

  const toggleReaction = (r: MsgReaction) => {
    if (!channelId || busy) return;
    setBusy(true);
    const method = r.me ? "remove_reaction" : "add_reaction";
    call(method, channelId, m.id, r.emoji)
      .catch(() => {})
      .finally(() => setBusy(false));
    onLocalUpdate?.({
      reactions: (m.reactions || []).map((x) => x.emoji === r.emoji
        ? { ...x, me: !x.me, count: x.count + (x.me ? -1 : 1) }
        : x),
    });
  };

  const addQuickReaction = (emoji: string) => {
    if (!channelId || busy) return;
    setPickingEmoji(false);
    setBusy(true);
    call("add_reaction", channelId, m.id, emoji).catch(() => {}).finally(() => setBusy(false));
    const existing = (m.reactions || []).find((x) => x.emoji === emoji);
    const reactions = existing
      ? (m.reactions || []).map((x) => x.emoji === emoji ? { ...x, me: true, count: x.count + (x.me ? 0 : 1) } : x)
      : [...(m.reactions || []), { emoji, count: 1, me: true }];
    onLocalUpdate?.({ reactions });
  };

  const saveEdit = () => {
    if (!channelId || busy || !editDraft.trim()) return;
    setBusy(true);
    call("edit_message", channelId, m.id, editDraft.trim())
      .then(() => { onLocalUpdate?.({ content: editDraft.trim() }); setEditing(false); })
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  const doDelete = () => {
    if (!channelId || busy) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      setTimeout(() => setConfirmingDelete(false), 4000);
      return;
    }
    setBusy(true);
    call("delete_message", channelId, m.id).then(() => onLocalDelete?.()).catch(() => setBusy(false));
  };

  // Un message avec lien(s)/image(s) — OU maintenant la rangée réactions/
  // édition qui suit toujours le contenu — a déjà ses propres arrêts de nav
  // internes (Btn de lien, Focusable d'image, bouton "+" réaction…) — un Btn
  // englobant SANS action au-dessus les rendait inatteignables au bouton A
  // (bouton imbriqué dans un bouton, retour user #20 : "j'appuie sur A sur le
  // lien, rien ne se passe"). Le wrapper englobant n'est un Btn (= son propre
  // arrêt de nav) que pour les messages qui n'ont RIEN d'autre de focusable —
  // en pratique ça n'arrive plus jamais depuis que le bouton "+" réaction est
  // toujours présent, mais on garde le filet de sécurité au cas où.
  const hasInteractiveChild = true;

  const rowStyle = {
    display: "block", textAlign: "left" as const, width: "100%", color: "#fff",
    marginBottom: 7, marginTop: 0, fontSize: 12, lineHeight: 1.3, minHeight: 0,
    borderRadius: 6, padding: "3px 6px", boxSizing: "border-box" as const,
    background: focused ? "rgba(88,101,242,0.22)" : "transparent",
    boxShadow: focused ? "0 0 0 1px rgba(88,101,242,0.7)" : "none",
    transition: "background .08s ease, box-shadow .08s ease",
  };

  const body = (
    <>
      {m.reply_to && (
        <div style={{ display: "flex", gap: 4, fontSize: 10, opacity: 0.6, marginBottom: 2 }}>
          <span>↩</span>
          <span style={{ fontWeight: 600 }}>{m.reply_to.author}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.reply_to.content}</span>
        </div>
      )}
      {/* Avatar en taille FIXE (16px, rond) + verticalAlign négatif pour
          s'asseoir sur la ligne du pseudo sans changer la hauteur de ligne —
          demande user : la miniature ne doit rien déformer. size=32 CDN pour
          rester net sur écran haute densité. */}
      <img
        src={m.avatar
          ? `https://cdn.discordapp.com/avatars/${m.author_id}/${m.avatar}.webp?size=32`
          : `https://cdn.discordapp.com/embed/avatars/0.png`}
        width={16} height={16}
        style={{ borderRadius: "50%", verticalAlign: "-3px", marginRight: 5 }}
      />
      <span style={{ color: colorFor(m.author_id), fontWeight: 600 }}>{m.author}</span>
      {m.bot && <span style={{ fontSize: 8, background: "#5865f2", color: "#fff", borderRadius: 3, padding: "0 3px", marginLeft: 4 }}>BOT</span>}
      <span style={{ opacity: 0.4, fontSize: 9, marginLeft: 5 }}>{shortTime(m.ts)}</span>

      {editing ? (
        <div style={{ marginTop: 3 }}>
          <TextField value={editDraft} onChange={(e: any) => setEditDraft(e?.target?.value ?? "")} style={{ fontSize: 12, width: "100%" }} />
          <Focusable flow-children="row" style={{ display: "flex", gap: 4, marginTop: 3 }}>
            <Btn disabled={busy || !editDraft.trim()} onClick={saveEdit} style={{ flex: 1, padding: "3px 0", fontSize: 11, minHeight: 0 }}>{t("save")}</Btn>
            <Btn disabled={busy} onClick={() => { setEditing(false); setEditDraft(m.content); }} style={{ flex: 1, padding: "3px 0", fontSize: 11, minHeight: 0 }}>{t("cancel")}</Btn>
          </Focusable>
        </div>
      ) : (
        m.content
          ? <div style={{ wordBreak: "break-word", whiteSpace: "pre-wrap", opacity: 0.92 }}>{m.content}</div>
          : (!hasBody && <div style={{ opacity: 0.4, fontStyle: "italic" }}>—</div>)
      )}

      {/* Miniatures d'images : ne se chargent que lorsque ce salon est
          ouvert (la vue messages n'est montée qu'à ce moment). Clic →
          image en grand dans le navigateur du gamemode Steam. */}
      {m.images?.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 3 }}>
          {m.images.map((img, i) => (
            <Focusable
              key={i}
              onActivate={() => openUrl(img.url)}
              onClick={() => openUrl(img.url)}
              style={{ display: "inline-block", borderRadius: 6, padding: 0, margin: 0 }}
            >
              <img
                src={thumbUrl(img)}
                style={{ width: 120, height: "auto", maxHeight: 160, display: "block", borderRadius: 6 }}
              />
            </Focusable>
          ))}
        </div>
      )}

      {/* Liens cliquables → navigateur gamemode Steam. */}
      {links.map((u, i) => (
        <Btn key={`l${i}`} onClick={() => openUrl(u)} style={{ width: "100%", padding: "3px 8px", marginTop: 3, fontSize: 11, display: "flex", gap: 6, alignItems: "center" }}>
          <span><IcLink /></span><span style={{ flex: 1, textAlign: "left", color: "#00a8fc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortLink(u)}</span>
        </Btn>
      ))}

      {m.files > 0 && <div style={{ opacity: 0.55, fontSize: 10, marginTop: 2 }}><IcPaperclip /> {m.files}</div>}

      {/* Réactions existantes (clic = ajouter/retirer la sienne) + bouton "+"
          pour en ajouter une nouvelle parmi un petit set d'émojis courants. */}
      {channelId && (
        <Focusable flow-children="row" style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4, alignItems: "center" }}>
          {(m.reactions || []).map((r) => (
            <ReactionPill key={r.emoji} r={r} disabled={busy} onClick={() => toggleReaction(r)} />
          ))}
          <ChipBtn disabled={busy} onClick={() => setPickingEmoji((v) => !v)}>+</ChipBtn>
          {onReply && !editing && (
            <ChipBtn disabled={busy} onClick={onReply}>{t("reply")}</ChipBtn>
          )}
          {isMine && !editing && (
            <>
              <ChipBtn disabled={busy} onClick={() => setEditing(true)}>{t("edit")}</ChipBtn>
              <ChipBtn disabled={busy} onClick={doDelete} color={confirmingDelete ? "#ed4245" : undefined}>
                {confirmingDelete ? t("confirm_delete") : t("delete")}
              </ChipBtn>
            </>
          )}
        </Focusable>
      )}
      {pickingEmoji && (
        <Focusable flow-children="row" style={{ display: "flex", gap: 4, marginTop: 3 }}>
          {QUICK_EMOJIS.map((e) => (
            <ChipBtn key={e} disabled={busy} onClick={() => addQuickReaction(e)}>{e}</ChipBtn>
          ))}
        </Focusable>
      )}
    </>
  );

  if (hasInteractiveChild) {
    // <div> simple, PAS un arrêt de nav lui-même : le halo suit quand même le
    // focus d'un enfant (lien/image/réaction) car React fait remonter
    // onFocus/onBlur par bubbling (focusin/focusout) depuis n'importe quel
    // descendant focusé.
    return (
      <div onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={rowStyle}>
        {body}
      </div>
    );
  }

  return (
    <Btn
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={rowStyle}
    >
      {body}
    </Btn>
  );
}

// `flex: "0 0 auto"` + `width: "auto"` explicites : un Btn (DialogButton) nu
// dans un conteneur flex garde sinon sa largeur interne par défaut (100%) tant
// que le flex-basis n'est pas forcé à une valeur non-"auto" — chaque puce/
// bouton se retrouvait plein-largeur, empilé au lieu d'être côte à côte
// (retour user #20, même famille que le bug soundboard/Envoyer déjà vu ce
// soir). `width:"auto"` en style inline gagne toujours sur un défaut interne
// en CSS classique, quelle que soit sa spécificité.
// ⚠️ Un essai précédent utilisait `flex-basis: "0%"` (pas "auto") pour aussi
// neutraliser une largeur minimale interne du DialogButton — mais un
// flex-basis EXPLICITE à 0% fixe la taille de base à zéro, et avec
// flex-grow:0 le bouton ne peut alors JAMAIS dépasser 0 : le texte
// (Répondre/Modifier/Supprimer) débordait sans jamais élargir sa boîte,
// empilant le texte de plusieurs puces au même endroit (capture user,
// texte illisible). `flex-basis: "auto"` redonne une taille de base basée
// sur le contenu (ce qui était voulu depuis le début) tout en gardant
// grow/shrink à 0 pour empêcher l'étirement plein-largeur.
const CHIP_SIZING = { flex: "0 0 auto", width: "auto", minWidth: 0 } as const;

function ReactionPill({ r, disabled, onClick }: { r: MsgReaction; disabled?: boolean; onClick: () => void }) {
  const [focused, setFocused] = useState(false);
  return (
    <Btn
      disabled={disabled}
      onClick={onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        ...CHIP_SIZING,
        padding: "2px 9px", fontSize: 11, lineHeight: "16px", minHeight: 0, borderRadius: 10, display: "flex", gap: 4, alignItems: "center",
        background: r.me ? "rgba(88,101,242,0.35)" : "rgba(255,255,255,0.08)",
        border: r.me ? "1px solid " + ACCENT : "1px solid transparent",
        ...focusHalo(ACCENT, focused),
      }}
    >
      <span>{r.emoji}</span><span style={{ opacity: 0.8 }}>{r.count}</span>
    </Btn>
  );
}

// Petit bouton d'action générique (+, Répondre, Modifier, Supprimer…) — même
// recette que ReactionPill : fond + halo de focus explicites (jamais le
// rendu natif DialogButton, blanc-sur-blanc au repos sinon — retour user) et
// taille au contenu, pas 100% du conteneur flex.
export function ChipBtn({ disabled, onClick, color, children }: { disabled?: boolean; onClick: () => void; color?: string; children: any }) {
  const [focused, setFocused] = useState(false);
  const c = color || ACCENT;
  return (
    <Btn
      disabled={disabled}
      onClick={onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        ...CHIP_SIZING,
        // Padding vertical généreux + lineHeight explicite : les glyphes emoji
        // (police couleur) ignorent souvent le fontSize en-dessous d'une
        // taille de rendu minimale et débordaient du bouton avec un padding
        // trop serré (retour user, capture à l'appui).
        padding: "2px 7px", fontSize: 11, lineHeight: "16px", minHeight: 0, borderRadius: 10, color: "#fff",
        background: focused ? c : "rgba(255,255,255,0.08)",
        opacity: disabled ? 0.5 : 1,
        ...focusHalo(c, focused),
      }}
    >
      {children}
    </Btn>
  );
}

// Avatar d'une conversation privée (DM/GroupDM), même logique que DMBrowser.
function DMAvatar({ ch }: { ch: DMChannel }) {
  if (ch.type === 3 && ch.icon) {
    return <img src={`https://cdn.discordapp.com/channel-icons/${ch.id}/${ch.icon}.webp?size=32`} width={20} height={20} style={{ borderRadius: "50%", flexShrink: 0 }} />;
  }
  if (ch.recipients.length >= 1) {
    const r = ch.recipients[0];
    return <img src={r.avatar ? `https://cdn.discordapp.com/avatars/${r.id}/${r.avatar}.webp?size=32` : `https://cdn.discordapp.com/embed/avatars/0.png`} width={20} height={20} style={{ borderRadius: "50%", flexShrink: 0 }} />;
  }
  return (
    <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#5865f2", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff" }}>
      {ch.name[0]?.toUpperCase()}
    </div>
  );
}

// Messagerie texte. `source` = "servers" (serveurs → salons texte) ou "dms"
// (conversations privées en texte). Les deux partagent la même vue de messages.
const PREVIEW_LIST_ID = "steamcord-msg-preview";

export function TextChat({ source }: { source: "servers" | "dms" }) {
  const fillList = useFillHeight();
  const fillPreview = useFillHeight(80, 56);
  const [guilds, setGuilds] = useState<Guild[] | null>(null);
  const [dms, setDms] = useState<DMChannel[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [channel, setChannel] = useState<{ id: string; name: string; dm: boolean } | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Réordonner/masquer les serveurs — même mécanisme (et mêmes prefs backend)
  // que l'onglet vocal (ChannelBrowser). Les MP ne sont pas concernés.
  const [showHidden, setShowHidden] = useState(false);
  const [editMode, setEditMode] = useState(false);

  // Charge la liste (serveurs ou MP) au montage, selon la source.
  // `guilds` contient TOUJOURS l'ensemble complet (masqués inclus, flag
  // `hidden`) — le filtrage pour l'affichage se fait au rendu (même piège
  // évité que ChannelBrowser : sinon le compteur de masqués retombe à 0
  // aussitôt un serveur masqué et ils deviennent irrécupérables).
  useEffect(() => {
    if (source === "servers") {
      call<[boolean], any>("get_text_channels", true)
        .then((res) => setGuilds(Array.isArray(res) ? res : []))
        .catch((e) => setError(errText(e)));
    } else {
      call<[], any>("get_dm_channels")
        .then((res) => setDms(Array.isArray(res) ? res : []))
        .catch((e) => setError(errText(e)));
    }
  }, [source]);

  // Mêmes opérations que ChannelBrowser (prefs backend partagées) : le swap
  // opère sur les positions RÉELLES dans `guilds` via la liste visible, pour
  // ne jamais déplacer un masqué par accident.
  const moveGuild = (guildId: string, delta: number) => {
    setGuilds(prev => {
      if (!prev) return prev;
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

  const toggleGuildHidden = (guild: Guild) => {
    const nextHidden = !guild.hidden;
    call("set_guild_hidden", guild.id, nextHidden).catch(() => {});
    setGuilds(prev => prev?.map(g => (g.id === guild.id ? { ...g, hidden: nextHidden } : g)) ?? prev);
  };

  // Preview passive du QAM : juste les derniers messages, pas d'historique ni
  // de fusion à gérer ici — la modale plein écran (ChatFullscreenModal) a son
  // propre état pour la vraie navigation/envoi (#20). Toujours recollée en bas
  // (pas de nav manette dans cette zone, donc pas de "flow" à préserver comme
  // dans la modale — juste un scroll auto vers le plus récent).
  const loadMessages = (chId: string) => {
    call<[string], any>("get_messages", chId)
      .then((res) => {
        const fresh = Array.isArray(res) ? res : [];
        // Un poll qui revient vide est un aléa passager (API/réseau), pas la
        // preuve que la conv s'est vidée — sinon l'aperçu clignotait "vide"
        // toutes les 5s dès qu'un poll ratait (retour user : "ça a tout
        // retiré"). Seul le tout premier chargement (messages encore null,
        // avant que quoi que ce soit ait été affiché) peut légitimement
        // afficher "aucun message".
        setMessages((prev) => (fresh.length > 0 || prev === null) ? fresh : prev);
        setTimeout(() => {
          const el = document.getElementById(PREVIEW_LIST_ID);
          if (el) el.scrollTop = el.scrollHeight;
        }, 50);
      })
      .catch(() => {}); // un poll raté garde le dernier aperçu affiché
  };

  const openChannel = (id: string, name: string, dm: boolean) => {
    setChannel({ id, name, dm });
    setMessages(null);
    loadMessages(id);
    // Salon suivi côté Vesktop : ses events MESSAGE_* sont poussés en temps
    // réel (event Decky "chat_message", consommé ici ET par la modale plein
    // écran). Le poll ne reste qu'en filet de sécurité de réconciliation
    // (reconnexions, events manqués) — les messages arrivent à la seconde.
    call("watch_channel", id).catch(() => {});
    if (_textPoll) clearInterval(_textPoll);
    _textPoll = setInterval(() => loadMessages(id), 20000);
  };

  const closeChannel = () => {
    if (_textPoll) { clearInterval(_textPoll); _textPoll = null; }
    call("watch_channel", "").catch(() => {});
    setChannel(null);
    setMessages(null);
  };

  useEffect(() => () => {
    if (_textPoll) { clearInterval(_textPoll); _textPoll = null; }
    call("watch_channel", "").catch(() => {});
  }, []);

  // Push temps réel pour l'aperçu passif : nouveaux messages / éditions /
  // suppressions du salon ouvert (les réactions ne sont pas affichées ici).
  useEffect(() => {
    if (!channel) return;
    const onChat = (data: any) => {
      if (!data || String(data.channel_id) !== String(channel.id)) return;
      if (data.op === "create" && data.message) {
        setMessages((prev) => {
          const base = prev ?? [];
          if (base.some((m) => m.id === data.message.id)) return prev;
          return [...base, data.message];
        });
        setTimeout(() => {
          const el = document.getElementById(PREVIEW_LIST_ID);
          if (el) el.scrollTop = el.scrollHeight;
        }, 50);
      } else if (data.op === "update" && data.message) {
        setMessages((prev) => prev?.map((m) => m.id === data.message.id ? { ...m, ...data.message } : m) ?? prev);
      } else if (data.op === "delete" && data.message_id) {
        setMessages((prev) => prev?.filter((m) => m.id !== data.message_id) ?? prev);
      }
    };
    addEventListener("chat_message", onChat);
    return () => removeEventListener("chat_message", onChat);
  }, [channel?.id]);

  // ── Vue passive d'un salon / d'une conversation : juste un aperçu des
  // derniers messages (non interactif, toujours collé aux plus récents) + un
  // bouton pour ouvrir la vraie vue plein écran (nav historique + réponse +
  // capture d'écran) — retour user #20 : le panneau QAM est trop étroit pour
  // naviguer confortablement, mieux vaut une vraie modale plein écran pour ça.
  if (channel) {
    const preview = (messages ?? []).slice(-10);
    return (
      <div>
        <Btn onClick={closeChannel} style={{ width: "100%", padding: "3px 8px", fontSize: 11, marginBottom: 6, display: "flex", gap: 6 }}>
          <span>←</span><span style={{ flex: 1, textAlign: "left" }}>{channel.dm ? channel.name : `#${channel.name}`}</span>
        </Btn>

        <div id={PREVIEW_LIST_ID} ref={fillPreview.ref} style={{ maxHeight: fillPreview.height, overflowY: "auto", marginBottom: 8 }}>
          {messages === null && <div style={{ padding: 8, opacity: 0.6, fontSize: 12 }}>{t("loading_messages")}</div>}
          {messages !== null && messages.length === 0 && <div style={{ padding: 8, opacity: 0.5, fontSize: 12 }}>{t("no_messages")}</div>}
          {preview.map((m) => (
            <div key={m.id} style={{ fontSize: 11, lineHeight: 1.35, marginBottom: 4, wordBreak: "break-word" }}>
              <img
                src={m.avatar
                  ? `https://cdn.discordapp.com/avatars/${m.author_id}/${m.avatar}.webp?size=32`
                  : `https://cdn.discordapp.com/embed/avatars/0.png`}
                width={14} height={14}
                style={{ borderRadius: "50%", verticalAlign: "-2px", marginRight: 4 }}
              />
              <span style={{ color: colorFor(m.author_id), fontWeight: 600 }}>{m.author}</span>
              {"  "}
              <span style={{ opacity: 0.85 }}>
                {m.content || (m.images?.length ? "📷" : m.files > 0 ? "📎" : "")}
              </span>
            </div>
          ))}
        </div>

        <Btn
          onClick={() => showModal(<ChatFullscreenModal channelId={channel.id} channelName={channel.name} isDm={channel.dm} />)}
          style={{ width: "100%", padding: "7px 0", fontSize: 13, display: "flex", gap: 6, alignItems: "center", justifyContent: "center" }}
        >
          <IcChat /> {t("open_chat")}
        </Btn>
        {error && <div style={{ color: "#ff6b6b", fontSize: 10, marginTop: 4 }}>{error}</div>}
      </div>
    );
  }

  // ── Vue BROWSER : conversations privées (texte) ───────────────────────────
  if (source === "dms") {
    return (
      <div>
        {error && <div style={{ padding: 8, color: "#ff6b6b", fontSize: 11 }}>{error}</div>}
        {dms === null && <div style={{ padding: 8, opacity: 0.6, fontSize: 13 }}>{t("loading")}</div>}
        {dms && dms.length === 0 && <div style={{ padding: 8, opacity: 0.5, fontSize: 12 }}>{t("no_dms")}</div>}
        {dms && dms.length > 0 && (
          <div ref={fillList.ref} style={{ maxHeight: fillList.height, overflowY: "auto", marginTop: 4 }}>
            {dms.map((ch) => (
              <Btn key={ch.id} onClick={() => openChannel(ch.id, ch.name, true)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "5px 8px", marginBottom: 3 }}>
                <DMAvatar ch={ch} />
                <span style={{ flex: 1, textAlign: "left", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.name}</span>
              </Btn>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Vue BROWSER : serveurs → salons texte ─────────────────────────────────
  // Réordonner/masquer : même UI que l'onglet vocal (ChannelBrowser) — puces
  // ↑/↓/œil cachées par défaut, révélées par le bouton réorganiser ; l'œil de
  // récupération visible dès qu'on parcourt les masqués.
  const hiddenCount = (guilds ?? []).filter(g => g.hidden).length;
  const visibleGuilds = (guilds ?? []).filter(g => showHidden || !g.hidden);
  return (
    <div>
      {error && <div style={{ padding: 8, color: "#ff6b6b", fontSize: 11 }}>{error}</div>}
      {guilds === null && <div style={{ padding: 8, opacity: 0.6, fontSize: 13 }}>{t("loading_servers")}</div>}
      {guilds && guilds.length === 0 && <div style={{ padding: 8, opacity: 0.5, fontSize: 12 }}>{t("no_channels")}</div>}
      {guilds && guilds.length > 0 && (
        <>
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
          </Focusable>
          <div ref={fillList.ref} style={{ maxHeight: fillList.height, overflowY: "auto", marginTop: 4 }}>
            {visibleGuilds.map((guild, i) => {
              const rowBtn = (flex: boolean) => (
                <Btn
                  onClick={() => setExpanded(expanded === guild.id ? null : guild.id)}
                  style={{ display: "flex", alignItems: "center", gap: 7, width: flex ? undefined : "100%", flex: flex ? 1 : undefined, minWidth: 0, padding: "5px 8px" }}
                >
                  {guild.icon
                    ? <img src={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=32`} width={18} height={18} style={{ borderRadius: "50%", flexShrink: 0 }} />
                    : <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#5865f2", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#fff" }}>{guild.name[0]}</div>}
                  <span style={{ flex: 1, textAlign: "left", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{guild.name}</span>
                  <span style={{ opacity: 0.4, fontSize: 10 }}>{expanded === guild.id ? "▲" : "▼"}</span>
                </Btn>
              );
              return (
                <div key={guild.id} style={{ marginBottom: 3, opacity: guild.hidden ? 0.5 : 1 }}>
                  {(editMode || showHidden) ? (
                    <Focusable flow-children="row" style={{ display: "flex", alignItems: "center", gap: 3 }}>
                      {rowBtn(true)}
                      {editMode && !showHidden && (
                        <>
                          <TinyIconBtn onClick={() => moveGuild(guild.id, -1)} disabled={i === 0} title={t("server_move_up")}><IcChevronUp /></TinyIconBtn>
                          <TinyIconBtn onClick={() => moveGuild(guild.id, 1)} disabled={i === visibleGuilds.length - 1} title={t("server_move_down")}><IcChevronDown /></TinyIconBtn>
                        </>
                      )}
                      <TinyIconBtn onClick={() => toggleGuildHidden(guild)} title={guild.hidden ? t("server_unhide") : t("server_hide")}>
                        {guild.hidden ? <IcEye /> : <IcEyeSlash />}
                      </TinyIconBtn>
                    </Focusable>
                  ) : rowBtn(false)}
                  {expanded === guild.id && (
                    <div style={{ paddingLeft: 6, marginTop: 2 }}>
                      {guild.channels.map((ch) => (
                        <Btn key={ch.id} onClick={() => openChannel(ch.id, ch.name, false)} style={{ width: "100%", padding: "4px 8px", marginBottom: 2, fontSize: 11, display: "flex", gap: 6 }}>
                          <span style={{ opacity: 0.6, fontSize: 10 }}>#</span>
                          <span style={{ flex: 1, textAlign: "left" }}>{ch.name}</span>
                        </Btn>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
