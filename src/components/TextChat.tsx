import { DialogButton, Focusable, TextField } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t, errText } from "../i18n";
import { useFillHeight } from "./Styled";
import { IcLink, IcPaperclip } from "./Icons";

// Intervalle de polling au niveau module (évite useRef — déconseillé dans le
// QAM DeckyLoader). Une seule instance de TextChat à la fois (le parent monte
// une instance distincte par source via `key`).
let _textPoll: any = null;
const MSG_LIST_ID = "steamcord-msglist";
// Doit suivre le `limit=30` côté backend (defaults/steamcord_client.js) : sert
// juste d'heuristique pour savoir si un lot plein = probablement encore de l'historique.
const PAGE_SIZE = 30;
const NEAR_BOTTOM_PX = 80;
const scrollMsgsBottom = () => {
  setTimeout(() => {
    const el = document.getElementById(MSG_LIST_ID);
    if (el) el.scrollTop = el.scrollHeight;
  }, 50);
};
const isNearBottom = () => {
  const el = document.getElementById(MSG_LIST_ID);
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
};

// Salon/conversation texte actuellement OUVERT — partagé avec UploadScreenshot
// pour que le partage de capture cible la conversation en cours.
export let currentTextChannel: { id: string; name: string; dm: boolean } | null = null;
const _channelSubs = new Set<() => void>();
export const onTextChannelChange = (fn: () => void) => { _channelSubs.add(fn); return () => { _channelSubs.delete(fn); }; };
const setCurrentTextChannel = (c: typeof currentTextChannel) => {
  currentTextChannel = c;
  _channelSubs.forEach((f) => { try { f(); } catch {} });
};

interface TextChannel { id: string; name: string; type: number; }
interface Guild { id: string; name: string; icon: string | null; channels: TextChannel[]; }
interface DMRecipient { id: string; username: string; avatar: string | null; }
interface DMChannel {
  id: string; type: number; name: string; icon: string | null;
  recipients: DMRecipient[]; active_call: boolean;
}
interface MsgImage { url: string; proxy_url: string; w: number; h: number; }
interface Message {
  id: string; author: string; author_id: string; avatar: string | null;
  bot: boolean; content: string; ts: string | null;
  images: MsgImage[]; files: number;
}

const Btn = DialogButton as any;

// Ouvre une URL dans le navigateur intégré du gamemode Steam (overlay web).
const openUrl = (url: string) => {
  try { (window as any).SteamClient?.URL?.ExecuteSteamURL?.("steam://openurl/" + url); } catch {}
};

