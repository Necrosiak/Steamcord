import { SliderField } from "@decky/ui";
import { useEffect, useState } from "react";
import { useSteamcordState } from "../../hooks/useSteamcordState";
import { FaVolumeUp, FaStop } from "react-icons/fa";
import { IcController, IcMic } from "../Icons";
import { call } from "@decky/api";
import { t } from "../../i18n";
import { DANGER, InlineBtn, Notice } from "../Styled";

const Slider = SliderField as any;

// Partage du SON du jeu dans le vocal : le backend mixe micro + audio du jeu dans
// un sink virtuel que Vesktop capture à la place du micro (voir start_game_audio,
// main.py). Les deux jauges règlent le volume de chaque branche du mix — ce que
// les AUTRES entendent, pas le volume local.
export function GameAudioShare() {
  const state = useSteamcordState();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [voice, setVoice] = useState(100);
  const [game, setGame] = useState(60);
  const [hasMic, setHasMic] = useState(true);

  const refresh = () =>
    call<[], { active: boolean; has_mic: boolean; voice: number; game: number }>("get_game_audio")
      .then((r) => {
        if (!r) return;
        setOn(!!r.active);
        setHasMic(r.has_mic !== false);
        if (typeof r.voice === "number") setVoice(r.voice);
        if (typeof r.game === "number") setGame(r.game);
      })
      .catch(() => {});

  // L'état vit au backend (survit au démontage du QAM) → resync au montage.
  useEffect(() => { refresh(); }, []);

  if (!state?.vc?.channel_name) return null;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (on) { await call("stop_game_audio"); setOn(false); }
      else { const ok = await call<[], boolean>("start_game_audio"); setOn(ok !== false); await refresh(); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {/* Bouton d'action commun (#45) : ce bloc etait la 3e copie du meme
          dessin dans le plugin, avec ses tailles en dur. */}
      <InlineBtn big on={on} color={DANGER} tone="accent" disabled={busy} onClick={toggle}>
        {on ? <FaStop /> : <FaVolumeUp />}
        {on ? t("game_audio_stop") : t("game_audio_start")}
      </InlineBtn>
      {on && (
        <div style={{ padding: "0 6px", boxSizing: "border-box", width: "100%", overflow: "hidden" }}>
          {hasMic ? (
            <Slider
              label={<><IcMic /> {t("game_audio_voice")} {voice}%</>}
              value={voice}
              min={0} max={150} step={5}
              onChange={(v: number) => { setVoice(v); call("set_game_audio_volume", "voice", v); }}
              bottomSeparator="none"
            />
          ) : (
            <Notice>{t("game_audio_nomic")}</Notice>
          )}
          <Slider
            label={<><IcController /> {t("game_audio_game")} {game}%</>}
            value={game}
            min={0} max={150} step={5}
            onChange={(v: number) => { setGame(v); call("set_game_audio_volume", "game", v); }}
            bottomSeparator="none"
          />
        </div>
      )}
    </div>
  );
}
