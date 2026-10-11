import { call } from "@decky/api";
import { useState } from "react";
import { BsPinAngle, BsPinAngleFill, BsArrowUp, BsArrowDown } from "react-icons/bs";
import { MiniBtn } from "./Styled";
import { t } from "../i18n";

export function DmPinButton({ channel }: { channel: { id: string; pinned?: boolean } }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const toggle = async () => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try { await call("set_dm_pinned", channel.id, !channel.pinned); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  const move = async (direction: number) => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try { await call('move_dm_pin', channel.id, direction); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return <>
    {channel.pinned && <>
      <MiniBtn compact dmAction="up" onClick={() => move(-1)} title={t('server_move_up')}><BsArrowUp size={13} /></MiniBtn>
      <MiniBtn compact dmAction="down" onClick={() => move(1)} title={t('server_move_down')}><BsArrowDown size={13} /></MiniBtn>
    </>}
    <MiniBtn compact dmAction="pin" onClick={toggle} title={failed ? t("dm_pin_failed") : t(channel.pinned ? "dm_unpin" : "dm_pin")}>
    <span style={{ color: failed ? "#ed4245" : channel.pinned ? "#a5acff" : undefined }}>
      {channel.pinned ? <BsPinAngleFill size={14} /> : <BsPinAngle size={14} />}
    </span>
  </MiniBtn></>;
}
