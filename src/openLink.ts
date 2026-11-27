import { call, toaster } from "@decky/api";
import { t } from "./i18n";
import { readUiPreference } from "./uiPreferences";

export async function openUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return false;
    if (readUiPreference("external_links")) {
      if (!await call<[string], boolean>("open_external_link", parsed.href)) throw new Error("browser_unavailable");
      return true;
    }
    try {
      const sc = (window as any).SteamClient;
      if (sc?.URL?.ExecuteSteamURL) { sc.URL.ExecuteSteamURL("steam://openurl/" + parsed.href); return true; }
      if (sc?.System?.OpenInSystemBrowser) { sc.System.OpenInSystemBrowser(parsed.href); return true; }
    } catch { /* Keep the existing CEF fallback if a Steam API changed. */ }
    window.open(parsed.href, "_blank");
    return true;
  } catch {
    toaster.toast({ title: "Steamcord", body: t("external_link_failed") });
    return false;
  }
}
