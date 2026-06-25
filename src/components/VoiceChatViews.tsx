import { call } from "@decky/api";
import { useState } from "react";
import { useStreamcordState } from "../hooks/useStreamcordState";
import { t } from "../i18n";
import { SliderField } from "@decky/ui";

const SliderFieldAny = SliderField as any;

export function VoiceChatChannel() {
  const state = useStreamcordState();
  if (!state?.vc) return <div />;
  // DM calls have no guild — the backend sends null and we localize the label.
  return (
    <div style={{ marginBottom: 4 }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{state.vc.channel_name || t("private_message")}</span>
      <span style={{ fontSize: 11, opacity: 0.5, marginLeft: 6 }}>{state.vc.guild_name || t("private_message")}</span>
    </div>
  );
}

function UserRow({ user }: { user: any }) {
  const [volume, setVolume] = useState<number>(100);

  const speaking = user?.is_speaking;
  const muted = user?.is_muted;
  const deafened = user?.is_deafened;

  const onVolumeChange = async (val: number) => {
    setVolume(val);
    await call("set_user_volume", user.id, val);
  };

  return (
    <li style={{ listStyle: "none", marginBottom: 8, padding: "6px 0", background: "rgba(255,255,255,0.04)", borderRadius: 6, overflow: "hidden", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 8px" }}>
        <div style={{ position: "relative", flexShrink: 0 }}>
          <img
            src={user?.avatar
              ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp`
              : `https://cdn.discordapp.com/embed/avatars/0.png`}
            width={28} height={28}
            style={{
              borderRadius: "50%",
              display: "block",
              // Native-Discord-style glowing halo while speaking
              boxShadow: speaking
                ? "0 0 0 2px #23a55a, 0 0 10px 3px rgba(35,165,90,0.75)"
                : "0 0 0 2px transparent",
              transition: "box-shadow 0.08s ease-out",
            }}
          />
          {(muted || deafened) && (
            <div style={{
              position: "absolute", bottom: -1, right: -1,
              background: "#ed4245", borderRadius: "50%",
              width: 12, height: 12,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 8, lineHeight: 1
            }}>
              {deafened ? "🔇" : "🔕"}
            </div>
          )}
        </div>
        <span style={{ flex: 1, fontSize: 12, opacity: muted ? 0.45 : 0.9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {user?.username}
          {user?.is_live && <span style={{ marginLeft: 4, color: "#ed4245", fontSize: 9 }}>● LIVE</span>}
        </span>
        {speaking && (
          <div style={{
            width: 8, height: 8, borderRadius: "50%", background: "#23a55a", flexShrink: 0,
            boxShadow: "0 0 6px 1px rgba(35,165,90,0.8)"
          }} />
        )}
      </div>
      {/* Gamepad-navigable volume (how loud YOU hear this person — not their mic) */}
      <div style={{ padding: "0 4px", boxSizing: "border-box", maxWidth: "100%", overflow: "hidden" }}>
        <SliderFieldAny
          label={`🔊 ${volume}%`}
          value={volume}
          min={0}
          max={200}
          step={5}
          onChange={onVolumeChange}
          bottomSeparator="none"
        />
      </div>
    </li>
  );
}

export function VoiceChatMembers() {
  const state = useStreamcordState();
  if (!state?.vc?.users) return <div />;
  return (
    <ul style={{ margin: 0, padding: 0 }}>
      {state.vc.users.map((user: any) => (
        <UserRow key={user.id} user={user} />
      ))}
    </ul>
  );
}
