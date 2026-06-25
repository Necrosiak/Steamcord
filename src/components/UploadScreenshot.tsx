import { call } from "@decky/api";
import { DialogButton, Dropdown, DropdownOption } from "@decky/ui";
import { useEffect, useMemo, useState } from "react";
import { t } from "../i18n";

function urlContentToDataUri(url: string) {
  return fetch(url)
    .then((response) => response.blob())
    .then(
      (blob) =>
        new Promise((callback) => {
          let reader = new FileReader();
          reader.onload = function () {
            callback(this.result);
          };
          reader.readAsDataURL(blob);
        })
    );
}

export function UploadScreenshot() {
  const [screenshot, setScreenshot] = useState<any>();
  const [selectedChannel, setChannel] = useState<any>();
  const [uploadButtonDisabled, setUploadButtonDisabled] =
    useState<boolean>(false);
  const channels = useMemo((): DropdownOption[] => [], []);

  useEffect(() => {
    call<[], Record<string, any>>("get_last_channels")
      .then(res => {
        if ("error" in res)
          return;

        const channelList = res;
        console.log(channelList);
        for (const channelId in channelList) {
          console.log(channelId);
          channels.push({ data: channelId, label: channelList[channelId] });
        }
          

        if (channels.length > 0) setChannel(channels[0].data);
      });

    SteamClient.Screenshots.GetLastScreenshotTaken().then((res: any) => setScreenshot(res));
  }, []);

  // Nothing to upload → render nothing at all
  if (!screenshot?.strUrl) return null;

  return (
    <div>
      <hr />
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, opacity: 0.8 }}>
        📷 {t("share_screenshot")}
      </div>
      <img
        width={240}
        height={160}
        style={{ borderRadius: 6, display: "block", maxWidth: "100%" }}
        src={"https://steamloopback.host/" + screenshot.strUrl}
      ></img>
      {Dropdown ? (
        <Dropdown
          menuLabel={t("last_channels")}
          selectedOption={selectedChannel}
          rgOptions={channels}
          onChange={(e: { data: any; }) => {
            setChannel(e.data);
            if (window.location.pathname == "/routes/discord") {
              window.DISCORD_TAB.m_browserView.SetVisible(true);
              window.DISCORD_TAB.m_browserView.SetFocus(true);
            }
          }}
          onMenuOpened={() => {
            window.DISCORD_TAB.m_browserView.SetVisible(false);
            window.DISCORD_TAB.m_browserView.SetFocus(false);
          }}
        />
      ) : (
        <select value={selectedChannel} onChange={(e) => setChannel(e.target.value)}
          style={{ width: "100%", padding: "4px", marginTop: "4px" }}>
          {channels.map((ch: any) => <option key={ch.data} value={ch.data}>{ch.label}</option>)}
        </select>
      )}
      {DialogButton ? (
        <DialogButton
          style={{ marginTop: "5px" }}
          disabled={uploadButtonDisabled}
          onClick={async () => {
            setUploadButtonDisabled(true);
            const data = await urlContentToDataUri(`https://steamloopback.host/${screenshot.strUrl}`);
            await call("post_screenshot", selectedChannel, data);
            setUploadButtonDisabled(false);
          }}
        >
          {t("upload")}
        </DialogButton>
      ) : (
        <button
          style={{ marginTop: "5px", padding: "6px 12px", cursor: "pointer", width: "100%" }}
          disabled={uploadButtonDisabled}
          onClick={async () => {
            setUploadButtonDisabled(true);
            const data = await urlContentToDataUri(`https://steamloopback.host/${screenshot.strUrl}`);
            await call("post_screenshot", selectedChannel, data);
            setUploadButtonDisabled(false);
          }}
        >
          {t("upload")}
        </button>
      )}
    </div>
  );
}
