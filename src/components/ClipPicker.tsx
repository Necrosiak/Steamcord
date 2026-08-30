import { Focusable, ModalRoot, showModal } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { Btn } from "./TextChat";
import { IcFilm } from "./Icons";
import { focusHalo, ACCENT, IconBtn } from "./Styled";

const ModalRootAny = ModalRoot as any;

// #40 : @Havok027 sortait ses clips vers son téléphone pour les reposter sur
// Discord. Steam n'aide pas — ses enregistrements vivent en fragments .m4s,
// illisibles tels quels ; c'est le clip EXPORTÉ qu'on peut envoyer. Le backend
// ratisse donc les dossiers vidéo et ne rend que des jetons, jamais des chemins.
interface Clip {
  token: string; name: string; size: number; mtime: number;
  kind: "steam" | "file"; appid: string; will_convert: boolean; has_thumb: boolean;
}

// Un clip Steam s'appelle « clip_2584270_20260825_073545 » : illisible. On
// résout l'appid en nom de jeu par le store Steam, comme le fait déjà le QAM
// pour les jaquettes, et on retombe sur la date si le jeu est inconnu.
function clipGame(c: Clip): string {
  if (c.kind !== "steam") return c.name;
  try {
    const ov = (window as any).appStore?.GetAppOverviewByAppID?.(Number(c.appid));
    if (ov?.display_name) return ov.display_name;
  } catch (_) { /* store absent hors gamemode */ }
  return t("clip_steam");
}

function clipWhen(c: Clip): string {
  const d = new Date(c.mtime * 1000);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString().slice(0, 5);
}

const human = (n: number) =>
  n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " Mio" : Math.round(n / 1024) + " Kio";

