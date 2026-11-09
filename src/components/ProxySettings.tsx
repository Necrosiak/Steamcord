// Réglages ▸ Proxy — Discord est bloqué dans plusieurs pays, et un VPN pour
// toute la console est souvent plus que ce que les gens veulent. On désigne ici
// le proxy que Vesktop ET les téléchargements du plugin doivent utiliser.
//
// Pourquoi un pont local (defaults/netproxy.py) plutôt que --proxy-server tout
// seul : Chromium ignore les identifiants dans --proxy-server et ne sait pas
// authentifier SOCKS5 ; aiohttp ne parle pas SOCKS ; urllib n'authentifie pas
// les proxys. Ce fichier ne fait que l'interface.
//
// ⚠️ Ce panneau ne doit JAMAIS être vide. Il a déjà existé avec un
// `useState(null)` + `return null` quand l'appel backend échouait : après une
// mise à jour où le Python n'avait pas été rechargé, l'en-tête « Proxy »
// restait seul, sans un seul contrôle à l'écran (retour utilisateur). On
// affiche donc toujours les contrôles, avec les valeurs par défaut, et un
// message explicite quand le backend ne répond pas.
import { Dropdown, PanelSectionRow, TextField, ToggleField } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { Notice, RowBtn } from "./Styled";

// Même repli que dans index.tsx : un @decky/ui cassé après une mise à jour de
// Steam ne doit pas emporter la section entière.
const SR = PanelSectionRow || ((p: any) => <div>{p.children}</div>);

interface ProxyCfg {
  enabled: boolean;
  scheme: string;
  host: string;
  port: number | string;
  username: string;
  password: string;
  // The backend never sends the stored password back (the panel can be on
  // stream): only whether one is set. An empty field keeps it.
  has_password?: boolean;
  bypass: string;
}

const PROXY_DEFAULTS: ProxyCfg = {
  enabled: false, scheme: "socks5", host: "", port: 1080,
  username: "", password: "", bypass: "",
};

// Ce que Chromium accepte dans --proxy-server, et ce que le pont sait parler.
const PROXY_SCHEMES = [
  { data: "socks5", label: "SOCKS5" },
  { data: "socks4", label: "SOCKS4" },
  { data: "http", label: "HTTP" },
  { data: "https", label: "HTTPS" },
];

