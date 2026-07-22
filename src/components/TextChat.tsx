import { DialogButton, Focusable, showModal } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t, errText } from "../i18n";
import { useFillHeight } from "./Styled";
import { IcChat, IcLink, IcPaperclip } from "./Icons";
import { ChatFullscreenModal } from "./ChatFullscreen";

// Intervalle de polling au niveau module (évite useRef — déconseillé dans le
// QAM DeckyLoader). Une seule instance de TextChat à la fois (le parent monte
// une instance distincte par source via `key`).
let _textPoll: any = null;

interface TextChannel { id: string; name: string; type: number; }
interface Guild { id: string; name: string; icon: string | null; channels: TextChannel[]; }
interface DMRecipient { id: string; username: string; avatar: string | null; }
interface DMChannel {
  id: string; type: number; name: string; icon: string | null;
  recipients: DMRecipient[]; active_call: boolean;
}
export interface MsgImage { url: string; proxy_url: string; w: number; h: number; }
export interface Message {
  id: string; author: string; author_id: string; avatar: string | null;
  bot: boolean; content: string; ts: string | null;
  images: MsgImage[]; files: number;
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

// Un message. `Btn` (DialogButton), PAS un `Focusable` brut : un simple
// Focusable avec onFocus/onGamepadFocus perd son statut d'arrêt de nav dès
// qu'un autre vrai composant interactif (lien Btn, image Focusable+onActivate)
// est présent ailleurs dans la liste — seuls ces derniers restaient atteignables
// (retour user, régression du 1er essai). DialogButton est le SEUL composant
// utilisé pour le tracking de focus custom partout ailleurs dans ce fichier/
// VoiceChatViews (`focusHalo`) : on suit exactement le même pattern ici.
export function MessageRow({ m }: { m: Message }) {
  const [focused, setFocused] = useState(false);
  const links = extractLinks(m.content || "");
  const hasBody = !!m.content || (m.images?.length ?? 0) > 0 || (m.files ?? 0) > 0;
  // Un message avec lien(s)/image(s) a déjà ses propres arrêts de nav internes
  // (Btn de lien, Focusable d'image) — un Btn englobant SANS action au-dessus
  // les rendait inatteignables au bouton A (bouton imbriqué dans un bouton,
  // retour user #20 : "j'appuie sur A sur le lien, rien ne se passe"). Le
  // wrapper englobant n'est un Btn (= son propre arrêt de nav) que pour les
  // messages plats qui n'ont RIEN d'autre de focusable (nécessaire pour
  // qu'un message texte sans lien reste quand même atteignable, cf. #17).
  const hasInteractiveChild = links.length > 0 || (m.images?.length ?? 0) > 0;

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
      <span style={{ color: colorFor(m.author_id), fontWeight: 600 }}>{m.author}</span>
      {m.bot && <span style={{ fontSize: 8, background: "#5865f2", color: "#fff", borderRadius: 3, padding: "0 3px", marginLeft: 4 }}>BOT</span>}
      <span style={{ opacity: 0.4, fontSize: 9, marginLeft: 5 }}>{shortTime(m.ts)}</span>
      {m.content
        ? <div style={{ wordBreak: "break-word", whiteSpace: "pre-wrap", opacity: 0.92 }}>{m.content}</div>
        : (!hasBody && <div style={{ opacity: 0.4, fontStyle: "italic" }}>—</div>)}

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
    </>
  );

  if (hasInteractiveChild) {
    // <div> simple, PAS un arrêt de nav lui-même : le halo suit quand même le
    // focus d'un enfant (lien/image) car React fait remonter onFocus/onBlur
    // par bubbling (focusin/focusout) depuis n'importe quel descendant focusé.
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

  // Charge la liste (serveurs ou MP) au montage, selon la source.
  useEffect(() => {
    if (source === "servers") {
      call<[], any>("get_text_channels")
        .then((res) => setGuilds(Array.isArray(res) ? res : []))
        .catch((e) => setError(errText(e)));
    } else {
      call<[], any>("get_dm_channels")
        .then((res) => setDms(Array.isArray(res) ? res : []))
        .catch((e) => setError(errText(e)));
    }
  }, [source]);

  // Preview passive du QAM : juste les derniers messages, pas d'historique ni
  // de fusion à gérer ici — la modale plein écran (ChatFullscreenModal) a son
  // propre état pour la vraie navigation/envoi (#20). Toujours recollée en bas
  // (pas de nav manette dans cette zone, donc pas de "flow" à préserver comme
  // dans la modale — juste un scroll auto vers le plus récent).
  const loadMessages = (chId: string) => {
    call<[string], any>("get_messages", chId)
      .then((res) => {
        setMessages(Array.isArray(res) ? res : []);
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
    if (_textPoll) clearInterval(_textPoll);
    _textPoll = setInterval(() => loadMessages(id), 5000);
  };

  const closeChannel = () => {
    if (_textPoll) { clearInterval(_textPoll); _textPoll = null; }
    setChannel(null);
    setMessages(null);
  };

  useEffect(() => () => {
    if (_textPoll) { clearInterval(_textPoll); _textPoll = null; }
  }, []);

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
  return (
    <div>
      {error && <div style={{ padding: 8, color: "#ff6b6b", fontSize: 11 }}>{error}</div>}
      {guilds === null && <div style={{ padding: 8, opacity: 0.6, fontSize: 13 }}>{t("loading_servers")}</div>}
      {guilds && guilds.length === 0 && <div style={{ padding: 8, opacity: 0.5, fontSize: 12 }}>{t("no_channels")}</div>}
      {guilds && guilds.length > 0 && (
        <div ref={fillList.ref} style={{ maxHeight: fillList.height, overflowY: "auto", marginTop: 4 }}>
          {guilds.map((guild) => (
            <div key={guild.id} style={{ marginBottom: 3 }}>
              <Btn
                onClick={() => setExpanded(expanded === guild.id ? null : guild.id)}
                style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "5px 8px" }}
              >
                {guild.icon
                  ? <img src={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=32`} width={18} height={18} style={{ borderRadius: "50%", flexShrink: 0 }} />
                  : <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#5865f2", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#fff" }}>{guild.name[0]}</div>}
                <span style={{ flex: 1, textAlign: "left", fontSize: 12 }}>{guild.name}</span>
                <span style={{ opacity: 0.4, fontSize: 10 }}>{expanded === guild.id ? "▲" : "▼"}</span>
              </Btn>
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
          ))}
        </div>
      )}
    </div>
  );
}
