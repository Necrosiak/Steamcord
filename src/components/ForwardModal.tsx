// Transfert d'un message vers un autre salon ou une conversation privée.
//
// Discord transfère par RÉFÉRENCE ; on n'a pas cette primitive ici, alors on
// renvoie une COPIE : le texte, les liens des pièces jointes, et le nom de
// l'auteur. L'attribution n'est pas une décoration — sans elle, un message
// transféré arrive comme si on l'avait écrit soi-même.
//
// Volontairement limité à « transférer » : pas de commentaire, pas d'édition.
// Une action, pas un éditeur — le QAM n'est pas la place pour rédiger.
import { DialogButton, Focusable, ModalRoot, showModal } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { ACCENT, focusHalo, useFillHeight } from "./Styled";
import { IcChat, IcHome, IcUser } from "./Icons";

const ModalRootAny = ModalRoot as any;
const Btn = DialogButton as any;

type Target = { id: string; label: string; kind: "dm" | "text"; guild?: string };

export type ForwardPayload = { author: string; content: string; urls: string[] };

export function buildForwardText({ author, content, urls }: ForwardPayload): string {
  const parts: string[] = [];
  if (author) parts.push(`**${author}** :`);
  if (content) parts.push(content);
  // Les liens CDN Discord s'affichent d'eux-mêmes chez le destinataire : une
  // image transférée reste une image, pas une URL nue.
  for (const u of urls) parts.push(u);
  return parts.join("\n");
}

function TargetRow({ target, busy, onPick }: { target: Target; busy: boolean; onPick: (t: Target) => void }) {
  const [focused, setFocused] = useState(false);
  return (
    <Focusable
      onActivate={() => onPick(target)}
      onClick={() => onPick(target)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        display: "flex", alignItems: "center", gap: 6, padding: "5px 8px",
        borderRadius: 6, marginBottom: 2, opacity: busy ? 0.5 : 1,
        background: focused ? "rgba(88,101,242,0.22)" : "rgba(255,255,255,0.04)",
        ...focusHalo(ACCENT, focused, 1.0),
      }}
    >
      <span style={{ opacity: 0.7, flexShrink: 0 }}>
        {target.kind === "dm" ? <IcUser /> : <IcChat />}
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {target.label}
      </span>
      {target.guild ? (
        <span style={{ fontSize: 10, opacity: 0.5, flexShrink: 0, maxWidth: "40%",
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {target.guild}
        </span>
      ) : null}
    </Focusable>
  );
}

export function ForwardModal({ payload, closeModal }: { payload: ForwardPayload; closeModal?: () => void }) {
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fill = useFillHeight(120, 120);

  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Target[] = [];
      // Les MP d'abord : c'est là qu'on transfère le plus souvent.
      try {
        const dms: any[] = (await call("get_dm_channels")) as any;
        for (const d of Array.isArray(dms) ? dms : []) {
          const label = d.name || (d.recipients || []).map((r: any) => r.username).join(", ");
          if (d.id) out.push({ id: String(d.id), label: label || "MP", kind: "dm" });
        }
      } catch (_) { /* liste partielle vaut mieux que rien */ }
      try {
        const guilds: any[] = (await call("get_text_channels")) as any;
        for (const g of Array.isArray(guilds) ? guilds : []) {
          for (const c of g.channels || []) {
            if (c.id) out.push({ id: String(c.id), label: "#" + (c.name || c.id), kind: "text", guild: g.name });
          }
        }
      } catch (_) { /* idem */ }
      if (alive) setTargets(out);
    })();
    return () => { alive = false; };
  }, []);

  const pick = async (target: Target) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r: any = await call("send_message", target.id, buildForwardText(payload));
      if (r && r.error) setErr(String(r.error));
      else setDone(target.label);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalRootAny closeModal={closeModal} onCancel={() => closeModal?.()}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}><IcHome /> {t("forward_to")}</div>
        {done ? (
          <div style={{ fontSize: 13, color: "#3ba55c" }}>{t("forward_done")} {done}</div>
        ) : err ? (
          <div style={{ fontSize: 12, color: "#ffcc66", whiteSpace: "pre-wrap" }}>{err}</div>
        ) : null}
        {targets === null ? (
          <div style={{ fontSize: 12, opacity: 0.6 }}>{t("forward_loading")}</div>
        ) : targets.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.6 }}>{t("forward_no_target")}</div>
        ) : (
          <Focusable ref={fill.ref} style={{ maxHeight: fill.height, overflowY: "auto" }}>
            {targets.map((tg) => (
              <TargetRow key={tg.kind + tg.id} target={tg} busy={busy} onPick={pick} />
            ))}
          </Focusable>
        )}
        <Btn style={{ marginTop: 4 }} onClick={() => closeModal?.()}>{t("forward_close")}</Btn>
      </div>
    </ModalRootAny>
  );
}

export function openForward(payload: ForwardPayload) {
  showModal(<ForwardModal payload={payload} />);
}