// Miniature légère via le CDN média Discord (redimensionne côté serveur → peu de data).
const thumbUrl = (img: MsgImage) => {
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
const colorFor = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
};
const shortTime = (ts: string | null) => {
  if (!ts) return "";
  try { const d = new Date(ts); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
};

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
export function TextChat({ source }: { source: "servers" | "dms" }) {
  // Deux instances : la liste de messages garde de la place sous elle pour le
  // champ de saisie + bouton Envoyer (~110px) en plus de la marge commune.
  const fillList = useFillHeight();
  const fillMsgs = useFillHeight(200, 124);
  const [guilds, setGuilds] = useState<Guild[] | null>(null);
  const [dms, setDms] = useState<DMChannel[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [channel, setChannel] = useState<{ id: string; name: string; dm: boolean } | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
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

  // `force` = premier chargement d'un salon (ou juste après un envoi) : on
  // remplace tout et on scrolle en bas inconditionnellement. Sans `force`
  // (poll 5 s), on fusionne avec l'historique déjà remonté via loadOlder au
  // lieu d'écraser — et on ne recolle en bas que si l'utilisateur y était déjà
  // (sinon un poll pendant qu'on lit l'historique renverrait tout en bas).
  const loadMessages = (chId: string, force = false) => {
    call<[string], any>("get_messages", chId)
      .then((res) => {
        const fresh: Message[] = Array.isArray(res) ? res : [];
        const stick = force || isNearBottom();
        setMessages((prev) => {
          if (!prev || fresh.length === 0) return fresh;
          const freshIds = new Set(fresh.map((m) => m.id));
          const oldestFreshId = fresh[0].id;
          const preserved = prev.filter((m) => !freshIds.has(m.id) && BigInt(m.id) < BigInt(oldestFreshId));
          return [...preserved, ...fresh];
        });
        setHasMore(fresh.length >= PAGE_SIZE);
        if (stick) scrollMsgsBottom(); // auto-scroll vers le message le plus récent
      })
      .catch(() => { if (force) setMessages([]); }); // un poll raté ne doit pas effacer ce qui est déjà affiché
  };

  // Remonte un lot plus ancien (avant le plus vieux message chargé) et le
  // préfixe à la liste, en compensant le scroll pour ne pas faire sauter la
  // vue (#17 : impossible de voir le début de la conversation).
  const loadOlder = () => {
    if (!channel || !messages || messages.length === 0 || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    const oldestId = messages[0].id;
    const el = document.getElementById(MSG_LIST_ID);
    const prevScrollHeight = el?.scrollHeight ?? 0;
    call<[string, string], any>("get_messages", channel.id, oldestId)
      .then((res) => {
        const older: Message[] = Array.isArray(res) ? res : [];
        setHasMore(older.length >= PAGE_SIZE);
        if (older.length > 0) {
          setMessages((prev) => [...older, ...(prev || [])]);
          setTimeout(() => {
            const el2 = document.getElementById(MSG_LIST_ID);
            if (el2) el2.scrollTop += el2.scrollHeight - prevScrollHeight;
          }, 50);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingOlder(false));
  };

  const openChannel = (id: string, name: string, dm: boolean) => {
    setChannel({ id, name, dm });
    setCurrentTextChannel({ id, name, dm }); // → cible du partage de capture
    setMessages(null);
    setHasMore(true);
    loadMessages(id, true);
    if (_textPoll) clearInterval(_textPoll);
    _textPoll = setInterval(() => loadMessages(id), 5000);
  };

  const closeChannel = () => {
    if (_textPoll) { clearInterval(_textPoll); _textPoll = null; }
    setChannel(null);
    setCurrentTextChannel(null);
    setMessages(null);
    setDraft("");
  };

  useEffect(() => () => {
    if (_textPoll) { clearInterval(_textPoll); _textPoll = null; }
    setCurrentTextChannel(null);
  }, []);

  const send = async () => {
    const text = draft.trim();
    if (!text || !channel || sending) return;
    setSending(true);
    try {
      await call("send_message", channel.id, text);
      setDraft("");
      loadMessages(channel.id, true);
    } catch (e) { setError(String(e)); }
    setSending(false);
  };

  // ── Vue MESSAGES d'un salon / d'une conversation ──────────────────────────
  if (channel) {
    return (
      <div>
        <Btn onClick={closeChannel} style={{ width: "100%", padding: "3px 8px", fontSize: 11, marginBottom: 4, display: "flex", gap: 6 }}>
          <span>←</span><span style={{ flex: 1, textAlign: "left" }}>{channel.dm ? channel.name : `#${channel.name}`}</span>
        </Btn>

        <div id={MSG_LIST_ID} ref={fillMsgs.ref} style={{ maxHeight: fillMsgs.height, overflowY: "auto", marginBottom: 6, paddingRight: 2 }}>
          {messages === null && <div style={{ padding: 8, opacity: 0.6, fontSize: 12 }}>{t("loading_messages")}</div>}
          {messages !== null && messages.length === 0 && <div style={{ padding: 8, opacity: 0.5, fontSize: 12 }}>{t("no_messages")}</div>}
          {messages !== null && messages.length > 0 && hasMore && (
            <Btn
              disabled={loadingOlder}
              onClick={loadOlder}
              style={{ width: "100%", padding: "3px 8px", marginBottom: 6, fontSize: 11 }}
            >
              {loadingOlder ? t("loading_older") : t("load_older")}
            </Btn>
          )}
          {messages?.map((m) => {
            const links = extractLinks(m.content || "");
            const hasBody = !!m.content || (m.images?.length ?? 0) > 0 || (m.files ?? 0) > 0;
            return (
              // Focusable même sans lien/image : sans ça, seuls les messages
              // avec lien ou image sont des arrêts de nav manette/clavier, et
              // le scroll (qui suit le focus) saute les messages "plats" (#17).
              <Focusable key={m.id} noFocusRing style={{ display: "block", marginBottom: 7, fontSize: 12, lineHeight: 1.3 }}>
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
              </Focusable>
            );
          })}
        </div>

        {/* Réponse : champ pleine largeur, bouton Envoyer en dessous (empilé).
            Le clavier Steam s'ouvre tout seul au focus du champ. */}
        <div>
          <TextField
            value={draft}
            placeholder={t("message_placeholder")}
            onChange={(e: any) => setDraft(e?.target?.value ?? "")}
            style={{ fontSize: 12, width: "100%" }}
          />
          <Btn
            disabled={sending || !draft.trim()}
            onClick={send}
            style={{ width: "100%", marginTop: 4, padding: "5px 0", fontSize: 12, minHeight: 0 }}
          >
            {sending ? "…" : t("send")}
          </Btn>
        </div>
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
