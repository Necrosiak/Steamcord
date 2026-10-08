// Page « appel entrant », ouverte en cliquant la notification d'un appel MP.
// Répondre rejoint l'appel puis ouvre le panneau Steamcord du QAM, qui affiche
// l'appel en cours (contrôles micro, membres, partage). Si la sonnerie s'arrête
// (ou s'était arrêtée avant le clic), la page propose de rappeler : répondre à
// un appel fini en démarrerait un nouveau sans le dire.
import { Focusable, ModalRoot, Navigation, QuickAccessTab, showModal } from "@decky/ui";
import { addEventListener, call, removeEventListener } from "@decky/api";
import { useEffect, useState } from "react";
import { t, errText } from "../i18n";
import { ActionCard, DANGER, ONLINE, SteamcordModalFrame } from "./Styled";
import { IcPhone } from "./Icons";

const ModalRootAny = ModalRoot as any;
const DEFAULT_AVATAR = "https://cdn.discordapp.com/embed/avatars/0.png";

// Decky ne publie pas d'API pour choisir le plugin affiché : setActivePlugin
// est l'état interne que son propre menu utilise. Sans lui, le QAM s'ouvre sur
// l'onglet Decky, mais sur le dernier plugin consulté.
export function openSteamcordPanel() {
  try { (window as any).DeckyPluginLoader?.deckyState?.setActivePlugin?.("Steamcord"); } catch {}
  try { Navigation.OpenQuickAccessMenu(QuickAccessTab.Decky); } catch (e) { console.error("[Steamcord] ouverture du QAM échouée", e); }
}

function IncomingCallModal({ channelId, caller, avatar, closeModal }:
  { channelId: string; caller: string; avatar?: string; closeModal?: () => void }) {
  const [ended, setEnded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call<[string], boolean>("call_ringing", channelId)
      .then((ringing) => { if (ringing === false) setEnded(true); })
      .catch(() => {});
    const onStop = (data: { channel_id: string }) => { if (data?.channel_id === channelId) setEnded(true); };
    addEventListener("call_ring_stop", onStop);
    return () => { removeEventListener("call_ring_stop", onStop); };
  }, [channelId]);

  // Sonne encore → on rejoint l'appel existant ; sinon on rappelle.
  const answer = async () => {
    setBusy(true);
    try {
      await call("dm_call", channelId, !ended);
      closeModal?.();
      openSteamcordPanel();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  const decline = async () => {
    setBusy(true);
    try {
      await call("decline_call", channelId);
      closeModal?.();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <ModalRootAny closeModal={closeModal} onCancel={() => closeModal?.()}>
      <SteamcordModalFrame maxWidth={480}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "24px 22px 22px" }}>
          <div style={{ color: ended ? "#aeb6c4" : ONLINE, display: "flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 700 }}>
            <IcPhone /> {ended ? t("call_ended") : t("incoming_call")}
          </div>
          <img src={avatar || DEFAULT_AVATAR} width={88} height={88} style={{ borderRadius: "50%", border: "3px solid rgba(88,101,242,.7)", objectFit: "cover" }} />
          <div style={{ fontSize: 21, fontWeight: 700, textAlign: "center", overflowWrap: "anywhere" }}>{caller}</div>
          {error && <div style={{ color: "#ff6b6b", fontSize: 12, textAlign: "center" }}>{error}</div>}
          <Focusable flow-children="row" style={{ display: "flex", gap: 10, width: "100%", marginTop: 8 }}>
            <ActionCard color={ONLINE} disabled={busy} onClick={answer}>
              <IcPhone /> {ended ? t("call_back") : t("call_answer")}
            </ActionCard>
            <ActionCard color={ended ? undefined : DANGER} disabled={busy} onClick={ended ? () => closeModal?.() : decline}>
              {ended ? t("call_close") : t("call_decline")}
            </ActionCard>
          </Focusable>
        </div>
      </SteamcordModalFrame>
    </ModalRootAny>
  );
}

export function openIncomingCall(channelId: string, caller: string, avatar?: string) {
  showModal(<IncomingCallModal channelId={channelId} caller={caller} avatar={avatar} />);
}
