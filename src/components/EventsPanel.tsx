// Événements programmés d'un serveur : les voir et s'y joindre depuis le QAM.
//
// Délibérément réduit à ça. Pas de création, pas de modification : recréer
// l'éditeur d'événements de Discord dans un panneau de 340 px n'apporterait
// rien, alors que « qu'est-ce qui commence bientôt, et comment j'y vais » est
// exactement ce qu'on ne peut pas faire manette en main aujourd'hui.
//
// Le panneau ne s'affiche QUE s'il y a quelque chose à montrer : sans
// événement, il ne prend pas une ligne.
import { Focusable, ModalRoot, showModal } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { ACCENT, focusHalo } from "./Styled";
import { useQamUi } from "../qamUi";
import { IcChevronDown, IcChevronUp, IcUser } from "./Icons";

type SCEvent = {
  id: string; guild_id: string; guild: string; name: string; description: string;
  start: string | null; status: number; channel_id: string | null;
  location: string; count: number; image?: string | null; end?: string | null;
};

type EventUser = { id: string; name: string; avatar: string | null };

const ModalRootAny = ModalRoot as any;

// Une seule ligne, coupée proprement : un nom d'événement ou un lieu peut être
// long, et il ne doit JAMAIS pousser la mise en page du QAM (demande user).
const ONE_LINE = {
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
  minWidth: 0,
};

const ACTIVE = 2;

