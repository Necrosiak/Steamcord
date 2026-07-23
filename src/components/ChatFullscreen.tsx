import { Focusable, ModalRoot, NavEntryPositionPreferences, TextField } from "@decky/ui";
import { addEventListener, call, removeEventListener } from "@decky/api";
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { Btn, ChipBtn, Message, MessageRow, draftByChannel, notifyTypingThrottled } from "./TextChat";
import { ScreenshotPickerButton } from "./ScreenshotPicker";
import { IcChevronDown } from "./Icons";
import { ActionCard, ACCENT, focusHalo } from "./Styled";
import { useSteamcordState } from "../hooks/useSteamcordState";

const ModalRootAny = ModalRoot as any;

// Bouton Envoyer de la rangée composer : `flex` posé DIRECTEMENT sur le Btn,
// PAS sur un <div> enveloppant (retour user #20 : le bouton n'était plus
// navigable à la manette). Même piège/recette que TabBtn (index.tsx) — un
// Focusable flow-children="row" attend ses enfants focusables en
// contact direct, un wrapper intermédiaire casse la navigation de toute la
// rangée, pas seulement de l'enfant enveloppé.
export function SendBtn({ disabled, onClick, children }: { disabled?: boolean; onClick: () => void; children: any }) {
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
        flex: "1 1 0", minWidth: 0, padding: "6px 0", fontSize: 13, minHeight: 0,
        color: "#fff", textAlign: "center", boxSizing: "border-box",
        background: focused ? "rgba(88,101,242,0.85)" : "rgba(255,255,255,0.08)",
        opacity: disabled ? 0.5 : 1,
        ...focusHalo(ACCENT, focused),
      }}
    >
      {children}
    </Btn>
  );
}

// Doit suivre le `limit=30` côté backend (defaults/steamcord_client.js) : sert
// juste d'heuristique pour savoir si un lot plein = probablement encore de l'historique.
const PAGE_SIZE = 30;
const NEAR_BOTTOM_PX = 80;
const FS_MSG_LIST_ID = "steamcord-msglist-fs";
const FS_MSG_FLOW_ID = "steamcord-msgflow-fs";
// Brouillon par salon et throttle "en train d'écrire" : partagés avec le
// composer rapide du QAM — voir `draftByChannel`/`notifyTypingThrottled` dans
// TextChat.tsx. Un texte commencé d'un côté se retrouve de l'autre, et survit
// aux fermetures accidentelles (B du clavier virtuel qui remonte au onCancel…).

// Le conteneur scrollable est en `flex-direction: column-reverse` (l'astuce
// standard des UIs de chat, Discord inclus) : dans ce mode le navigateur ancre
// nativement la vue sur le BAS (scrollTop 0 = bas, valeurs NÉGATIVES en
// remontant) — la conv s'ouvre donc directement sur le dernier message, sans
// timer ni retry, même si des images se décodent après coup (l'ancrage natif
// tient tout seul, contrairement aux anciens scrollTop=scrollHeight échelonnés
// qui rataient dès que la hauteur bougeait encore — retour user #20, deux fois).
const scrollFsBottom = () => {
  setTimeout(() => {
    const el = document.getElementById(FS_MSG_LIST_ID);
    if (el) el.scrollTop = 0;
  }, 50);
};
// Focus manette initial sur le DERNIER message (retour user #20) — sans ça,
// Steam pose le focus sur le tout premier élément focusable de la modale (le
// bouton "load older" tout en haut), obligeant à naviguer jusqu'en bas à
// chaque ouverture.
//
// `navEntryPreferPosition={LAST}` posé sur le Focusable de la liste (voir plus
// bas) ne suffit PAS seul : d'après la doc de la lib, cette préférence n'est
// appliquée que quand la nav manette ENTRE dans le conteneur (un vrai focus
// posé dessus) — sur un simple montage sans aucune entrée manette encore
// reçue, rien ne se passe (constaté en vrai : il fallait bouger le stick une
// fois pour que ça "prenne"). Il faut donc déclencher nous-mêmes cette entrée
// au montage : `.focus()` sur le CONTENEUR Focusable lui-même (PAS sur un
// message individuel — ses enfants ne sont pas forcément de vrais éléments
// DOM focusables au sens natif, un `.focus()` dessus ne fait rien ; c'est le
// conteneur qui l'est et qui délègue ensuite en interne selon
// navEntryPreferPosition).
const focusLastMessage = () => {
  setTimeout(() => {
    const flow = document.getElementById(FS_MSG_FLOW_ID);
    flow?.focus?.();
    setTimeout(() => {
      const el = document.getElementById(FS_MSG_LIST_ID);
      if (el) el.scrollTop = 0;
    }, 50);
  }, 700);
};
// En column-reverse, scrollTop vaut 0 en bas et devient NÉGATIF en remontant
// dans l'historique (sémantique Chromium standard pour ce mode).
const isFsNearBottom = () => {
  const el = document.getElementById(FS_MSG_LIST_ID);
  return !el || -el.scrollTop < NEAR_BOTTOM_PX;
};