export const ProxySection = () => {
  const [cfg, setCfg] = useState<ProxyCfg>(PROXY_DEFAULTS);
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [needRestart, setNeedRestart] = useState(false);

  const reload = () => {
    setMsg("");
    call<[], any>("get_proxy")
      .then((c) => {
        if (!c || typeof c !== "object") throw new Error("no config");
        setCfg({
          enabled: !!c.enabled,
          scheme: c.scheme || "socks5",
          host: c.host || "",
          port: c.port ?? 1080,
          username: c.username || "",
          password: "",
          has_password: !!c.has_password,
          bypass: c.bypass || "",
        });
        setUnreachable(!!c.error);
      })
      .catch(() => setUnreachable(true));
  };

  useEffect(() => { reload(); }, []);

  const patch = (p: Partial<ProxyCfg>) => {
    setCfg({ ...cfg, ...p });
    setMsg("");
  };

  const push = async (): Promise<any> => {
    const r: any = await call(
      "set_proxy", cfg.enabled, cfg.scheme, cfg.host, String(cfg.port ?? ""),
      cfg.username, cfg.password || null, cfg.bypass,
    );
    if (r?.ok) {
      setCfg((c) => ({ ...c, ...r.config, password: "" }));
      setNeedRestart(!!r.restart_required);
      setMsg(t("proxy_saved"));
    } else {
      setMsg(t(String(r?.error || "proxy_err_save")));
    }
    return r;
  };

  // Un appel rejeté n'est pas un échec d'enregistrement : c'est le backend qui
  // n'a pas cette méthode (Python pas rechargé après une mise à jour) ou qui ne
  // tourne pas. Le dire, au lieu du « impossible d'enregistrer » trompeur.
  const failed = (e?: any) => {
    console.log("[Steamcord] proxy call failed:", e);
    setUnreachable(true);
    setMsg(t("proxy_err_backend"));
  };

  const save = async () => {
    if (busy) return;
    setBusy(true); setMsg("");
    try {
      await push();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  // Tester enregistre d'abord : le test doit porter sur ce qui sera réellement
  // utilisé, pas sur une saisie qui n'a jamais été appliquée.
  const test = async () => {
    if (busy) return;
    setBusy(true); setMsg("");
    try {
      const saved = await push();
      if (!saved?.ok) return;
      const r: any = await call("test_proxy");
      setMsg(r?.ok ? t("proxy_test_ok", { ms: r.ms ?? 0 }) : t(String(r?.error || "proxy_err_unreachable")));
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (busy) return;
    setBusy(true); setMsg("");
    try {
      const r: any = await call("apply_proxy");
      if (r?.ok) {
        setNeedRestart(false);
        setMsg(r?.restarted ? t("proxy_restarted") : t("proxy_applied"));
      } else {
        setMsg(t(String(r?.error || "proxy_err_restart")));
      }
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {unreachable && (
        <SR><Notice tone="warn">{t("proxy_err_backend")}</Notice></SR>
      )}
      <SR>
        <ToggleField
          label={t("proxy_enable")}
          description={t("proxy_enable_desc")}
          checked={cfg.enabled}
          onChange={(v: boolean) => patch({ enabled: v })}
          bottomSeparator="none"
        />
      </SR>
      {cfg.enabled && (
        <>
          <SR>
            <Dropdown
              rgOptions={PROXY_SCHEMES as any}
              selectedOption={cfg.scheme}
              onChange={(o: any) => patch({ scheme: o.data })}
            />
          </SR>
          <SR>
            <TextField
              label={t("proxy_host")}
              value={cfg.host}
              onChange={(e: any) => patch({ host: String(e?.target?.value ?? "") })}
            />
          </SR>
          <SR>
            <TextField
              label={t("proxy_port")}
              value={String(cfg.port ?? "")}
              onChange={(e: any) => patch({ port: String(e?.target?.value ?? "").replace(/[^0-9]/g, "") })}
            />
          </SR>
          <SR>
            <TextField
              label={t("proxy_user")}
              value={cfg.username}
              onChange={(e: any) => patch({ username: String(e?.target?.value ?? "") })}
            />
          </SR>
          <SR>
            <TextField
              label={t("proxy_password")}
              description={cfg.has_password && !cfg.password ? t("proxy_password_kept") : undefined}
              bIsPassword={true}
              value={cfg.password}
              onChange={(e: any) => patch({ password: String(e?.target?.value ?? "") })}
            />
          </SR>
          <SR>
            <TextField
              label={t("proxy_bypass")}
              value={cfg.bypass}
              onChange={(e: any) => patch({ bypass: String(e?.target?.value ?? "") })}
            />
          </SR>
          <SR><Notice>{t("proxy_voice_note")}</Notice></SR>
        </>
      )}
      <SR><RowBtn onClick={test} disabled={busy}>{busy ? "…" : t("proxy_test")}</RowBtn></SR>
      <SR><RowBtn onClick={save} disabled={busy}>{t("proxy_save")}</RowBtn></SR>
      {unreachable && <SR><RowBtn onClick={reload}>{t("proxy_reload")}</RowBtn></SR>}
      {needRestart && (
        <>
          <SR><RowBtn onClick={apply} disabled={busy}>{t("proxy_restart")}</RowBtn></SR>
          <SR><Notice>{t("proxy_restart_needed")}</Notice></SR>
        </>
      )}
      {msg && <SR><Notice>{msg}</Notice></SR>}
    </>
  );
};
