import { call, toaster } from "@decky/api"
import { Router } from "@decky/ui"
import { useLayoutEffect } from "react"
import { t } from "../i18n"

export const DiscordTab = () => {
    useLayoutEffect(() => {
        call<[], any>("get_state").then(res => {
            const state = res;
            if (state?.loaded && window.DISCORD_TAB) {
                window.DISCORD_TAB.m_browserView.SetVisible(true);
                window.DISCORD_TAB.m_browserView.SetFocus(true);
            }
            else {
                toaster.toast({
                    title: "Steamcord",
                    body: t("not_loaded")
                });
                Router.Navigate("/library/home");
            }
        })
        return () => {
            if (!window.DISCORD_TAB)
                return;

            window.DISCORD_TAB.m_browserView.SetVisible(false);
            window.DISCORD_TAB.m_browserView.SetFocus(false);
        }
    })
    return <div></div>
}