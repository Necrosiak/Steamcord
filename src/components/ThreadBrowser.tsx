// Fils d'un salon texte / publications d'un forum (#100) : recherche par titre,
// filtre par tags, pages suivantes, création. Un seul composant pour le QAM et
// la vue agrandie : chacun fournit sa rangée (`Row`) et son bouton (`Btn`),
// pour garder le style de la liste qui l'accueille.
import { DialogButton, Focusable, ModalRoot, showModal, TextField } from "@decky/ui";
import { useState } from "react";
import { t, errCode, errText } from "../i18n";
import { ACCENT, focusHalo } from "./Styled";
import { IcThread } from "./Icons";
import { ForumTag, ThreadInfo, ThreadParent, createThread, useDebounced, useThreads } from "../threads";

export type RowComp = (p: { onClick: () => void; active?: boolean; children: any }) => any;
export type BtnComp = (p: { onClick: () => void; on?: boolean; disabled?: boolean; children: any }) => any;

const ModalRootAny = ModalRoot as any;
const ONE_LINE = { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" } as const;
const MAX_TAGS = 5;

// Les messages d'erreur du client Discord ont un code stable, traduit ici.
const THREAD_ERRORS = ["thread_bad_name", "thread_too_long", "thread_need_message", "thread_need_tag", "thread_not_allowed"];
function threadErr(e: unknown): string {
  const s = errCode(e);
  const code = THREAD_ERRORS.find((c) => s.includes(c));
  return code ? t(code) : errText(e);
}

function Chip({ on, onClick, size, children }: { on: boolean; onClick: () => void; size: number; children: any }) {
  const [focused, setFocused] = useState(false);
  return <Focusable noFocusRing onActivate={onClick} onClick={onClick} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    onGamepadFocus={() => setFocused(true)} onGamepadBlur={() => setFocused(false)}
    style={{ padding: `${Math.round(size * 0.3)}px ${Math.round(size * 0.75)}px`, borderRadius: 999, fontSize: size, lineHeight: 1.2, maxWidth: "100%", ...ONE_LINE,
      background: on ? ACCENT : focused ? "rgba(88,101,242,.45)" : "rgba(255,255,255,.08)", ...focusHalo(ACCENT, focused) }}>
    {children}
  </Focusable>;
}

const tagLabel = (tag: ForumTag) => (tag.emoji ? tag.emoji + " " : "") + tag.name;

function TagChips({ tags, selected, toggle, size }: { tags: ForumTag[]; selected: string[]; toggle: (id: string) => void; size: number }) {
  return <Focusable flow-children="row" style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
    {tags.map((tag) => <Chip key={tag.id} size={size} on={selected.includes(tag.id)} onClick={() => toggle(tag.id)}>{tagLabel(tag)}</Chip>)}
  </Focusable>;
}

// Fenêtre de création : titre, message (obligatoire en forum), tags.
function NewThreadModal({ channelId, channelName, parent, onCreated, closeModal }: {
  channelId: string; channelName: string; parent: ThreadParent; onCreated: (th: ThreadInfo) => void; closeModal?: () => void;
}) {
  const forum = parent.kind === "forum";
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string) => setTags((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : cur.length < MAX_TAGS ? [...cur, id] : cur);
  const missing = !name.trim() ? "thread_bad_name" : forum && !content.trim() ? "thread_need_message" : parent.require_tag && tags.length === 0 ? "thread_need_tag" : null;
  const submit = () => {
    if (busy) return;
    if (missing) { setError(t(missing)); return; }
    setBusy(true); setError(null);
    createThread(channelId, name.trim(), content.trim(), tags)
      .then((th) => { closeModal?.(); onCreated(th); })
      .catch((e) => { setError(threadErr(e)); setBusy(false); });
  };
  return <ModalRootAny closeModal={closeModal} onCancel={() => closeModal?.()}>
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <div style={{ fontSize: 17, fontWeight: 700, ...ONE_LINE }}>{t(forum ? "forum_new_post" : "thread_new")} · {channelName}</div>
      <TextField label={t("thread_title")} value={name} onChange={(e: any) => setName(String(e?.target?.value ?? "").slice(0, 100))} />
      <TextField label={t(forum ? "thread_message" : "thread_message_optional")} value={content} onChange={(e: any) => setContent(String(e?.target?.value ?? "").slice(0, 2000))} />
      {parent.tags.length > 0 && <>
        <div style={{ fontSize: 12, opacity: .7 }}>{t(parent.require_tag ? "thread_tags_required" : "thread_tags", { max: MAX_TAGS })}</div>
        <TagChips tags={parent.tags} selected={tags} toggle={toggle} size={13} />
      </>}
      {error && <div style={{ color: "#ff7474", fontSize: 13 }}>{error}</div>}
      <Focusable flow-children="row" style={{ display: "flex", gap: 8 }}>
        <DialogButton disabled={busy} onClick={submit}>{busy ? t("threads_loading") : t(forum ? "forum_publish" : "thread_create")}</DialogButton>
        <DialogButton onClick={() => closeModal?.()}>{t("forward_close")}</DialogButton>
      </Focusable>
    </div>
  </ModalRootAny>;
}

export function ThreadBrowser({ channelId, channelName, forum, onOpen, Row, Btn, size = 13 }: {
  channelId: string; channelName: string; forum: boolean; onOpen: (th: ThreadInfo) => void; Row: RowComp; Btn: BtnComp; size?: number;
}) {
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const name = useDebounced(query.trim(), 450);
  const { threads, parent, total, error, hasMore, loadingMore, more, reload } = useThreads(channelId, { name, tags });
  const filtered = !!name || tags.length > 0;
  const tagNames = new Map((parent?.tags ?? []).map((tag) => [tag.id, tagLabel(tag)]));
  const toggleTag = (id: string) => setTags((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  const note = (text: string, color?: string) => <div style={{ padding: "6px 4px", fontSize: size - 1, opacity: color ? 1 : .55, color }}>{text}</div>;
  const openNew = () => parent && showModal(<NewThreadModal channelId={channelId} channelName={channelName} parent={parent}
    onCreated={(th) => { reload(); onOpen(th); }} />);

  return <div style={{ display: "flex", flexDirection: "column", gap: 5, margin: "3px 0 6px" }}>
    <Focusable flow-children="row" style={{ display: "flex", gap: 5, alignItems: "flex-end" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <TextField label={t(forum ? "forum_search" : "threads_search")} value={query} onChange={(e: any) => setQuery(String(e?.target?.value ?? "").slice(0, 100))} />
      </div>
      {parent?.can_create && <Btn onClick={openNew}>+ {t(forum ? "forum_new_post" : "thread_new")}</Btn>}
    </Focusable>
    {(parent?.tags.length ?? 0) > 0 && <TagChips tags={parent!.tags} selected={tags} toggle={toggleTag} size={size - 1} />}
    {filtered && total != null && threads && note(t("threads_results", { count: total }))}
    {threads === null ? note(t("threads_loading"))
      : threads.length === 0 ? (error ? note(t("threads_error"), "#ff7474") : note(t(filtered ? "threads_no_match" : forum ? "forum_none" : "threads_none")))
      : <>
        {threads.map((th) => {
          const labels = (th.tags ?? []).map((id) => tagNames.get(id)).filter(Boolean).slice(0, 2).join(" · ");
          return <Row key={th.id} onClick={() => onOpen(th)}>
            <span style={{ opacity: .6, display: "flex", flexShrink: 0 }}><IcThread /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", ...ONE_LINE, opacity: th.archived ? .65 : 1 }}>{th.name}</span>
              {labels && <span style={{ display: "block", fontSize: size - 3, opacity: .55, ...ONE_LINE }}>{labels}</span>}
            </span>
            {th.archived ? <span style={{ opacity: .5, fontSize: size - 2, flexShrink: 0 }}>{t("thread_archived")}</span>
              : th.count ? <span style={{ opacity: .5, fontSize: size - 1, flexShrink: 0 }}>{th.count}</span> : null}
          </Row>;
        })}
        {hasMore && <Row onClick={more}><span style={{ flex: 1, textAlign: "center", opacity: .7 }}>{loadingMore ? t("threads_loading") : t("threads_more")}</span></Row>}
        {error && note(t("threads_error"), "#ff7474")}
      </>}
  </div>;
}