function ClipTile({ clip, busy, onClick }: { clip: Clip; busy: boolean; onClick: () => void }) {
  const [focused, setFocused] = useState(false);
  const [thumb, setThumb] = useState<string>("");
  // Plus de refus sur la taille : un clip Steam de 25 s pèse ~32 Mio, soit
  // trois fois la limite de Discord, donc les griser reviendrait à n'en
  // proposer aucun. Ils sont assemblés puis compressés à l'envoi.
  const dead = busy;

  // La vignette est demandée PAR TUILE : l'originale de Steam fait 1920x1080
  // pour ~290 Kio, les joindre toutes à la liste ferait transiter plusieurs
  // Mio en base64 sur la websocket qui sert aussi la voix.
  useEffect(() => {
    if (!clip.has_thumb) return;
    let alive = true;
    call<[string], string>("clip_thumb", clip.token)
      .then((d) => { if (alive && d) setThumb(d); })
      .catch(() => { /* tuile neutre, pas d'erreur à l'écran pour si peu */ });
    return () => { alive = false; };
  }, [clip.token]);

  return (
    <Btn
      disabled={dead}
      onClick={onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        flex: "1 1 0", minWidth: 0, padding: 0, minHeight: 0, borderRadius: 6,
        overflow: "hidden", opacity: dead ? 0.45 : 1, textAlign: "left",
        display: "flex", flexDirection: "column",
        ...focusHalo(ACCENT, focused),
      }}
    >
      {thumb ? (
        <img src={thumb} style={{ width: "100%", height: 90, objectFit: "cover", display: "block" }} />
      ) : (
        // Vidéo hors Steam, ou vignette illisible : un aplat plutôt qu'un trou,
        // pour que la grille garde des tuiles de même hauteur.
        <div style={{
          width: "100%", height: 90, display: "flex", alignItems: "center",
          justifyContent: "center", background: "rgba(255,255,255,0.07)", opacity: 0.5,
        }}><IcFilm /></div>
      )}
      <div style={{ padding: "4px 6px", width: "100%", boxSizing: "border-box" }}>
        <div style={{
          fontSize: 12, fontWeight: 600, overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{clipGame(clip)}</div>
        <div style={{ fontSize: 10, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {clipWhen(clip)} · {human(clip.size)}
          {clip.will_convert ? " · " + t("clip_will_convert") : ""}
        </div>
      </div>
    </Btn>
  );
}

function PagerBtn({ label, title, disabled, onClick }: {
  label: string; title: string; disabled: boolean; onClick: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Btn
      disabled={disabled}
      title={title}
      onClick={onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        minWidth: 44, padding: "2px 10px", minHeight: 0, borderRadius: 6,
        fontSize: 18, lineHeight: "24px", opacity: disabled ? 0.35 : 1,
        ...focusHalo(ACCENT, focused),
      }}
    >{label}</Btn>
  );
}

function ClipPickerModal({ channelId, closeModal }: { channelId: string; closeModal?: () => void }) {
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    call<[], Clip[]>("list_videos").then(setClips).catch(() => setClips([]));
  }, []);

  // L'assemblage et la compression prennent une dizaine de secondes sur un clip
  // de 25 s (le BC-250 n'a aucun encodeur matériel). Fermer la fenêtre tout de
  // suite donnerait l'impression qu'il ne s'est rien passé : on garde la main
  // et on affiche l'état jusqu'au retour du backend.
  const send = async (c: Clip) => {
    setBusy(true);
    setStatus(c.will_convert ? t("clip_converting") : t("clip_sending"));
    let ok = false;
    try { ok = !!(await call("send_video", channelId, c.token)); } catch (_) { ok = false; }
    if (ok) { closeModal?.(); return; }
    setBusy(false);
    setStatus(t("clip_failed"));
  };

  // Même recette de grille que le sélecteur de captures : des rangées de N
  // tuiles dans un Focusable "row". Trois par rangée et non quatre — chaque
  // tuile porte un libellé sous l'image, il lui faut de la largeur pour rester
  // lisible.
  const ROW = 3;
  // Une page = 3 rangées, soit 9 tuiles. Au-delà, la grille devient un mur
  // d'images qu'il faut parcourir à la manette pour retrouver un clip : on
  // pagine, et la vignette n'est demandée au backend que pour les tuiles
  // réellement affichées — 100 clips ne déclenchent pas 100 passes ffmpeg.
  const PER_PAGE = ROW * 3;
  const total = clips ? Math.max(1, Math.ceil(clips.length / PER_PAGE)) : 1;
  const cur = Math.min(page, total - 1);
  const shown = clips ? clips.slice(cur * PER_PAGE, cur * PER_PAGE + PER_PAGE) : [];
  const rows: Clip[][] = [];
  for (let i = 0; i < shown.length; i += ROW) rows.push(shown.slice(i, i + ROW));

  return (
    <ModalRootAny
      closeModal={closeModal}
      onCancel={() => closeModal?.()}
      bAllowFullSize
    >
      <div style={{ maxWidth: 720, margin: "0 auto", width: "100%" }}>
        <div style={{
          fontSize: 16, fontWeight: 600, textAlign: "center", marginBottom: 10,
          padding: "8px 12px", borderRadius: 8, background: "rgba(255,255,255,0.06)",
        }}>{t("share_clip")}</div>

        {clips === null && (
          <div style={{ opacity: 0.6, fontSize: 13, textAlign: "center", padding: 12 }}>{t("loading")}</div>
        )}
        {clips !== null && clips.length === 0 && (
          <div style={{ opacity: 0.5, fontSize: 13, textAlign: "center", padding: 12 }}>{t("clip_none")}</div>
        )}
        {status ? (
          <div style={{ fontSize: 12, opacity: 0.85, textAlign: "center", marginBottom: 6 }}>{status}</div>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "70vh", overflowY: "auto" }}>
          {rows.map((row, i) => (
            <Focusable key={i} flow-children="row" style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
              {row.map((c) => (
                <ClipTile key={c.token} clip={c} busy={busy} onClick={() => send(c)} />
              ))}
              {row.length < ROW && Array.from({ length: ROW - row.length }).map((_, j) => (
                <div key={"pad" + j} style={{ flex: "1 1 0" }} />
              ))}
            </Focusable>
          ))}
        </div>

        {clips && clips.length > PER_PAGE ? (
          <Focusable
            flow-children="row"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              gap: 10, marginTop: 8,
            }}
          >
            <PagerBtn
              label="‹"
              title={t("clip_prev_page")}
              disabled={cur === 0}
              onClick={() => setPage(cur - 1)}
            />
            <span style={{ fontSize: 12, opacity: 0.8, minWidth: 90, textAlign: "center" }}>
              {t("clip_page").replace("{n}", String(cur + 1)).replace("{total}", String(total))}
            </span>
            <PagerBtn
              label="›"
              title={t("clip_next_page")}
              disabled={cur >= total - 1}
              onClick={() => setPage(cur + 1)}
            />
          </Focusable>
        ) : null}
      </div>
    </ModalRootAny>
  );
}

export function ClipPickerButton({ channelId }: { channelId: string }) {
  return (
    <IconBtn
      onClick={() => showModal(<ClipPickerModal channelId={channelId} />)}
      title={t("share_clip")}
    >
      <IcFilm />
    </IconBtn>
  );
}
