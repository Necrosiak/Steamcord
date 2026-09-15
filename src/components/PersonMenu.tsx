// Menu Y sur une personne (Amis, Membres, MP) et sa fiche profil. Tri fait avec
// le user le 15/09 à partir du menu de Discord : on garde ce qui se fait bien à
// la manette (profil, message, appel, fermer le MP, amitié, blocage) ; notes,
// épingles, favoris, applications, invitations et « ignorer » sont écartés.
import { ConfirmModal, DialogButton, Focusable, Menu, MenuItem, ModalRoot, showContextMenu, showModal } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t, errText } from "../i18n";
import type { OpenChat } from "./ExpandedNav";

const ModalRootAny = ModalRoot as any;
const Button = DialogButton as any;

// RelationshipStore : 0 aucune, 1 ami, 2 bloqué, 3 demande reçue, 4 demande envoyée.
export type PersonRef = { id: string; name: string; relationship?: number; dmChannelId?: string };

const openDmThen = async (id: string, then: (channelId: string) => void | Promise<any>) => {
  const r: any = await call("open_dm", id);
  if (r?.id) await then(r.id);
};

function confirmThen(title: string, text: string, action: () => Promise<any>, onDone?: () => void) {
  showModal(<ConfirmModal
    strTitle={title}
    strDescription={text}
    strOKButtonText={t("confirm_yes")}
    strCancelButtonText={t("friend_cancel")}
    bDestructiveWarning
    onOK={() => { action().then(() => onDone?.()).catch(() => {}); }}
  />);
}

export function openPersonMenu(p: PersonRef, openChat: OpenChat, onChanged?: () => void) {
  const rel = p.relationship ?? 0;
  const run = (fn: () => Promise<any>) => () => { fn().then(() => onChanged?.()).catch(() => {}); };
  showContextMenu(
    <Menu label={p.name}>
      <MenuItem onSelected={() => showModal(<ProfileModal userId={p.id} name={p.name} openChat={openChat} />)}>{t("menu_profile")}</MenuItem>
      <MenuItem onSelected={() => { openDmThen(p.id, (id) => openChat(id, p.name, true)).catch(() => {}); }}>{t("menu_message")}</MenuItem>
      <MenuItem onSelected={() => { openDmThen(p.id, (id) => call("dm_call", id, false)).catch(() => {}); }}>{t("call")}</MenuItem>
      {p.dmChannelId && <MenuItem onSelected={run(() => call("close_dm", p.dmChannelId))}>{t("menu_close_dm")}</MenuItem>}
      {rel === 0 && <MenuItem onSelected={run(() => call("friend_add", p.id))}>{t("member_add")}</MenuItem>}
      {rel === 3 && <MenuItem onSelected={run(() => call("friend_accept", p.id))}>{t("friend_accept")}</MenuItem>}
      {rel === 4 && <MenuItem onSelected={run(() => call("friend_remove", p.id))}>{t("friend_cancel")}</MenuItem>}
      {rel === 1 && <MenuItem onSelected={() => confirmThen(t("menu_remove_friend"), t("confirm_remove_friend", { name: p.name }), () => call("friend_remove", p.id), onChanged)}>{t("menu_remove_friend")}</MenuItem>}
      {rel === 2
        ? <MenuItem onSelected={run(() => call("friend_remove", p.id))}>{t("menu_unblock")}</MenuItem>
        : <MenuItem onSelected={() => confirmThen(t("menu_block"), t("confirm_block", { name: p.name }), () => call("friend_block", p.id), onChanged)}>{t("menu_block")}</MenuItem>}
    </Menu>
  );
}

const sectionTitle = (label: string) => <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: .7, opacity: .55, margin: "10px 0 5px" }}>{label.toUpperCase()}</div>;

function ProfileModal({ userId, name, openChat, closeModal }: { userId: string; name: string; openChat: OpenChat; closeModal?: () => void }) {
  const [p, setP] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call("get_profile", userId).then((r) => setP(r)).catch((e) => setError(errText(e)));
  }, [userId]);
  const avatar = (id: string, hash?: string | null, size = 72) => <img
    src={hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.webp?size=128` : "https://cdn.discordapp.com/embed/avatars/0.png"}
    width={size} height={size} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  return <ModalRootAny closeModal={closeModal} onCancel={() => closeModal?.()}>
    {error ? <div style={{ color: "#ff7474" }}>{error}</div>
      : !p ? <div style={{ opacity: .65 }}>{t("loading")}</div>
      : <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        {p.banner
          ? <img src={`https://cdn.discordapp.com/banners/${p.id}/${p.banner}.webp?size=600`} style={{ width: "100%", height: 110, objectFit: "cover", borderRadius: 8 }} />
          : <div style={{ height: 70, borderRadius: 8, background: p.banner_color || "linear-gradient(135deg,#5865f2,#8b5cf6)" }} />}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: -30, padding: "0 10px" }}>
          <span style={{ border: "4px solid #1b1f27", borderRadius: "50%", display: "flex" }}>{avatar(p.id, p.avatar)}</span>
          <span style={{ minWidth: 0, marginTop: 30 }}>
            <span style={{ display: "block", fontSize: 20, fontWeight: 800 }}>{p.global_name || p.username || name}</span>
            <span style={{ display: "block", fontSize: 12, opacity: .6 }}>@{p.username}</span>
          </span>
        </div>
        {p.bio && <>{sectionTitle(t("profile_about"))}<div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap", maxHeight: "18vh", overflowY: "auto" }}>{p.bio}</div></>}
        {sectionTitle(`${t("profile_mutual_guilds")} — ${p.mutual_guilds.length}`)}
        <div style={{ fontSize: 13, opacity: .85 }}>{p.mutual_guilds.length ? p.mutual_guilds.map((g: any) => g.name).join(" · ") : t("profile_none")}</div>
        {sectionTitle(`${t("profile_mutual_friends")} — ${p.mutual_friends_count}`)}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {p.mutual_friends.length ? p.mutual_friends.map((f: any) => <span key={f.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>{avatar(f.id, f.avatar, 22)}{f.global_name || f.username}</span>)
            : <span style={{ fontSize: 13, opacity: .85 }}>{t("profile_none")}</span>}
        </div>
        <Focusable flow-children="row" style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <Button onClick={() => { closeModal?.(); openDmThen(p.id, (id) => openChat(id, p.global_name || p.username || name, true)).catch(() => {}); }}>{t("menu_message")}</Button>
          <Button onClick={() => { openDmThen(p.id, (id) => call("dm_call", id, false)).catch(() => {}); }}>{t("call")}</Button>
        </Focusable>
      </div>}
  </ModalRootAny>;
}
