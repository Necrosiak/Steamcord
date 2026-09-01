import { DialogButton } from "@decky/ui";
import { useState } from "react";
import { useSteamcordState } from "../../hooks/useSteamcordState";
import { FaDesktop, FaStop } from "react-icons/fa";
import { call } from "@decky/api";
import { t } from "../../i18n";
import { focusHalo, ACCENT, DANGER } from "../Styled";

const Btn = DialogButton as any;

export function GoLiveButton() {
  const state = useSteamcordState();
  // Focus géré nous-mêmes : le focus natif du DialogButton met un fond clair +
  // texte sombre → texte illisible/disparu. On force le texte blanc + un simple
  // halo (anneau blanc), fond inchangé.
  const [focused, setFocused] = useState(false);
  // Cooldown anti double-toggle (issue #12) : fermer puis rouvrir en <1s fait
  // se chevaucher teardown et nouvelle acquisition (session portail, venmic) —
  // bouton mort et session coincée chez un utilisateur Deck.
  //
  // Le délai est ASYMÉTRIQUE depuis le 01/09. Après un DÉMARRAGE, 2,5 s
  // suffisent : rien n'est en cours de démontage, et il faut pouvoir couper
  // vite. Après un ARRÊT c'est l'inverse — Chromium rend ses fds PipeWire,
  // le shim ses sessions ScreenCast et venmic s'arrête, le tout en plusieurs
  // secondes. Un enchaînement arrêt → relance à ~5 s a été mesuré en échec :
  // pw-dump coincé par le churn précédent, `Start` en 14 s au lieu de 30 ms,
  // budget du client dépassé, Go Live perdu. Mieux vaut un bouton grisé un peu
  // plus longtemps qu'un partage qui échoue silencieusement.
  const START_COOLDOWN_MS = 2500;
  const STOP_COOLDOWN_MS = 6000;
  const [coolingDown, setCoolingDown] = useState(false);

  // Only available while connected to a voice channel
  if (!state?.vc?.channel_name) return null;

  const live = !!state?.me?.is_live;

  return (
    <Btn
      disabled={coolingDown}
      onClick={() => {
        if (coolingDown) return;
        setCoolingDown(true);
        setTimeout(() => setCoolingDown(false),
                   live ? STOP_COOLDOWN_MS : START_COOLDOWN_MS);
        call(live ? "stop_go_live" : "go_live");
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        width: "100%", margin: 0, padding: "6px 0", minHeight: 0,
        boxSizing: "border-box",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        fontSize: 12, fontWeight: 600,
        color: "#fff", borderRadius: 6,
        background: live ? DANGER : (focused ? "rgba(88,101,242,0.85)" : "rgba(88,101,242,0.35)"),
        opacity: coolingDown ? 0.5 : 1,
        ...focusHalo(live ? DANGER : ACCENT, focused),
      }}
    >
      {live ? <FaStop /> : <FaDesktop />}
      {live ? t("go_live_stop") : t("go_live_start")}
    </Btn>
  );
}
