import { Focusable, ModalRoot, NavEntryPositionPreferences, TextField } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { Btn, Message, MessageRow } from "./TextChat";
import { ScreenshotPickerButton } from "./ScreenshotPicker";
import { IcChevronDown } from "./Icons";
import { ActionCard, ACCENT, focusHalo } from "./Styled";

const ModalRootAny = ModalRoot as any;

// Bouton Envoyer de la rangée composer : `flex` posé DIRECTEMENT sur le Btn,
// PAS sur un <div> enveloppant (retour user #20 : le bouton n'était plus
// navigable à la manette). Même piège/recette que TabBtn (index.tsx) — un
// Focusable flow-children="horizontal" attend ses enfants focusables en
// contact direct, un wrapper intermédiaire casse la navigation de toute la
// rangée, pas seulement de l'enfant enveloppé.
function SendBtn({ disabled, onClick, children }: { disabled?: boolean; onClick: () => void; children: any }) {
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

// Plusieurs tentatives échelonnées : à l'ouverture de la modale (animation de
// transition) ou juste après le 1er chargement, la hauteur réelle du contenu
// (images pas encore décodées, layout pas encore stabilisé) peut ne pas être
// définitive au 1er essai — un seul scrollTop=scrollHeight à 50ms laissait
// parfois la vue pas tout à fait en bas (retour user #20).
const RETRY_DELAYS = [50, 150, 300, 600];
const scrollFsBottom = () => {
  for (const d of RETRY_DELAYS) {
    setTimeout(() => {
      const el = document.getElementById(FS_MSG_LIST_ID);
      if (el) el.scrollTop = el.scrollHeight;
    }, d);
  }
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
      if (el) el.scrollTop = el.scrollHeight;
    }, 50);
  }, 700);
};
const isFsNearBottom = () => {
  const el = document.getElementById(FS_MSG_LIST_ID);
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
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
export function ChatFullscreenModal({ channelId, channelName, isDm, closeModal }:
  { channelId: string; channelName: string; isDm: boolean; closeModal?: () => void }) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setFocusedInitial] = useState(false);

  // `force` = 1er chargement (ou juste après un envoi) : remplace tout et
  // recolle en bas inconditionnellement. Sans `force` (poll 5s), fusionne avec
  // l'historique déjà remonté via loadOlder et ne recolle que si on y était déjà.
  const loadMessages = (force = false) => {
    call<[string], any>("get_messages", channelId)
      .then((res) => {
        const fresh: Message[] = Array.isArray(res) ? res : [];
        const stick = force || isFsNearBottom();
        setMessages((prev) => {
          if (!prev || fresh.length === 0) return fresh;
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
    const iv = setInterval(() => loadMessages(false), 5000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // Remonte un lot plus ancien et le préfixe à la liste, en compensant le
  // scroll pour ne pas faire sauter la vue (même recette que l'ancien panneau).
  const loadOlder = () => {
    if (!messages || messages.length === 0 || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    const oldestId = messages[0].id;
    const el = document.getElementById(FS_MSG_LIST_ID);
    const prevScrollHeight = el?.scrollHeight ?? 0;
    call<[string, string], any>("get_messages", channelId, oldestId)
      .then((res) => {
        const older: Message[] = Array.isArray(res) ? res : [];
        setHasMore(older.length >= PAGE_SIZE);
        if (older.length > 0) {
          setMessages((prev) => [...older, ...(prev || [])]);
          setTimeout(() => {
            const el2 = document.getElementById(FS_MSG_LIST_ID);
            if (el2) el2.scrollTop += el2.scrollHeight - prevScrollHeight;
          }, 50);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingOlder(false));
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await call("send_message", channelId, text);
      setDraft("");
      loadMessages(true);
    } catch (e) { setError(String(e)); }
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

        <div
          id={FS_MSG_LIST_ID}
          style={{ flex: 1, overflowY: "auto", paddingRight: 4 }}
          onScroll={() => setAtBottom(isFsNearBottom())}
        >
          {messages === null && <div style={{ padding: 8, opacity: 0.6, fontSize: 13 }}>{t("loading_messages")}</div>}
          {messages !== null && messages.length === 0 && <div style={{ padding: 8, opacity: 0.5, fontSize: 13 }}>{t("no_messages")}</div>}
          {messages !== null && messages.length > 0 && hasMore && (
            <div style={{ marginBottom: 8 }}>
              <ActionCard disabled={loadingOlder} onClick={loadOlder} center>
                {loadingOlder ? t("loading_older") : t("load_older")}
              </ActionCard>
            </div>
          )}
          {/* flow-children="vertical" indispensable : cf. le même commentaire
              dans TextChat.tsx (MessageRow) — sans lui, un message plat sans
              lien/image n'est pas reconnu comme arrêt de nav manette.
              navEntryPreferPosition=LAST (retour user #20, "les plus anciens
              en premier, contre-productif") : Steam pose sinon le focus sur
              le PREMIER enfant à chaque entrée dans ce conteneur (comportement
              par défaut de FooterLegend, cf. commentaire de la lib) — ce qui
              re-scrollait la vue vers le HAUT à chaque fois (au montage, ET à
              chaque poll qui change la liste), en concurrence avec nos
              tentatives manuelles de scroll/focus vers le bas. Mécanisme
              déclaratif natif au lieu de rejouer une course avec lui. */}
          <Focusable id={FS_MSG_FLOW_ID} flow-children="vertical" navEntryPreferPosition={NavEntryPositionPreferences.LAST}>
            {messages?.map((m) => <MessageRow key={m.id} m={m} />)}
          </Focusable>
        </div>

        {!atBottom && (
          <div style={{ alignSelf: "center", marginTop: 6, marginBottom: 2 }}>
            <ActionCard onClick={jumpToLatest} center>
              <IcChevronDown /> {t("jump_to_latest")}
            </ActionCard>
          </div>
        )}

        <div style={{ marginTop: 8 }}>
          <TextField
            value={draft}
            placeholder={t("message_placeholder")}
            onChange={(e: any) => setDraft(e?.target?.value ?? "")}
            style={{ fontSize: 13, width: "100%" }}
          />
          {/* Envoyer + capture d'écran sur la même rangée (retour user #20 :
              le gros bloc d'origine — titre/vignette/ligne cible — prenait
              trop de place pour ce qui est juste un bouton "envoyer une
              capture"). flow-children="horizontal" pour une nav D-pad
              gauche/droite correcte entre les deux, même recette que
              partout ailleurs dans ce fichier/VoiceChatViews. */}
          <Focusable flow-children="horizontal" style={{ display: "flex", gap: 6, marginTop: 4 }}>
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
