import { DialogButton, Focusable } from "@decky/ui";
import { call } from "@decky/api";
import { useState } from "react";
import { publishDiscordRuntime, useSteamcordState } from "../hooks/useSteamcordState";
import { t } from "../i18n";

const Button = DialogButton as any;
const buttonStyle = { width: "100%", maxWidth: "100%", minWidth: 0,
  boxSizing: "border-box" as const, whiteSpace: "normal" as const,
  overflowWrap: "anywhere" as const };

// Settings only while On; a dedicated resume screen while Off. Two separate
// actions are required to stop, so scrolling/focus cannot accidentally hang up.
export function DiscordRuntimeControl() {
  const state = useSteamcordState();
  const enabled = state?.discord_enabled !== false;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const change = async (value: boolean) => {
    if (busy) return;
    setBusy(true); setError(false);
    try {
      const result = await call<[boolean], { ok: boolean; enabled?: boolean }>("set_discord_runtime", value);
      if (typeof result?.enabled === "boolean") publishDiscordRuntime(result.enabled);
      if (!result?.ok) setError(true);
    } catch { setError(true); }
    finally { setBusy(false); setConfirm(false); }
  };
  return <div style={{ padding: "8px 0", width: "100%", maxWidth: "100%", minWidth: 0,
    boxSizing: "border-box", overflowWrap: "anywhere" }}>
    <div style={{ fontWeight: 600, marginBottom: 6 }}>{t("discord_runtime_title")}</div>
    <div style={{ fontSize: 12, opacity: .75, marginBottom: 8 }}>
      {t(enabled ? "discord_runtime_hint" : "discord_runtime_paused")}
    </div>
    {!enabled ? <Button disabled={busy} onClick={() => change(true)} style={buttonStyle}>
      {t("discord_runtime_on")}
    </Button> : !confirm ? <Button disabled={busy} onClick={() => setConfirm(true)} style={buttonStyle}>
      {t("discord_runtime_off")}
    </Button> : <>
      <p style={{ fontSize: 12 }}>{t("discord_runtime_confirm")}</p>
      <Focusable flow-children="column" style={{ display: "flex", flexDirection: "column",
        width: "100%", minWidth: 0, gap: 8 }}>
        <Button disabled={busy} onClick={() => setConfirm(false)} style={buttonStyle}>{t("discord_runtime_cancel")}</Button>
        <Button disabled={busy} onClick={() => change(false)} style={buttonStyle}>{t("discord_runtime_stop")}</Button>
      </Focusable>
    </>}
    {error && <div role="alert" style={{ color: "#ff6b6b", fontSize: 12, marginTop: 6 }}>{t("discord_runtime_error")}</div>}
  </div>;
}
