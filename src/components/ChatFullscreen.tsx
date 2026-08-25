import { Focusable, ModalRoot, NavEntryPositionPreferences, TextField } from "@decky/ui";
import { addEventListener, call, removeEventListener } from "@decky/api";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { errText, t } from "../i18n";
import { Btn, ChipBtn, Message, MessageRow, draftByChannel, failReason, notifyTypingThrottled, isInteractingWithMessage, lastMessageInteractionAt, onMessageFocus, qamWatchedChannel } from "./TextChat";
import { ScreenshotPickerButton } from "./ScreenshotPicker";
import { ClipPickerButton } from "./ClipPicker";
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
// Pas de bouton « revenir aux derniers messages » : la sortie du gel, c'est le
// COMPOSER (retour user 26/07). Descendre sur la zone de saisie = « j'ai fini de
// lire l'historique » → on dégèle et on recolle en bas, exactement le geste qu'il
// faisait déjà avant le fix #21. Un bouton dédié en barre du bas était à la fois
// clignotant (deux états recalculés à chaque event de scroll) et inatteignable
// sans traverser toute la liste, et le raccourci manette qui devait le remplacer
// a cassé la navigation (cf. plus bas).
const FS_MSG_LIST_ID = "steamcord-msglist-fs";
const FS_MSG_FLOW_ID = "steamcord-msgflow-fs";
const FS_COMPOSER_ID = "steamcord-composer-fs";
const FS_ROOT_ID = "steamcord-root-fs";
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
// ⚠️ Ces helpers reçoivent le NŒUD en paramètre, ils ne le cherchent plus par
// `document.getElementById`. Mesuré au CDP le 26/07 (`el.ownerDocument === document`
// → **false**) : la modale est rendue dans le document de la fenêtre Big Picture
// alors que le code du plugin tourne dans un autre contexte — ces recherches
// renvoyaient donc `null` EN SILENCE, et tout le gel de vue de #21 (ancre,
// repin, recollage bas) n'a jamais pu s'exécuter une seule fois.
// Les nœuds viennent des refs de callback posées sur les <div> bruts du JSX.
const scrollFsBottom = (list: HTMLElement | null) => {
  setTimeout(() => {
    if (list) list.scrollTop = 0;
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
const focusLastMessage = (list: HTMLElement | null) => {
  setTimeout(() => {
    // Le Focusable de la liste ne transmet pas de ref : on le récupère depuis le
    // scroller, ce qui interroge le BON document par construction.
    list?.querySelector<HTMLElement>(`#${FS_MSG_FLOW_ID}`)?.focus?.();
    setTimeout(() => {
      if (list) list.scrollTop = 0;
    }, 50);
  }, 700);
};
// En column-reverse, scrollTop vaut 0 en bas et devient NÉGATIF en remontant
// dans l'historique (sémantique Chromium standard pour ce mode).
const isFsNearBottom = (list: HTMLElement | null) => !list || -list.scrollTop < NEAR_BOTTOM_PX;

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
  const [draft, setDraft] = useState(draftByChannel[channelId] || "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setFocusedInitial] = useState(false);
  const [typingUser, setTypingUser] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<{ id: string; author: string } | null>(null);

  // Suit-on encore le flux ? Faux dès que l'utilisateur SÉLECTIONNE un message
  // qui n'est pas le dernier — la vue se fige alors sur ce qu'il regarde
  // jusqu'à ce qu'il redescende ou utilise "revenir aux derniers messages"
  // (David #21). En lecture passive, aucune prise de focus ne survient : le
  // drapeau reste vrai et le chat continue de défiler comme avant.
  const liveEdgeRef = useRef(true);
  // Miroir des messages pour les callbacks non-React (focus, events) : leur
  // closure capturerait sinon le tableau du rendu où elle a été créée.
  const messagesRef = useRef<Message[] | null>(null);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // ── Gel de la vue (David #21, le bug tenace) ───────────────────────────────
  // NE PAS recoller en bas ne fige RIEN. Le scroller est en column-reverse et
  // reste collé à scrollTop=0 (le bas) : dans ce mode, un message inséré pousse
  // nativement tout le contenu déjà affiché vers le HAUT. S'abstenir d'appeler
  // scrollFsBottom() ne changeait donc strictement rien tant que l'utilisateur
  // était près du bas — c'est-à-dire précisément dans le cas de David, qui
  // sélectionne un message VISIBLE. Ça n'a "parfois marché" que quand il était
  // déjà remonté loin dans l'historique, le seul cas où l'absence de recollage
  // suffit. Figer demande donc un geste ACTIF : compenser la hauteur insérée.
  //
  // On s'ancre sur l'élément réellement focusé (une puce du message sélectionné)
  // plutôt que sur une hauteur mesurée : c'est littéralement ce que l'utilisateur
  // regarde, et ça reste juste même quand une image finit de se décoder après
  // coup et change la hauteur du nouveau message (d'où les repasses différées).
  // Nœuds DOM gardés tels quels (voir le bloc « deux pièges cumulés » plus bas) :
  // déclarés AVANT holdAnchor/repinAnchor qui s'en servent, pour ne pas laisser
  // de zone morte temporelle si un jour ils sont appelés pendant le rendu.
  const composerElRef = useRef<HTMLDivElement | null>(null);
  const listElRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<{ el: HTMLElement; top: number } | null>(null);
  const repinTimersRef = useRef<any[]>([]);
  // Dernier scrollTop écrit par NOUS : permet à onScroll de distinguer nos
  // propres corrections d'un vrai scroll de l'utilisateur (qui, lui, doit
  // annuler l'ancrage — sinon on lutterait contre son stick).
  const selfScrollTopRef = useRef<number | null>(null);
  // Dernière mutation de la liste (arrivée, édition, réaction optimiste…).
  const lastMutationAtRef = useRef(0);
  useEffect(() => { lastMutationAtRef.current = Date.now(); }, [messages]);

  const dropAnchor = () => {
    repinTimersRef.current.forEach(clearTimeout);
    repinTimersRef.current = [];
    anchorRef.current = null;
  };

  // Mémorise ce que l'utilisateur regarde, JUSTE AVANT l'insertion.
  const holdAnchor = () => {
    const list = listElRef.current;
    // `document.activeElement` viserait le document du plugin, pas celui de la
    // modale : on passe par ownerDocument du nœud qu'on tient réellement.
    const active = (list?.ownerDocument?.activeElement ?? null) as HTMLElement | null;
    if (!list || !active || !list.contains(active)) { dropAnchor(); return; }
    dropAnchor();
    anchorRef.current = { el: active, top: active.getBoundingClientRect().top };
  };

  // Remet l'ancre exactement là où elle était. En column-reverse, scrollTop
  // baisse (devient plus négatif) quand on remonte dans l'historique, ce qui
  // fait redescendre le contenu à l'écran : l'ancre ayant été poussée vers le
  // haut de `delta` (négatif), `scrollTop += delta` la remet à sa place.
  const repinAnchor = () => {
    const list = listElRef.current;
    const a = anchorRef.current;
    if (!list || !a || !a.el.isConnected) return;
    const delta = a.el.getBoundingClientRect().top - a.top;
    if (!delta) return;
    list.scrollTop += delta;
    selfScrollTopRef.current = list.scrollTop;
  };

  // Une seule passe ne suffit pas : les images du message qui vient d'arriver
  // se décodent après le layout et repoussent encore le contenu. Quelques
  // repasses courtes rattrapent ça ; toute action de l'utilisateur les annule.
  // useLayoutEffect et pas useEffect : la correction doit partir AVANT le
  // rendu à l'écran, sinon la vue saute d'une image puis revient.
  useLayoutEffect(() => {
    if (!anchorRef.current) return;
    repinAnchor();
    repinTimersRef.current = [120, 350, 900].map((ms) => setTimeout(repinAnchor, ms));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  useEffect(() => () => dropAnchor(), []);

  useEffect(() => onMessageFocus((id) => {
    const list = messagesRef.current;
    const atEdge = !list || !list.length || id === list[list.length - 1].id;
    // Un focus qui atterrit sur le DERNIER message dans la foulée d'une mutation
    // de la liste n'est PAS un déplacement de l'utilisateur : c'est Steam qui
    // ré-entre dans le conteneur par navEntryPreferPosition=LAST après que
    // l'élément focusé s'est démonté sous lui — typiquement le sélecteur
    // d'emoji qui se referme quand on réagit, ou une puce Modifier/Supprimer.
    // Le prendre pour un vrai déplacement ré-armait le suivi du direct et la
    // vue repartait de plus belle (David #21 : "même en réagissant"). On ignore
    // donc ce seul sens (ré-armement) ; se figer à tort resterait visible et
    // rattrapable d'un bouton, alors qu'un arrachement de vue, non.
    const churn = Math.max(lastMutationAtRef.current, lastMessageInteractionAt());
    if (atEdge && Date.now() - churn < 400) return;
    liveEdgeRef.current = atEdge;
    dropAnchor(); // vrai déplacement : on se réancrera sur la prochaine insertion
  }), []);

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
        // Le poll de réconciliation obéit aux mêmes gardes que l'arrivée d'un
        // message en direct — sinon il suffisait d'attendre 20s pour que la vue
        // soit arrachée sous un message sélectionné ou en cours d'édition.
        if (force) liveEdgeRef.current = true;
        const stick = force
          || (isFsNearBottom(listElRef.current) && liveEdgeRef.current && !isInteractingWithMessage());
        // Le poll peut rapatrier plusieurs messages d'un coup : si on est figé,
        // on ancre la vue avant l'insertion comme pour une arrivée en direct.
        if (!stick) holdAnchor();
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
        if (stick) scrollFsBottom(listElRef.current);
        if (force && fresh.length > 0) {
          setFocusedInitial((already) => { if (!already) focusLastMessage(listElRef.current); return true; });
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
    const iv = setInterval(() => {
      // Re-revendique le salon suivi à chaque tour : le direct repose sur une
      // variable qui vit dans l'onglet Vesktop, et elle repart à zéro dès qu'il
      // redémarre. La réaffirmer périodiquement fait repartir le direct tout
      // seul au lieu de laisser la conversation sur le seul poll (David #21).
      call("watch_channel", channelId).catch(() => {});
      loadMessages(false);
    }, 20000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // Le direct de CE salon appartient à la modale tant qu'elle est ouverte : le
  // QAM en pose un lui aussi, mais il se démonte derrière la modale et
  // relâchait alors le suivi (voir `qamWatchedChannel` dans TextChat). À la
  // fermeture, on rend la main au salon que le QAM avait ouvert, s'il y en a un.
  useEffect(() => {
    call("watch_channel", channelId).catch(() => {});
    return () => { call("watch_channel", qamWatchedChannel() || "").catch(() => {}); };
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

  // Notifications : tant que CE salon est ouvert en plein écran, le backend ne
  // doit PAS émettre de notif de MESSAGE pour lui (retour David #21 — inutile
  // d'être notifié d'un salon qu'on est en train de lire). Les notifs
  // d'appel/stream/caméra ne sont PAS concernées (filtrage par `kind` côté
  // backend). Rétabli au démontage de la modale.
  useEffect(() => {
    call("set_fullscreen_channel", channelId).catch(() => {});
    return () => { call("set_fullscreen_channel", "").catch(() => {}); };
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
        const wasNearBottom = isFsNearBottom(listElRef.current);
        const stick = wasNearBottom && !isInteractingWithMessage() && liveEdgeRef.current;
        // ⚠️ AVANT le setMessages : l'ancre doit être mesurée sur la vue telle
        // qu'elle est encore, sans le nouveau message.
        if (!stick) holdAnchor();
        setMessages((prev) => {
          if (!prev) return [data.message];
          if (prev.some((m) => m.id === data.message.id)) return prev;
          return [...prev, data.message];
        });
        // Re-colle explicitement en bas si on y était (mesuré au CDP : même
        // en column-reverse, scrollTop dérivait de quelques px sous les
        // insertions → le nouveau message finissait coupé par le bord bas).
        // Plus haut dans l'historique : on n'y touche pas, redescendre sur le
        // composer est là pour ça.
        // …sauf si on est en train d'agir sur un message précis (react/edit/
        // suppression) ou si l'utilisateur en a simplement SÉLECTIONNÉ un plus
        // haut : on gèle la vue pour ne pas l'arracher (David #21).
        if (stick) scrollFsBottom(listElRef.current);
      } else if (data.op === "update" && data.message) {
        setMessages((prev) => prev?.map((m) => m.id === data.message.id ? { ...m, ...data.message } : m) ?? prev);
      } else if (data.op === "delete" && data.message_id) {
        setMessages((prev) => prev?.filter((m) => m.id !== data.message_id) ?? prev);
      } else if ((data.op === "reaction_add" || data.op === "reaction_remove") && data.message_id && data.emoji) {
        const isAdd = data.op === "reaction_add";
        setMessages((prev) => prev?.map((m) => {
          if (m.id !== data.message_id) return m;
          const reactions = [...(m.reactions || [])];
          const i = reactions.findIndex((r) => r.emoji === data.emoji);
          const cur = i >= 0 ? reactions[i] : undefined;
          // Écho de MA propre réaction (data.me) : l'update optimiste de
          // MessageRow a déjà appliqué le +1/-1 et positionné `me`. Si l'état
          // local reflète déjà l'action (me=true après un add, me=false après
          // un remove), on NE recompte PAS — sinon la réaction affiche +1
          // fantôme jusqu'au prochain refresh (retour David #21). Une réaction
          // faite depuis un AUTRE appareil arrive avec me:true alors que l'état
          // local ne l'a pas encore (cur.me=false) → là on applique bien.
          if (data.me && cur && cur.me === isAdd) return m;
          const delta = isAdd ? 1 : -1;
          if (i >= 0) {
            const next = {
              ...reactions[i],
              count: reactions[i].count + delta,
              me: data.me ? isAdd : reactions[i].me,
            };
            if (next.count <= 0) reactions.splice(i, 1); else reactions[i] = next;
          } else if (isAdd) {
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
      const res = await call("send_message", channelId, text, replyTarget?.id);
      // Refus explicite : le brouillon et la cible de réponse sont CONSERVÉS,
      // sinon le message s'évanouirait en donnant l'illusion d'un envoi.
      const bad = failReason(res);
      if (bad) {
        console.error("[Steamcord] fullscreen chat send refused:", bad);
        setError(errText(bad));
      } else {
        setDraft("");
        delete draftByChannel[channelId];
        setReplyTarget(null);
        loadMessages(true);
      }
    } catch (e) {
      console.error("[Steamcord] fullscreen chat send FAILED", e);
      setError(errText(e));
    }
    setSending(false);
  };

  // Reprend le flux : c'est LA sortie de la sélection figée. Déclenché en
  // descendant sur la zone de saisie (voir son onFocus), pas par un bouton.
  //
  // ⚠️ NE PAS rebrancher ça sur un raccourci manette via `onSecondaryButton` /
  // `onSecondaryActionDescription` posés sur le Focusable de la LISTE : essayé
  // le 26/07, ça rend le conteneur focusable LUI-MÊME et ça casse tout le
  // parcours de navigation (impossible de descendre de la liste des MP vers la
  // saisie, liste de messages inerte — le user a vu « les messages ne chargent
  // pas »). Vérifié au CDP : aucune erreur JS, aucun plantage React, le rendu
  // est intact — c'est purement le focus qui est détourné. Même famille de
  // piège que le `flow-children` non supporté documenté plus bas.
  const jumpToLatest = () => { dropAnchor(); liveEdgeRef.current = true; scrollFsBottom(listElRef.current); };

  // Le raccourci ne fait PAS un scroll à part : il ramène la SÉLECTION sur la
  // zone de saisie, exactement le geste que le user faisait à la main. Comme le
  // composer dégèle et recolle en bas via son onFocus, la vue redescend toute
  // seule — un seul comportement à maintenir au lieu de deux.
  // Même technique de focus programmatique que focusLastMessage() plus haut.
  const focusComposer = () => {
    // Nœud mémorisé par la ref en priorité — voir le commentaire sur composerElRef.
    const box = composerElRef.current;
    const input = box?.querySelector("input, textarea") as HTMLElement | null;
    // Le conteneur de messages garde en mémoire le dernier enfant qu'on y a
    // sélectionné et le restaure quand on y revient — ça l'emporte sur
    // navEntryPreferPosition=LAST. Sans ça, après le raccourci, remonter d'un
    // cran ramenait exactement là où on lisait AVANT (retour user 26/07), au
    // lieu de repartir du message le plus récent. On réécrit donc cette mémoire
    // en focalisant le dernier message, puis on pose la sélection sur la saisie
    // au tick suivant (ordre vérifié au CDP : le focus final reste bien l'input).
    const flow = listElRef.current?.querySelector<HTMLElement>(`#${FS_MSG_FLOW_ID}`);
    const stops = flow?.querySelectorAll<HTMLElement>("button, [tabindex]");
    if (stops && stops.length) stops[stops.length - 1]?.focus?.();
    // Vérifié au CDP : un .focus() natif sur cet input lui donne bien la classe
    // `gpfocus` (le vrai anneau de sélection Steam) et n'ouvre PAS le clavier
    // virtuel. Le composer dégèle ensuite la vue via son onFocus.
    setTimeout(() => (input || box)?.focus?.(), 0);
    dropAnchor();
    liveEdgeRef.current = true;
    const list = listElRef.current;
    setTimeout(() => { if (list) list.scrollTop = 0; }, 50);
  };

  // Le raccourci manette est câblé À LA MAIN, sur des <div> bruts du JSX (leur
  // ref de callback est toujours transmise), en écoutant l'événement DOM que
  // Steam émet — pas via une prop `onSecondaryButton`, pas via `document`.
  //
  // Pourquoi (tout mesuré au CDP le 26/07, ne pas « simplifier » ça) :
  // • `ModalRoot` n'implémente pas du tout ces props, il les étale sur son
  //   <form> où elles sont inertes ;
  // • sur le `Focusable` de la LISTE, elles marchent mais rendent le conteneur
  //   focusable et détruisent la navigation ;
  // • sur cette enveloppe, Steam enregistre bien un écouteur `vgp_onsecondaryaction`
  //   (vu via DOMDebugger.getEventListeners) et l'événement lui parvient bien
  //   (bubbles: true, capté par un écouteur brut) — mais son handler interne
  //   REFUSE d'agir tant que l'élément n'a pas lui-même le focus. Résultat :
  //   glyphe affiché en pied d'écran, action morte.
  // On garde donc `onSecondaryActionDescription` (qui, elle, affiche bien le
  // glyphe) et on prend l'action en charge nous-mêmes. Y = vgp_onsecondaryaction,
  // X = vgp_onoptions ; les deux mènent au même endroit.
  // ⚠️ Deux pièges cumulés, tous deux mesurés au CDP le 26/07 :
  // ① une ref React sur un `Focusable` de @decky/ui n'est PAS transmise au nœud
  //    DOM (`ref.current` reste null) → on ne peut s'accrocher qu'à des <div>
  //    bruts du JSX, dont la ref de callback, elle, arrive toujours ;
  // ② `document` n'est pas celui de la modale (rendue dans la fenêtre Big
  //    Picture, alors que le code du plugin tourne ailleurs) → tout
  //    `document.getElementById` renvoie null EN SILENCE.
  // D'où : on GARDE les nœuds que React nous donne, et on ne cherche plus rien.
  // Piège de diagnostic associé : Steam enregistre de lui-même des écouteurs
  // vgp_* du seul fait de `onSecondaryActionDescription`, donc voir les bons
  // écouteurs au CDP ne prouve PAS que le câblage est le nôtre.

  const wire = (el: HTMLDivElement | null) => {
    if (!el || (el as any).__scShortcut) return;
    (el as any).__scShortcut = true;
    const onShortcut = () => focusComposer();
    el.addEventListener("vgp_onsecondaryaction", onShortcut); // Y
    el.addEventListener("vgp_onoptions", onShortcut);         // X
  };
  const attachShortcutList = (el: HTMLDivElement | null) => { listElRef.current = el; wire(el); };
  const attachShortcutComposer = (el: HTMLDivElement | null) => { composerElRef.current = el; wire(el); };

  return (
    <ModalRootAny
      closeModal={closeModal}
      onCancel={() => closeModal?.()}
      onCancelActionDescription={t("video_exit_fullscreen")}
      bAllowFullSize
    >
      {/* Enveloppe Focusable = l'accroche du raccourci manette. Mesuré au CDP
          le 26/07 : ModalRoot n'implémente PAS les props de FooterLegendProps,
          il se contente de les étaler sur le <form> qu'il rend — une prop
          inconnue sur un élément DOM est inerte pour React, donc ni glyphe en
          pied d'écran ni action (`onCancelActionDescription` juste au-dessus
          est décoratif pour la même raison). Seul un vrai `Focusable` de
          @decky/ui les câble.
          ⚠️ Position IMPORTANTE : ici, en ENVELOPPE du contenu. Les avoir mises
          sur le Focusable de la LISTE elle-même a cassé toute la navigation le
          même jour (liste inerte, impossible de descendre vers la saisie). */}
      <Focusable
        id={FS_ROOT_ID}
        flow-children="column"
        noFocusRing
        // Gardée UNIQUEMENT pour le glyphe en pied d'écran : Steam affiche bien
        // ce libellé, mais ne déclenche jamais le handler associé ici (voir le
        // long commentaire sur rootRef plus haut). L'action passe par l'écouteur
        // DOM, pas par une prop `on*Button`.
        onSecondaryActionDescription={t("jump_to_latest")}
        style={{ display: "flex", flexDirection: "column", height: "78vh", maxWidth: 720, margin: "0 auto", width: "100%" }}
      >
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
          ref={attachShortcutList}
          style={{ flex: 1, overflowY: "auto", paddingRight: 4, display: "flex", flexDirection: "column-reverse", overflowAnchor: "none" }}
          onScroll={(e: any) => {
            // Un scroll qui n'est PAS le nôtre (stick manette, gâchette) veut
            // dire que l'utilisateur reprend la main : l'ancre posée sur ce
            // qu'il regardait n'a plus lieu d'être, sinon les repasses
            // différées la ramèneraient en arrière sous ses doigts.
            const top = e?.currentTarget?.scrollTop;
            if (top !== selfScrollTopRef.current) dropAnchor();
          }}
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

        <div id={FS_COMPOSER_ID} ref={attachShortcutComposer} style={{ marginTop: 8 }}>
          <TextField
            value={draft}
            placeholder={t("message_placeholder")}
            // Descendre sur la saisie = « j'ai fini de lire l'historique » :
            // on dégèle et on recolle en bas. C'est le geste que le user faisait
            // DÉJÀ avant le fix #21 pour se remettre au dernier message avant de
            // remonter au stick, et c'est ce qui remplace le bouton « revenir aux
            // derniers messages » (retour 26/07 : il le voulait supprimé). Les
            // `onFocus` suffit : mesuré au CDP, la navigation manette pose un
            // VRAI focus DOM sur l'input (activeElement = INPUT, classe
            // `gpfocus`). `onGamepadFocus` n'est pas dans TextFieldProps et
            // faisait sortir TypeScript en erreur pour rien.
            onFocus={jumpToLatest}
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
            <ClipPickerButton channelId={channelId} />
          </Focusable>
          {error && <div style={{ color: "#ff6b6b", fontSize: 11, marginTop: 4 }}>{error}</div>}
        </div>
      </Focusable>
    </ModalRootAny>
  );
}