// Vraie vue plein écran d'un salon/conversation — historique navigable,
// réponse et partage de capture, dans une vraie modale Steam (même mécanisme
// que FullscreenVideoModal dans VoiceChatViews.tsx : un overlay CSS ne sort
// jamais du panneau QAM en gamescope, la modale si — B la ferme nativement).
// État entièrement AUTONOME, pas partagé avec le panneau QAM qui n'affiche
// plus qu'un aperçu passif derrière (retour user #20 : le panneau est trop
// étroit pour naviguer confortablement dans l'historique).
//
// "Flow" (#20) : la liste recolle automatiquement en bas tant que l'utilisateur
// n'a pas scrollé loin des derniers messages (mêmes heuristique/seuil que
// l'ancien panneau QAM) ; dès qu'il s'en éloigne, l'auto-scroll s'arrête et un
// bouton "revenir aux derniers messages" apparaît pour reprendre le flux.
export function ChatFullscreenModal({ channelId, channelName, isDm, closeModal, onClosed }:
  { channelId: string; channelName: string; isDm: boolean; closeModal?: () => void; onClosed?: () => void }) {
  const myId = useSteamcordState()?.me?.id;
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [draft, setDraft] = useState(draftByChannel[channelId] || "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setFocusedInitial] = useState(false);
  const [typingUser, setTypingUser] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<{ id: string; author: string } | null>(null);

  // "X is typing…" (#20) — poussé en direct par le backend (event Decky
  // "typing", pas de polling) dès qu'un TYPING_START Discord arrive pour ce
  // salon. Discord n'a pas d'event "a arrêté d'écrire" (juste des TYPING_START
  // répétés tant que la personne écrit) → on efface tout seul si rien de
  // neuf n'arrive pendant quelques secondes.
  useEffect(() => {
    let clearTimer: any = null;
    const onTyping = (data: { channel_id: string; username: string }) => {
      if (data.channel_id !== channelId) return;
      setTypingUser(data.username);
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = setTimeout(() => setTypingUser(null), 8000);
    };
    addEventListener("typing", onTyping);
    return () => {
      removeEventListener("typing", onTyping);
      if (clearTimer) clearTimeout(clearTimer);
    };
  }, [channelId]);

  // `force` = 1er chargement (ou juste après un envoi) : remplace tout et
  // recolle en bas inconditionnellement. Sans `force` (poll 5s), fusionne avec
  // l'historique déjà remonté via loadOlder et ne recolle que si on y était déjà.
  const loadMessages = (force = false) => {
    call<[string], any>("get_messages", channelId)
      .then((res) => {
        const fresh: Message[] = Array.isArray(res) ? res : [];
        const stick = force || isFsNearBottom();
        setMessages((prev) => {
          if (!prev) return fresh;
          // Un poll (force=false) qui revient vide est un aléa passager (API,
          // réseau) — PAS la preuve que la conversation s'est vidée. Avant, ça
          // écrasait tout l'historique déjà affiché par un tableau vide toutes
          // les 5s dès qu'un poll ratait, donnant l'impression que la conv se
          // "rechargeait" en clignotant (retour user : "entre 2 ça a tout
          // retiré"). Seul un chargement FORCÉ (changement de salon, envoi)
          // peut légitimement afficher "aucun message".
          if (fresh.length === 0) return force ? fresh : prev;
          const freshIds = new Set(fresh.map((m) => m.id));
          const oldestFreshId = fresh[0].id;
          const preserved = prev.filter((m) => !freshIds.has(m.id) && BigInt(m.id) < BigInt(oldestFreshId));
          return [...preserved, ...fresh];
        });
        setHasMore(fresh.length >= PAGE_SIZE);
        if (stick) { scrollFsBottom(); setAtBottom(true); }
        if (force && fresh.length > 0) {
          setFocusedInitial((already) => { if (!already) focusLastMessage(); return true; });
        }
      })
      .catch(() => { if (force) setMessages([]); }); // un poll raté ne doit pas effacer ce qui est déjà affiché
  };

  useEffect(() => {
    loadMessages(true);
    // Poll = simple filet de sécurité de réconciliation (events manqués
    // pendant une reconnexion WS, réactions custom…) : les nouveaux messages
    // arrivent en TEMPS RÉEL via l'event "chat_message" ci-dessous, plus
    // besoin d'un poll rapproché (retour user : les messages doivent arriver
    // à la seconde, pas au prochain poll).
    const iv = setInterval(() => loadMessages(false), 20000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // Diagnostic fermeture fantôme (retour user : "j'envoie, la conv se ferme et
  // le message n'est pas parti" — AUCUN appel send_message dans webhelper_js à
  // ce moment-là, donc la modale s'est fermée SANS que le bouton soit activé).
  // Trace le démontage pour corréler avec les inputs la prochaine fois.
  // `onClosed` : prévient le composer rapide du QAM resté monté derrière la
  // modale, pour qu'il resynchronise son brouillon (envoyé ou modifié ici).
  useEffect(() => () => {
    console.log("[Steamcord] fullscreen chat unmounted (channel " + channelId + ")");
    onClosed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // Push temps réel : nouveaux messages / éditions / suppressions / réactions
  // du salon suivi, poussés par le backend via l'event Decky "chat_message"
  // (même canal que "typing") dès que Discord les reçoit.
  useEffect(() => {
    const onChat = (data: any) => {
      if (!data || String(data.channel_id) !== String(channelId)) return;
      if (data.op === "create" && data.message) {
        // La personne dont le message vient d'arriver n'est plus "en train
        // d'écrire" — Discord n'envoie pas d'event de fin de frappe.
        setTypingUser((cur) => (cur === data.message.author ? null : cur));
        const wasNearBottom = isFsNearBottom();
        setMessages((prev) => {
          if (!prev) return [data.message];
          if (prev.some((m) => m.id === data.message.id)) return prev;
          return [...prev, data.message];
        });
        // Re-colle explicitement en bas si on y était (mesuré au CDP : même
        // en column-reverse, scrollTop dérivait de quelques px sous les
        // insertions → le nouveau message finissait coupé par le bord bas).
        // Plus haut dans l'historique : on n'y touche pas, le bouton
        // "revenir aux derniers messages" est là pour ça.
        if (wasNearBottom) { scrollFsBottom(); setAtBottom(true); }
      } else if (data.op === "update" && data.message) {
        setMessages((prev) => prev?.map((m) => m.id === data.message.id ? { ...m, ...data.message } : m) ?? prev);
      } else if (data.op === "delete" && data.message_id) {
        setMessages((prev) => prev?.filter((m) => m.id !== data.message_id) ?? prev);
      } else if ((data.op === "reaction_add" || data.op === "reaction_remove") && data.message_id && data.emoji) {
        const delta = data.op === "reaction_add" ? 1 : -1;
        setMessages((prev) => prev?.map((m) => {
          if (m.id !== data.message_id) return m;
          const reactions = [...(m.reactions || [])];
          const i = reactions.findIndex((r) => r.emoji === data.emoji);
          if (i >= 0) {
            const next = {
              ...reactions[i],
              count: reactions[i].count + delta,
              me: data.me ? delta > 0 : reactions[i].me,
            };
            if (next.count <= 0) reactions.splice(i, 1); else reactions[i] = next;
          } else if (delta > 0) {
            reactions.push({ emoji: data.emoji, count: 1, me: !!data.me });
          }
          return { ...m, reactions };
        }) ?? prev);
      }
    };
    addEventListener("chat_message", onChat);
    return () => removeEventListener("chat_message", onChat);
  }, [channelId]);

  // Remonte un lot plus ancien et le préfixe à la liste. Pas de compensation
  // de scroll : en column-reverse la position est mesurée depuis le BAS, donc
  // du contenu ajouté en haut ne fait pas sauter la vue (ancrage natif).
  const loadOlder = () => {
    if (!messages || messages.length === 0 || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    const oldestId = messages[0].id;
    call<[string, string], any>("get_messages", channelId, oldestId)
      .then((res) => {
        const older: Message[] = Array.isArray(res) ? res : [];
        setHasMore(older.length >= PAGE_SIZE);
        if (older.length > 0) {
          setMessages((prev) => [...older, ...(prev || [])]);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingOlder(false));
  };

  const send = async () => {
    const text = draft.trim();
    console.log("[Steamcord] fullscreen chat send() text.len=" + text.length + " sending=" + sending);
    if (!text || sending) return;
    setSending(true);
    try {
      await call("send_message", channelId, text, replyTarget?.id);
      setDraft("");
      delete draftByChannel[channelId];
      setReplyTarget(null);
      loadMessages(true);
    } catch (e) {
      console.error("[Steamcord] fullscreen chat send FAILED", e);
      setError(String(e));
    }
    setSending(false);
  };

  const jumpToLatest = () => { scrollFsBottom(); setAtBottom(true); };

  return (
    <ModalRootAny
      closeModal={closeModal}
      onCancel={() => closeModal?.()}
      onCancelActionDescription={t("video_exit_fullscreen")}
      bAllowFullSize
    >
      <div style={{ display: "flex", flexDirection: "column", height: "78vh", maxWidth: 720, margin: "0 auto", width: "100%" }}>
        <div style={{
          fontSize: 16, fontWeight: 600, textAlign: "center", marginBottom: 8,
          padding: "8px 12px", borderRadius: 8, background: "rgba(255,255,255,0.06)",
        }}>
          {isDm ? channelName : `#${channelName}`}
        </div>

        {/* Ancrage bas type chat : le SCROLLER est en flex column-reverse →
            le navigateur ancre nativement la vue en bas (scrollTop 0 = bas,
            valeurs négatives en remontant), la conv s'ouvre sur le dernier
            message et y reste collée, sans timers.
            ⚠️ Trois pièges rencontrés en vrai (retours user en direct) :
            ① Le scroller ne doit avoir qu'UN SEUL enfant (le Focusable, avec
            flexShrink:0) : un conteneur flex à hauteur contrainte COMPRESSE
            ses enfants avant de laisser déborder — avec les messages en
            enfants directs, tous écrasés à ~0 de haut, texte superposé ET nav
            morte (une cible à hauteur nulle n'est plus un arrêt de nav).
            ② overflow-anchor: none — le scroll-anchoring de Chromium se bat
            avec column-reverse à chaque insertion de message : mesuré au CDP,
            scrollTop dérivait de 0 à -10px et le nouveau message glissait
            SOUS le bord bas du scroller ("le message arrive en dessous de la
            zone de saisie"). L'ancrage column-reverse suffit, celui de
            Chromium ne fait que parasiter.
            ③ Le flow interne reste un "column" NORMAL (chronologique, plus
            ancien en premier, "charger les plus anciens" tout en haut du DOM
            comme du visuel) : un flow-children="column-reverse" a un ordre de
            nav ambigu côté Steam — l'entrée depuis le composer atterrissait
            sur le message le PLUS ANCIEN. Avec column + navEntryPreferPosition
            =LAST, l'entrée vise le DERNIER enfant = le message le plus récent
            (en bas, adjacent au composer), puis chaque cran remonte d'un
            message. Le Focusable n'ayant pas de hauteur contrainte, ses
            enfants gardent leur vraie taille (cf. ①). */}
        <div
          id={FS_MSG_LIST_ID}
          style={{ flex: 1, overflowY: "auto", paddingRight: 4, display: "flex", flexDirection: "column-reverse", overflowAnchor: "none" }}
          onScroll={() => setAtBottom(isFsNearBottom())}
        >
          <Focusable
            id={FS_MSG_FLOW_ID}
            flow-children="column"
            navEntryPreferPosition={NavEntryPositionPreferences.LAST}
            style={{ flexShrink: 0 }}
          >
            {messages === null && <div style={{ padding: 8, opacity: 0.6, fontSize: 13 }}>{t("loading_messages")}</div>}
            {messages !== null && messages.length === 0 && <div style={{ padding: 8, opacity: 0.5, fontSize: 13 }}>{t("no_messages")}</div>}
            {messages !== null && messages.length > 0 && hasMore && (
              <ActionCard disabled={loadingOlder} onClick={loadOlder} center>
                {loadingOlder ? t("loading_older") : t("load_older")}
              </ActionCard>
            )}
            {messages?.map((m) => (
              <MessageRow
                key={m.id}
                m={m}
                channelId={channelId}
                isMine={!!myId && m.author_id === myId}
                onLocalUpdate={(patch) => setMessages((prev) => prev?.map((x) => x.id === m.id ? { ...x, ...patch } : x) ?? prev)}
                onLocalDelete={() => setMessages((prev) => prev?.filter((x) => x.id !== m.id) ?? prev)}
                onReply={() => setReplyTarget({ id: m.id, author: m.author })}
              />
            ))}
          </Focusable>
        </div>

        {!atBottom && (
          <div style={{ alignSelf: "center", marginTop: 6, marginBottom: 2 }}>
            <ActionCard onClick={jumpToLatest} center>
              <IcChevronDown /> {t("jump_to_latest")}
            </ActionCard>
          </div>
        )}

        {typingUser && (
          <div style={{ fontSize: 11, opacity: 0.7, fontStyle: "italic", marginTop: 6 }}>
            {t("typing_indicator", { name: typingUser })}
          </div>
        )}

        {replyTarget && (
          <div style={{
            display: "flex", alignItems: "center", gap: 6, marginTop: 8, padding: "4px 8px",
            borderRadius: 6, background: "rgba(255,255,255,0.06)", fontSize: 11,
          }}>
            <span style={{ flex: 1, opacity: 0.85, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              ↩ {t("replying_to", { name: replyTarget.author })}
            </span>
            <ChipBtn onClick={() => setReplyTarget(null)}>✕</ChipBtn>
          </div>
        )}

        <div style={{ marginTop: 8 }}>
          <TextField
            value={draft}
            placeholder={t("message_placeholder")}
            onChange={(e: any) => {
              const v = e?.target?.value ?? "";
              setDraft(v);
              draftByChannel[channelId] = v;
              if (v.trim()) notifyTypingThrottled(channelId);
            }}
            // Entrée = envoyer (standard de toute app de chat) : la validation
            // du clavier virtuel part le message DIRECTEMENT, sans avoir à
            // naviguer jusqu'au bouton Envoyer — c'est aussi la parade au bug
            // "j'envoie, la conv se ferme et le message n'est pas parti"
            // (webhelper_js : AUCUN appel send_message au moment du clic, la
            // modale s'était fermée avant que le bouton soit réellement activé).
            onKeyDown={(e: any) => {
              if (e?.key === "Enter" && !e?.shiftKey) {
                e.preventDefault?.();
                send();
              }
            }}
            style={{ fontSize: 13, width: "100%" }}
          />
          {/* Envoyer + capture d'écran sur la même rangée (retour user #20 :
              le gros bloc d'origine — titre/vignette/ligne cible — prenait
              trop de place pour ce qui est juste un bouton "envoyer une
              capture"). flow-children="row" (PAS "horizontal" — cf. le
              module Steam lui-même inspecté en direct au CDP : les seules
              valeurs acceptées sont row/row-reverse/column/column-reverse/
              grid/geometric ; "horizontal"/"vertical" déclenchaient
              "Unhandled flow-children" à CHAQUE render, un vrai plantage React
              récurrent qui empêchait même les nouveaux messages de s'afficher —
              bug très probablement présent partout ailleurs dans ce plugin
              (et les 3 autres) depuis une mise à jour du client Steam). */}
          <Focusable flow-children="row" style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <SendBtn disabled={sending || !draft.trim()} onClick={send}>
              {sending ? "…" : t("send")}
            </SendBtn>
            <ScreenshotPickerButton channelId={channelId} />
          </Focusable>
          {error && <div style={{ color: "#ff6b6b", fontSize: 11, marginTop: 4 }}>{error}</div>}
        </div>
      </div>
    </ModalRootAny>
  );
}
