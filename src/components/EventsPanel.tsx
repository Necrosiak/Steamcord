// Événements programmés d'un serveur : les voir et s'y joindre depuis le QAM.
//
// Délibérément réduit à ça. Pas de création, pas de modification : recréer
// l'éditeur d'événements de Discord dans un panneau de 340 px n'apporterait
// rien, alors que « qu'est-ce qui commence bientôt, et comment j'y vais » est
// exactement ce qu'on ne peut pas faire manette en main aujourd'hui.
//
// Le panneau ne s'affiche QUE s'il y a quelque chose à montrer : sans
// événement, il ne prend pas une ligne.
import { Focusable } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { ACCENT, focusHalo } from "./Styled";
import { useQamUi } from "../qamUi";
import { IcChevronDown, IcChevronUp } from "./Icons";

type SCEvent = {
  id: string; guild_id: string; guild: string; name: string; description: string;
  start: string | null; status: number; channel_id: string | null;
  location: string; count: number;
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

function EventRow({ ev, onRefresh }: { ev: SCEvent; onRefresh: () => void }) {
  const { px } = useQamUi();
  const [focused, setFocused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [interested, setInterested] = useState(false);
  const live = ev.status === ACTIVE;

  const act = async (fn: () => Promise<any>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } catch (_) { /* l'échec se voit à l'état inchangé */ }
    setBusy(false);
  };
  const join = () => act(async () => {
    await call("join_vc", ev.channel_id, ev.guild_id);
    onRefresh();
  });
  const rsvp = () => act(async () => {
    await call("set_event_interest", ev.guild_id, ev.id, !interested);
    setInterested((v) => !v);
  });

  const btn = (key: string, label: string, onClick: () => void, danger?: boolean) => (
    <Focusable
      onActivate={onClick}
      onClick={onClick}
      onFocus={() => setFocused(key)}
      onBlur={() => setFocused((f) => (f === key ? null : f))}
      onGamepadFocus={() => setFocused(key)}
      onGamepadBlur={() => setFocused((f) => (f === key ? null : f))}
      style={{
        padding: `${px(3)}px ${px(8)}px`, borderRadius: 4, fontSize: px(11),
        fontWeight: 600, color: "#fff", opacity: busy ? 0.5 : 1,
        background: focused === key
          ? (danger ? "rgba(237,66,69,0.85)" : "rgba(88,101,242,0.85)")
          : "rgba(88,101,242,0.32)",
        ...focusHalo(ACCENT, focused === key, 1.0),
      }}
    >
      {label}
    </Focusable>
  );

  return (
    <div style={{
      padding: `${px(5)}px ${px(6)}px`, marginBottom: 3, borderRadius: 6,
      background: "rgba(255,255,255,0.04)",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        {live && (
          <span style={{ fontSize: px(9), fontWeight: 700, color: "#ed4245", flexShrink: 0 }}>
            ● {t("event_live")}
          </span>
        )}
        <span style={{ flex: 1, minWidth: 0, fontSize: px(12), fontWeight: 600,
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {ev.name}
        </span>
      </div>
      <div style={{ fontSize: px(10), opacity: 0.6, marginTop: 1 }}>
        {[ev.guild, live ? "" : whenLabel(ev.start), ev.location,
          ev.count ? `${ev.count} ${t("event_interested_count")}` : ""]
          .filter(Boolean).join(" · ")}
      </div>
      <Focusable flow-children="row" style={{ display: "flex", gap: 4, marginTop: 4 }}>
        {live && ev.channel_id ? btn("join", t("event_join"), join) : null}
        {btn("rsvp", interested ? t("event_not_interested") : t("event_interested"), rsvp)}
      </Focusable>
    </div>
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
          {events.map((ev) => <EventRow key={ev.id} ev={ev} onRefresh={load} />)}
        </div>
      )}
    </div>
  );
}