// « aujourd'hui 21:00 » / « sam. 14:30 » : dans le QAM on veut savoir quand,
// pas lire une date ISO. La locale vient du navigateur Steam.
function whenLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `${t("event_today")} ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

// Fiche d'un événement : bannière, description, qui participe, et le geste
// pour s'y joindre — l'équivalent de ce que Discord montre en ouvrant un
// événement. Le panneau du QAM reste une LISTE : tout ce qui est long (la
// description, la liste des participants) vit ici, où il y a la place.
function EventDetail({ ev, closeModal }: { ev: SCEvent; closeModal?: () => void }) {
  const [users, setUsers] = useState<EventUser[] | null>(null);
  const [interested, setInterested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const live = ev.status === ACTIVE;

  useEffect(() => {
    let alive = true;
    call<[string, string], EventUser[]>("get_event_users", ev.guild_id, ev.id)
      .then((r) => { if (alive) setUsers(Array.isArray(r) ? r : []); })
      .catch(() => { if (alive) setUsers([]); });
    return () => { alive = false; };
  }, [ev.guild_id, ev.id]);

  const act = async (fn: () => Promise<any>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } catch (_) { /* l'état inchangé fait office de message */ }
    setBusy(false);
  };

  const btn = (key: string, label: string, onClick: () => void) => (
    <Focusable
      onActivate={onClick} onClick={onClick}
      onFocus={() => setFocused(key)} onBlur={() => setFocused((f) => (f === key ? null : f))}
      onGamepadFocus={() => setFocused(key)} onGamepadBlur={() => setFocused((f) => (f === key ? null : f))}
      style={{
        padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, color: "#fff",
        opacity: busy ? 0.5 : 1,
        background: focused === key ? "rgba(88,101,242,0.85)" : "rgba(88,101,242,0.32)",
        ...focusHalo(ACCENT, focused === key),
      }}
    >
      {label}
    </Focusable>
  );

  return (
    <ModalRootAny closeModal={closeModal} onCancel={() => closeModal?.()}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        {ev.image ? (
          <img
            src={`https://cdn.discordapp.com/guild-events/${ev.id}/${ev.image}.png?size=512`}
            alt=""
            style={{ width: "100%", maxHeight: "28vh", objectFit: "cover", borderRadius: 8, display: "block" }}
          />
        ) : null}
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          {live && <span style={{ fontSize: 11, fontWeight: 700, color: "#ed4245" }}>● {t("event_live")}</span>}
          <span style={{ fontSize: 17, fontWeight: 700, flex: 1, minWidth: 0 }}>{ev.name}</span>
        </div>
        <div style={{ fontSize: 12, opacity: 0.65 }}>
          {[ev.guild, whenLabel(ev.start), ev.location].filter(Boolean).join(" · ")}
        </div>
        {ev.description ? (
          // Seul endroit où la description est lisible en entier : dans la liste
          // elle n'apparaît pas du tout, pour ne pas faire déborder le menu.
          <div style={{ fontSize: 12, lineHeight: 1.45, opacity: 0.9, whiteSpace: "pre-wrap",
                        maxHeight: "22vh", overflowY: "auto" }}>
            {ev.description}
          </div>
        ) : null}
        <div style={{ fontSize: 12, fontWeight: 600, marginTop: 2 }}>
          <IcUser /> {t("event_participants")}{users ? ` · ${users.length}` : ""}
        </div>
        <div style={{ maxHeight: "24vh", overflowY: "auto" }}>
          {users === null ? (
            <div style={{ fontSize: 12, opacity: 0.6 }}>{t("forward_loading")}</div>
          ) : users.length === 0 ? (
            <div style={{ fontSize: 12, opacity: 0.6 }}>{t("event_no_participant")}</div>
          ) : users.map((u) => (
            <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
              <img
                src={u.avatar
                  ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.webp?size=64`
                  : "https://cdn.discordapp.com/embed/avatars/0.png"}
                width={24} height={24}
                style={{ width: 24, height: 24, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
              />
              <span style={{ fontSize: 12, flex: 1, ...ONE_LINE }}>{u.name}</span>
            </div>
          ))}
        </div>
        <Focusable flow-children="row" style={{ display: "flex", gap: 6, marginTop: 4 }}>
          {live && ev.channel_id
            ? btn("join", t("event_join"), () => act(() => call("join_vc", ev.channel_id, ev.guild_id)))
            : null}
          {btn("rsvp", interested ? t("event_not_interested") : t("event_interested"), () => act(async () => {
            await call("set_event_interest", ev.guild_id, ev.id, !interested);
            setInterested((v) => !v);
          }))}
          {btn("close", t("forward_close"), () => closeModal?.())}
        </Focusable>
      </div>
    </ModalRootAny>
  );
}

// Ligne de la liste : STRICTEMENT une ligne. On l'active pour ouvrir la fiche,
// où vivent la bannière, la description et les participants. Rien ici ne peut
// faire déborder le menu — tout ce qui est long est coupé par ONE_LINE.
function EventRow({ ev }: { ev: SCEvent }) {
  const { px } = useQamUi();
  const [focused, setFocused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = ev.status === ACTIVE;
  const meta = [ev.guild, live ? "" : whenLabel(ev.start), ev.location,
                ev.count ? `${ev.count} ${t("event_interested_count")}` : ""]
    .filter(Boolean).join(" · ");

  const open = () => showModal(<EventDetail ev={ev} />);
  const join = async () => {
    if (busy) return;
    setBusy(true);
    try { await call("join_vc", ev.channel_id, ev.guild_id); } catch (_) { /* rien à dire de plus */ }
    setBusy(false);
  };

  const focusable = (key: string, onClick: () => void, style: any, children: any) => (
    <Focusable
      onActivate={onClick} onClick={onClick}
      onFocus={() => setFocused(key)} onBlur={() => setFocused((f) => (f === key ? null : f))}
      onGamepadFocus={() => setFocused(key)} onGamepadBlur={() => setFocused((f) => (f === key ? null : f))}
      style={{ ...style, ...focusHalo(ACCENT, focused === key, 1.0) }}
    >
      {children}
    </Focusable>
  );

  return (
    <Focusable flow-children="row" style={{ display: "flex", gap: px(4), marginBottom: px(3), minWidth: 0 }}>
      {focusable("open", open, {
        flex: 1, minWidth: 0, padding: `${px(5)}px ${px(7)}px`, borderRadius: px(8),
        background: focused === "open" ? "rgba(88,101,242,0.28)" : "rgba(255,255,255,0.04)",
      }, (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: px(5), minWidth: 0 }}>
            {live && (
              <span style={{ fontSize: px(9), fontWeight: 700, color: "#ed4245", flexShrink: 0 }}>
                ● {t("event_live")}
              </span>
            )}
            <span style={{ flex: 1, fontSize: px(12), fontWeight: 600, ...ONE_LINE }}>{ev.name}</span>
          </div>
          {meta ? (
            <div style={{ fontSize: px(10), opacity: 0.6, marginTop: px(1), ...ONE_LINE }}>{meta}</div>
          ) : null}
        </>
      ))}
      {/* Raccourci : un événement EN COURS se rejoint sans passer par la fiche. */}
      {live && ev.channel_id ? focusable("join", join, {
        flexShrink: 0, alignSelf: "stretch", display: "flex", alignItems: "center",
        padding: `0 ${px(9)}px`, borderRadius: px(8), fontSize: px(11), fontWeight: 700,
        color: "#fff", opacity: busy ? 0.5 : 1,
        background: focused === "join" ? "rgba(88,101,242,0.85)" : "rgba(88,101,242,0.32)",
      }, t("event_join")) : null}
    </Focusable>
  );
}

export function EventsPanel() {
  const { px } = useQamUi();
  const [events, setEvents] = useState<SCEvent[] | null>(null);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);

  const load = () => {
    call<[], SCEvent[]>("get_events")
      .then((r) => setEvents(Array.isArray(r) ? r : []))
      .catch(() => setEvents([]));
  };
  useEffect(load, []);

  // Rien à montrer → on ne prend pas de place. Une section vide qui annonce
  // « aucun événement » est du bruit permanent pour une information rare.
  if (!events || events.length === 0) return null;

  const live = events.filter((e) => e.status === ACTIVE).length;
  return (
    <div style={{ marginBottom: 6 }}>
      <Focusable
        onActivate={() => setOpen((v) => !v)}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onGamepadFocus={() => setFocused(true)}
        onGamepadBlur={() => setFocused(false)}
        style={{
          display: "flex", alignItems: "center", gap: 6, padding: `${px(4)}px ${px(6)}px`,
          borderRadius: 6, fontSize: px(12), fontWeight: 600,
          background: focused ? "rgba(88,101,242,0.22)" : "rgba(255,255,255,0.04)",
          ...focusHalo(ACCENT, focused, 1.0),
        }}
      >
        <span style={{ flex: 1 }}>
          {t("events")} · {events.length}
          {live ? <span style={{ color: "#ed4245" }}> · {live} {t("event_live")}</span> : null}
        </span>
        {open ? <IcChevronUp /> : <IcChevronDown />}
      </Focusable>
      {open && (
        <div style={{ marginTop: 4 }}>
          {events.map((ev) => <EventRow key={ev.id} ev={ev} />)}
        </div>
      )}
    </div>
  );
}
