import { call } from "@decky/api";
import { Focusable, NavEntryPositionPreferences } from "@decky/ui";
import { useState } from "react";
import { t } from "../i18n";
import { useFillHeight, Card, InlineBtn, Notice, Pill, ACCENT, ONLINE } from "./Styled";
import { useQamUi } from "../qamUi";
import { IcPhone } from "./Icons";
import { useDmChannels } from "../hooks/useDmChannels";
import { DmPinButton } from "./DmPinButton";

interface DMRecipient { id: string; username: string; avatar: string | null; }
interface DMChannel {
  id: string;
  type: number;
  name: string;
  icon: string | null;
  recipients: DMRecipient[];
  active_call: boolean;
  pinned?: boolean;
}

// Avatar d'une conversation. Même géométrie que l'icône de serveur (taille
// mise à l'échelle du panneau, jamais 24 px en dur) : sur un écran 1440p la
// liste des MP était deux fois plus petite que celle des serveurs, juste à
// côté.
function DMAvatar({ ch }: { ch: DMChannel }) {
  const { px } = useQamUi();
  const av = px(26);
  const common = { width: av, height: av, borderRadius: "50%", flexShrink: 0, objectFit: "cover" as const };
  if (ch.type === 3 && ch.icon) {
    return <img src={`https://cdn.discordapp.com/channel-icons/${ch.id}/${ch.icon}.webp?size=64`}
                width={av} height={av} style={common} />;
  }
  if (ch.recipients.length >= 1) {
    const r = ch.recipients[0];
    return (
      <img
        src={r.avatar
          ? `https://cdn.discordapp.com/avatars/${r.id}/${r.avatar}.webp?size=64`
          : `https://cdn.discordapp.com/embed/avatars/0.png`}
        width={av} height={av} style={common}
      />
    );
  }
  return (
    <div style={{
      ...common, background: ACCENT,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: px(12), fontWeight: 700, color: "#fff",
    }}>
      {ch.name[0]?.toUpperCase()}
    </div>
  );
}

function DMRow({ ch }: { ch: DMChannel }) {
  const { px } = useQamUi();
  const [busy, setBusy] = useState(false);

  const onCall = async () => {
    setBusy(true);
    await call("dm_call", ch.id, ch.active_call);
    setTimeout(() => setBusy(false), 2000);
  };

  // Bloc sur la surface commune (Card) : arrondi, liseré, et teinte verte
  // quand un appel est en cours — le même vocabulaire que les autres listes.
  return (
    <Focusable flow-children="column" navEntryPreferPosition={NavEntryPositionPreferences.MAINTAIN_X} style={{ marginBottom: px(5) }}>
      <Card tint={ONLINE} active={ch.active_call} style={{ padding: `${px(7)}px ${px(9)}px` }}>
        <Focusable flow-children="row" navEntryPreferPosition={NavEntryPositionPreferences.MAINTAIN_X} style={{ display: "flex", alignItems: "center", gap: px(9), minWidth: 0 }}>
          <DMAvatar ch={ch} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: px(13), fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ch.name}
            </div>
            {ch.type === 3 && ch.recipients.length > 0 && (
              <div style={{ fontSize: px(10), opacity: 0.5 }}>{t("members", { count: ch.recipients.length + 1 })}</div>
            )}
          </div>
          {ch.active_call && <Pill color={ONLINE}>{t("in_call")}</Pill>}
          <DmPinButton channel={ch} />
        </Focusable>
        <div style={{ marginTop: px(6) }}>
          <InlineBtn on={ch.active_call} color={ONLINE} disabled={busy} onClick={onCall}>
            {busy ? "…" : <><IcPhone /> {ch.active_call ? t("join") : t("call")}</>}
          </InlineBtn>
        </div>
      </Card>
    </Focusable>
  );
}

export function DMBrowser() {
  const fill = useFillHeight();
  const { channels, error } = useDmChannels<DMChannel>();

  return (
    <div>
      {error && <Notice tone="error">{error}</Notice>}
      {channels === null ? (
        <Notice>{t("loading")}</Notice>
      ) : channels.length === 0 ? (
        <Notice>{t("no_dms")}</Notice>
      ) : (
        <Focusable data-sc-dm-list flow-children="column" ref={fill.ref} style={{ maxHeight: fill.height, overflowY: "auto" }}>
          {channels.map(ch => <DMRow key={ch.id} ch={ch} />)}
        </Focusable>
      )}
    </div>
  );
}
