// Réglages ▸ Compte ▸ Comptes (#111) — bascule entre plusieurs comptes Discord.
//
// On ne gère AUCUN identifiant : c'est le sélecteur de comptes natif du client
// web Discord (celui que Vesktop fait tourner) qui garde les sessions. Le
// plugin ne fait que lister (id, pseudo, avatar), demander la bascule, retirer
// un compte et ouvrir la fenêtre native « Ajouter un compte », dont on recopie
// le QR ici : Vesktop est caché en mode Jeu, sa fenêtre ne s'afficherait pas.
import { ModalRoot, PanelSectionRow, showModal } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { Notice, RowBtn, DANGER } from "./Styled";
import { openCaptchaSolver } from "./CaptchaSolver";

const SR = PanelSectionRow || ((p: any) => <div>{p.children}</div>);
const ModalRootAny = ModalRoot as any;

type Account = { id: string; username: string; avatar: string | null; valid: boolean; current: boolean };

const avatarOf = (a: Account) =>
  a.avatar ? `https://cdn.discordapp.com/avatars/${a.id}/${a.avatar}.webp?size=64` : "https://cdn.discordapp.com/embed/avatars/0.png";

const AddAccountModal = ({ closeModal, onDone }: { closeModal?: () => void; onDone: () => void }) => {
  const [qr, setQr] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState(false);
  const [error, setError] = useState(false);
  const added = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer: any;
    const poll = async () => {
      try {
        const r: any = await call("add_account", "poll");
        if (!alive) return;
        if (r?.added) {
          added.current = true;
          onDone();
          closeModal?.();
          return;
        }
        setQr(r?.qr || null);
        setCaptcha(!!r?.captcha);
      } catch {
        if (alive) setError(true);
      }
      if (alive) timer = setTimeout(poll, 1500);
    };
    call("add_account", "open").then(poll).catch(() => alive && setError(true));
    return () => {
      alive = false;
      clearTimeout(timer);
      // Fermer la fenêtre native si l'ajout n'a pas abouti : sinon elle reste
      // ouverte, invisible, dans Vesktop.
      if (!added.current) call("add_account", "close").catch(() => {});
    };
  }, []);

  return (
    <ModalRootAny closeModal={closeModal} onCancel={closeModal}>
      <div style={{ textAlign: "center", padding: "4px 8px" }}>
        <h2 style={{ margin: "0 0 8px" }}>{t("accounts_add")}</h2>
        {error ? (
          <Notice tone="error">{t("accounts_error")}</Notice>
        ) : qr ? (
          <>
            <img src={qr} style={{ width: 200, height: 200, borderRadius: 8, background: "#fff", padding: 6 }} />
            <p style={{ fontSize: 13, opacity: 0.75, margin: "10px 0 0", lineHeight: 1.4 }}>{t("accounts_add_scan")}</p>
          </>
        ) : (
          <p style={{ fontSize: 13, opacity: 0.6 }}>{t("accounts_add_wait")}</p>
        )}
        {captcha && (
          <div style={{ marginTop: 10 }}>
            <Notice tone="warn">{t("captcha_needed")}</Notice>
            <RowBtn onClick={() => openCaptchaSolver()}>{t("captcha_open")}</RowBtn>
          </div>
        )}
      </div>
    </ModalRootAny>
  );
};

export const AccountsSection = () => {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = async () => {
    try {
      const r: any = await call("get_accounts");
      setAccounts(r?.accounts || []);
      setError(false);
    } catch {
      setError(true);
    }
  };
  useEffect(() => { load(); }, []);

  const act = async (id: string, method: "switch_account" | "remove_account") => {
    setBusy(id);
    setConfirm(null);
    try { await call(method, id); } catch { setError(true); }
    setBusy(null);
    // La bascule recharge la session Discord : on relit la liste un peu après.
    setTimeout(load, method === "switch_account" ? 4000 : 300);
  };

  return (
    <>
      <SR><div style={{ fontSize: 11, opacity: 0.65, lineHeight: 1.35 }}>{t("accounts_hint")}</div></SR>
      {error && <SR><Notice tone="error">{t("accounts_error")}</Notice></SR>}
      {(accounts || []).map((a) => (
        <SR key={a.id}>
          <div style={{ width: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 32 }}>
              <img src={avatarOf(a)} style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600 }}>
                {a.username}
              </div>
              {a.current && <span style={{ fontSize: 11, opacity: 0.7 }}>{t("accounts_current")}</span>}
            </div>
            {!a.valid && !a.current && <div style={{ fontSize: 11, color: "#ffb74d", margin: "2px 0 0 36px" }}>{t("accounts_invalid")}</div>}
            {!a.current && (
              confirm === a.id ? (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 4, textAlign: "center" }}>{t("accounts_remove_confirm", { name: a.username })}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <RowBtn flex color={DANGER} onClick={() => act(a.id, "remove_account")}>{t("logout_yes")}</RowBtn>
                    <RowBtn flex onClick={() => setConfirm(null)}>{t("logout_cancel")}</RowBtn>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  {a.valid && (
                    <RowBtn flex disabled={!!busy} onClick={() => act(a.id, "switch_account")}>
                      {busy === a.id ? "…" : t("accounts_switch")}
                    </RowBtn>
                  )}
                  <RowBtn flex disabled={!!busy} color={DANGER} onClick={() => setConfirm(a.id)}>{t("accounts_remove")}</RowBtn>
                </div>
              )
            )}
          </div>
        </SR>
      ))}
      <SR>
        <RowBtn disabled={!!busy || error} onClick={() => showModal(<AddAccountModal onDone={() => setTimeout(load, 3000)} />)}>
          {t("accounts_add")}
        </RowBtn>
      </SR>
    </>
  );
};
