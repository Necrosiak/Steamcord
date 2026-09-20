// Icônes SVG monochromes (issue #15) : remplacent les emojis couleur pour
// coller à l'UI SteamOS. Set Bootstrap Icons via react-icons (déjà en dép,
// tree-shaké au build) : 1em / currentColor → hérite taille et couleur du
// texte voisin. Les TOASTS gardent leurs emojis (texte brut, pas de JSX).
import {
  BsArrowDownUp, BsArrowRepeat, BsBell, BsBoxArrowRight, BsCamera, BsCameraVideo,
  BsChatDots, BsCheckCircle, BsChevronDown, BsChevronUp, BsCircle, BsCircleFill, BsController,
  BsDisplay, BsExclamationTriangle, BsEye, BsEyeSlash, BsFilm, BsFolder2Open, BsGear,
  BsGithub, BsHeadphones, BsHouseDoor, BsInfoCircle, BsJoystick,
  BsLayoutSidebarInsetReverse, BsLink45Deg, BsMic, BsMicMute, BsMicMuteFill, BsMoon, BsPaperclip,
  BsPerson, BsPhone, BsSlashCircle, BsSoundwave, BsTelephone,
  BsVolumeMuteFill, BsVolumeUp,
} from "react-icons/bs";
import { useMemo } from "react";

type IcProps = { size?: number | string; color?: string; style?: any };

// ── Logo Steamcord ──────────────────────────────────────────────────────────
// Transcription de `assets/logo.svg`, qui est la SOURCE : toute retouche se
// fait là-bas d'abord, puis ici et dans le PNG (`magick -density 768
// assets/logo.svg -resize 512x512 -depth 8 -strip assets/logo.png`).
// Monochrome, sans fond ni contour, en `currentColor` : il doit vivre à côté
// des icônes Bootstrap du panneau et prendre la couleur du texte voisin. Le S
// et le C sont de vrais TROUS dans la silhouette (un masque), pas des lettres
// sombres posées dessus — peintes, elles disparaîtraient sur fond clair. Ce
// sont des tracés, jamais du <text> : rien ne dépend des polices de Steam.
// L'id du masque est unique par instance ; un id fixe serait posé tel quel
// dans le DOM de l'UI Steam, et deux logos affichés en même temps l'y
// mettraient deux fois.
let logoSeq = 0;
export function SteamcordLogo({ size = 30 }: { size?: number }) {
  const cut = useMemo(() => `sc-logo-cut-${++logoSeq}`, []);
  return <svg width={size} height={size} viewBox="0 0 64 64" fill="none" role="img" aria-label="Steamcord" style={{ flexShrink: 0 }}>
    <mask id={cut} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
      <rect width="64" height="64" fill="#000" />
      <g transform="translate(7 11) scale(.82)">
        <path fill="#fff" d="M13 6C18 4 23 3 26 3L28 7C30.6 6.6 33.4 6.6 36 7L38 3C41 3 46 4 51 6C58 16 61 26 60 37C55 41 50 43 45 44L42 39C44.5 38.2 46.8 37 48.8 35.5L47.6 34.6C37.5 39.4 26.5 39.4 16.4 34.6L15.2 35.5C17.2 37 19.5 38.2 22 39L19 44C14 43 9 41 4 37C3 26 6 16 13 6Z" />
        <path stroke="#000" strokeWidth={4.2} strokeLinecap="round" strokeLinejoin="round" d="M28.2 17.4C26.9 15.9 24.9 15.4 23.1 15.4C20.4 15.4 18.4 16.8 18.4 19C18.4 21.3 20.4 22 23 22.8C25.8 23.6 27.9 24.4 27.9 27C27.9 29.3 25.8 30.8 22.9 30.8C20.6 30.8 18.8 30 17.6 28.6" />
        <path stroke="#000" strokeWidth={4.2} strokeLinecap="round" strokeLinejoin="round" d="M46.2 17.9C45 16.3 42.9 15.4 40.6 15.4C36.2 15.4 33.2 18.6 33.2 23.1C33.2 27.6 36.2 30.8 40.6 30.8C42.9 30.8 45 29.9 46.2 28.3" />
      </g>
      <circle cx="58.6" cy="24.3" r="4.7" fill="#000" />
    </mask>
    <ellipse cx="32" cy="33" rx="28" ry="10.5" stroke="currentColor" strokeWidth={1.8} opacity={0.75} transform="rotate(-18 32 33)" />
    <rect width="64" height="64" fill="currentColor" mask={`url(#${cut})`} />
    <circle cx="58.6" cy="24.3" r="3.1" fill="currentColor" />
  </svg>;
}

const mk = (C: any) => (p: IcProps = {}) => (
  <C size={p.size} color={p.color}
     style={{ verticalAlign: "-0.125em", flexShrink: 0, ...(p.style || {}) }} />
);

export const IcMic = mk(BsMic);
export const IcMicMute = mk(BsMicMute);
export const IcMicMuteFill = mk(BsMicMuteFill);
export const IcSpeaker = mk(BsVolumeUp);
export const IcSpeakerMuteFill = mk(BsVolumeMuteFill);
export const IcHeadphones = mk(BsHeadphones);
export const IcMonitor = mk(BsDisplay);
export const IcCamera = mk(BsCamera);
export const IcCameraVideo = mk(BsCameraVideo);
export const IcFilm = mk(BsFilm);
export const IcPhone = mk(BsTelephone);
export const IcController = mk(BsController);
export const IcJoystick = mk(BsJoystick);
export const IcLink = mk(BsLink45Deg);
export const IcPaperclip = mk(BsPaperclip);
export const IcRefresh = mk(BsArrowRepeat);
export const IcGear = mk(BsGear);
export const IcWarn = mk(BsExclamationTriangle);
export const IcBell = mk(BsBell);
export const IcFolder = mk(BsFolder2Open);
export const IcChat = mk(BsChatDots);
export const IcUser = mk(BsPerson);
export const IcHome = mk(BsHouseDoor);
export const IcLogout = mk(BsBoxArrowRight);
export const IcCheckCircle = mk(BsCheckCircle);
export const IcSmartphone = mk(BsPhone);
export const IcInfo = mk(BsInfoCircle);
export const IcGithub = mk(BsGithub);
export const IcSoundboard = mk(BsSoundwave);
export const IcChevronDown = mk(BsChevronDown);
export const IcChevronUp = mk(BsChevronUp);
export const IcEye = mk(BsEye);
export const IcEyeSlash = mk(BsEyeSlash);
export const IcReorder = mk(BsArrowDownUp);
// Le panneau d'accès rapide vu depuis la vue agrandie (bouton de retour).
export const IcPanel = mk(BsLayoutSidebarInsetReverse);

// Statuts Discord : pastilles teintées façon Discord (rond plein / lune /
// cercle barré / cercle creux) — la couleur porte le sens, pas l'emoji.
const statusIcons: Record<string, any> = {
  online: mk(BsCircleFill),
  idle: mk(BsMoon),
  dnd: mk(BsSlashCircle),
  invisible: mk(BsCircle),
};
export const IcStatus = ({ id, color, size, style }: IcProps & { id: string }) => {
  const C = statusIcons[id] || statusIcons.online;
  return <C color={color} size={size} style={style} />;
};
