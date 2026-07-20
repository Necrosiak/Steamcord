// Icônes SVG monochromes (issue #15) : remplacent les emojis couleur pour
// coller à l'UI SteamOS. Set Bootstrap Icons via react-icons (déjà en dép,
// tree-shaké au build) : 1em / currentColor → hérite taille et couleur du
// texte voisin. Les TOASTS gardent leurs emojis (texte brut, pas de JSX).
import {
  BsArrowRepeat, BsBell, BsBoxArrowRight, BsCamera, BsCameraVideo,
  BsChatDots, BsCheckCircle, BsChevronDown, BsCircle, BsCircleFill, BsController,
  BsDisplay, BsExclamationTriangle, BsFilm, BsFolder2Open, BsGear,
  BsGithub, BsHeadphones, BsHouseDoor, BsInfoCircle, BsJoystick,
  BsLink45Deg, BsMic, BsMicMute, BsMicMuteFill, BsMoon, BsPaperclip,
  BsPerson, BsPhone, BsSlashCircle, BsSoundwave, BsTelephone,
  BsVolumeMuteFill, BsVolumeUp,
} from "react-icons/bs";

type IcProps = { size?: number | string; color?: string; style?: any };

// Alignement sur la ligne de base du texte (les SVG react-icons débordent
// sous la baseline sinon) + jamais écrasées par un conteneur flex.
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
