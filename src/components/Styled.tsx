// Shared visual kit — same design language as the SkullKey / BC250-Toolkit
// plugins: focusable controls with a white halo + colored glow + a slight
// scale on gamepad focus, one accent color per section. Keeping every
// Steamcord control on this kit makes the three plugins read as one family.
import { DialogButton } from "@decky/ui";
import { useCallback, useState } from "react";
import { useQamUi } from "../qamUi";
import { IcChevronDown } from "./Icons";

const Btn = DialogButton as any;

// ── Modales « full-bleed » (grille multi-POV, plein écran vidéo) ─────────────
// ModalRoot contraint son contenu à ~573px de large (DialogContent_InnerWidth,
// mesuré au CDP sur écran 1500px : tuiles squelettiques). On déborde du cadre
// en largeur viewport, centré via la marge (les % de margin se réfèrent au
// parent). PAS de position:fixed : le dialog a un transform (animation) qui
// devient le containing block du fixed → contenu effondré (mesuré : 612×28).
export const FULL_BLEED = {
  width: "96vw", marginLeft: "calc((100% - 96vw) / 2)", boxSizing: "border-box" as const,
};

// Efface le chrome du dialog Steam autour d'un contenu full-bleed (panneau
// bleu/gris `DialogContent` rgb(14,20,27), ombre, bord — retour user : « c'est
// pas très beau le fond ») et remplace le voile plein écran (un DÉGRADÉ,
// background-image) par un fond sombre uni (l'UI Steam transparaissait trop).
// ⚠️ DEUX pièges de contexte, tous deux constatés en live au CDP :
//  • `document.getElementById` du contexte plugin NE VOIT PAS le document des
//    modales showModal (il vit dans la fenêtre Big Picture, pas dans celle du
//    SharedJSContext) → on part du NŒUD RÉEL fourni par le ref React du
//    marqueur, et tout passe par SON ownerDocument ;
//  • le `window` global du contexte plugin fait 1×1px (cf. useFillHeight) →
//    mesures via ownerDocument.defaultView uniquement.
// Styles inline !important : gagnent sur les classes minifiées de Steam sans
// dépendre de leurs noms, et Steam ne re-render pas ces nœuds pendant la vie
// de la modale (vérifié en patchant en live au CDP).
// Opacité du voile, réglable (#52 : « the "full" view … is too transparent for
// my liking »). 0.94 reste le défaut — les 6 % restants suffisent à laisser
// transparaître un jeu clair ou le magasin BPM, ce qui gêne à la lecture.
// Le curseur vit dans l'onglet Réglages, qui existe AUSSI dans la vue agrandie :
// on garde donc le nœud peint pour le repeindre pendant que l'utilisateur règle,
// sinon il faudrait fermer et rouvrir la vue pour voir ce qu'on change.
let veilAlpha = 0.94;

// ⚠️ #52 (retour du 23/09) : les nœuds qu'on repeint NE SONT PAS à nous. Le fond
// `.ModalOverlayBackground` et le premier ancêtre plein écran (le fond dégradé de
// tout Big Picture) survivent à la fermeture de la modale — Steam les réutilise.
// Mesuré au CDP : après Close(), le style en ligne restait, et en jeu le QAM ou une
// notification ressortait ce noir par-dessus la partie. On note donc chaque
// propriété touchée avec sa valeur d'origine, et on la rend dès que plus aucune de
// nos modales ouvertes ne se sert du nœud.
type Touched = { markers: Set<HTMLElement>; saved: Map<string, [string, string]>; veil: boolean };
const touched = new Map<HTMLElement, Touched>();

const setOwned = (el: HTMLElement, marker: HTMLElement, prop: string, value: string, veil = false) => {
  let t = touched.get(el);
  if (!t) { t = { markers: new Set(), saved: new Map(), veil: false }; touched.set(el, t); }
  t.markers.add(marker);
  if (veil) t.veil = true;
  if (!t.saved.has(prop)) t.saved.set(prop, [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
  el.style.setProperty(prop, value, "important");
};

const releaseClosed = () => {
  touched.forEach((t, el) => {
    t.markers.forEach((m) => { if (!m.isConnected) t.markers.delete(m); });
    if (t.markers.size) return;
    t.saved.forEach(([v, prio], prop) => {
      if (v) el.style.setProperty(prop, v, prio); else el.style.removeProperty(prop);
    });
    touched.delete(el);
  });
};

const paintVeil = (el: HTMLElement | null | undefined, marker: HTMLElement) => {
  if (el) setOwned(el, marker, "background", `rgba(0, 0, 0, ${veilAlpha})`, true);
};

export const setVeilAlpha = (a: number) => {
  veilAlpha = Math.min(1, Math.max(0.6, a));
  releaseClosed();
  touched.forEach((t, el) => {
    if (t.veil) el.style.setProperty("background", `rgba(0, 0, 0, ${veilAlpha})`, "important");
  });
};

// ⚠️ Le calque qui assombrit VRAIMENT l'arrière-plan n'est pas dans notre chaîne
// d'ancêtres : c'est celui de Steam, `.ModalOverlayBackground`, FRÈRE de notre
// modale sous `FullModalOverlay`. Mesuré au CDP le 22/09 : on repeignait bien le
// premier ancêtre plein écran (son style en ligne était là, à noir opaque) — sauf
// que ce conteneur héberge AUSSI l'interface Steam, qui se dessine par-dessus son
// fond. Le réglage ne cachait donc rigoureusement rien, retour user à l'appui
// (« on voit encore tout derrière »). Les noms de classe de Steam sont minifiés,
// mais ces deux-là ne le sont pas.
const backdropOf = (marker: HTMLElement): HTMLElement | null => {
  let p: HTMLElement | null = marker.parentElement;
  for (let i = 0; p && i < 14; i++, p = p.parentElement) {
    if (p.classList.contains("ModalOverlayContent") && p.classList.contains("active")) {
      return p.parentElement?.querySelector<HTMLElement>(".ModalOverlayBackground") || null;
    }
  }
  return null;
};

const hideDialogChromeFrom = (marker: HTMLElement) => {
  if (!marker.isConnected) return;
  // Le vrai fond d'abord : c'est lui qui décide de ce qu'on voit derrière.
  paintVeil(backdropOf(marker), marker);
  const win = marker.ownerDocument?.defaultView;
  if (!win) return;
  let p: HTMLElement | null = marker.parentElement;
  for (let i = 0; p && i < 12; i++, p = p.parentElement) {
    const cs = win.getComputedStyle(p);
    const painted = cs.backgroundColor !== "rgba(0, 0, 0, 0)" || cs.backgroundImage !== "none" || cs.boxShadow !== "none";
    if (!painted) continue;
    if (p.getBoundingClientRect().width >= win.innerWidth * 0.98) {
      // Premier ancêtre plein écran peint = le voile : fond sombre net, stop.
      // (0.94 par défaut : à 0.88 les visuels clairs du magasin BPM
      // transparaissaient encore — vu sur capture.)
      paintVeil(p, marker);
      break;
    }
    setOwned(p, marker, "background", "transparent");
    setOwned(p, marker, "box-shadow", "none");
    setOwned(p, marker, "border", "none");
  }
};

// Ref à poser sur un marqueur `<div ref={chromeHideMarkerRef} style={{display:
// "none"}} />` dans le contenu de la modale : plusieurs passes, l'animation
// d'ouverture bouge encore les mesures au montage (même motif que
// useFillHeight) ; les passes sur une modale déjà fermée se voient à
// isConnected et ne font rien. Au démontage (ref appelé avec null), le marqueur
// est encore dans le DOM et l'animation de fermeture peut le garder un instant →
// on rend les styles en plusieurs passes elles aussi.
export const chromeHideMarkerRef = (el: HTMLDivElement | null) => {
  if (!el) { [0, 400, 1200].forEach((ms) => setTimeout(releaseClosed, ms)); return; }
  [0, 300, 800].forEach((ms) => setTimeout(() => hideDialogChromeFrom(el), ms));
};

// Hauteur d'une liste scrollable qui remplit le QAM JUSQU'EN BAS SANS déborder,
// quelle que soit la machine : mesurée depuis la position réelle du conteneur
// (getBoundingClientRect) — un maxHeight en dur (280px historique) laissait un
// grand vide sous les listes. ⚠️ PIÈGE MESURÉ AU CDP (19/07) : le code des
// plugins Decky tourne dans le SharedJSContext dont la fenêtre fait 1×1 px —
// le `window` global est INUTILISABLE pour mesurer le QAM. Le DOM du panneau,
// lui, vit dans la fenêtre QuickAccess (766 pt de haut sur cette machine,
// unités logiques dpr≈1.28 — indépendant de la résolution physique) → on
// mesure TOUT via la fenêtre du document de l'élément (ownerDocument.
// defaultView). `bottom` : la légende manette (A/B) est HORS de la fenêtre
// QuickAccess (vérifié : scrollHeight == innerHeight == 766) → une petite
// marge de respiration suffit.
export function useFillHeight(min = 180, bottom = 12) {
  const [height, setHeight] = useState<number>(min);
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const win = el.ownerDocument?.defaultView || window;
    let timer: any = null;
    const compute = () => {
      // Auto-nettoyage : les vues du QAM montent/démontent souvent, et un ref
      // callback ne repasse pas forcément par null — listener + interval se
      // retirent tout seuls dès que l'élément a quitté le DOM.
      if (!el.isConnected) {
        win.removeEventListener("resize", compute);
        if (timer) { clearInterval(timer); timer = null; }
        return;
      }
      const top = el.getBoundingClientRect().top;
      const avail = Math.floor(win.innerHeight - top - bottom);
      // Garde anti-débordement/anti-bogue : pendant une frame de layout ou
      // l'animation d'ouverture, top peut être 0/négatif (hauteur énorme) et
      // la fenêtre peut être minuscule (hauteur négative) → on n'écrit que des
      // mesures plausibles et on retentera au prochain tick.
      if (top <= 0 || avail <= 0) return;
      setHeight(avail > min ? avail : min);
    };
    // Au montage le QAM anime encore son ouverture → plusieurs passes, puis
    // re-mesure périodique : si le contenu AU-DESSUS de la liste change de
    // hauteur (bannière d'erreur, boutons contextuels), la liste se recale.
    setTimeout(compute, 0);
    setTimeout(compute, 300);
    timer = setInterval(compute, 1500);
    win.addEventListener("resize", compute);
  }, []);
  return { ref, height };
}

// Discord blurple — Steamcord's primary accent.
export const ACCENT = "#5865f2";
// Semantic section colors reused across the panel.
export const DANGER = "#ed4245";   // stop / disconnect / logout
export const ONLINE = "#23a55a";   // active / online

// The Steam DialogButton's native focus paints a light background + dark text
// → our forced-white text becomes unreadable. Every control drives its own
// focus instead: white ring + colored glow + a slight pop. `focusHalo` is the
// single source of truth for that look, spread into a control's style.
export function focusHalo(color: string, focused: boolean, scale = 1.02) {
  const c = color || ACCENT;
  return {
    boxShadow: focused ? `0 0 0 2px #fff, 0 0 8px 1px ${c}` : "none",
    transform: focused ? `scale(${scale})` : "scale(1)",
    transition: "box-shadow .08s ease, transform .08s ease",
    // position:relative makes zIndex effective so a focused control (and its
    // glow) lifts above tightly-packed flex siblings instead of being overpainted.
    position: "relative" as const,
    zIndex: focused ? 1 : 0,
  };
}

// Clickable card: colored background when active, white halo + colored glow on
// gamepad focus. Mirrors SkullKey's CardBtn.
export function CardBtn({ active, focused, color, disabled, center, big, onClick, onFocus, onBlur, onGamepadFocus, onGamepadBlur, children }: any) {
  const { px } = useQamUi();
  const c = color || ACCENT;
  return (
    <Btn
      disabled={disabled}
      onClick={onClick}
      onFocus={onFocus}
      onBlur={onBlur}
      onGamepadFocus={onGamepadFocus}
      onGamepadBlur={onGamepadBlur}
      style={{
        display: "flex", alignItems: "center", justifyContent: center ? "center" : "flex-start",
        gap: px(8), width: "100%", minWidth: 0,
        padding: big ? `${px(12)}px ${px(14)}px` : `${px(8)}px ${px(10)}px`,
        margin: 0, minHeight: px(big ? 44 : 36), boxSizing: "border-box",
        overflow: "visible", lineHeight: 1.2,
        borderRadius: px(6), color: "#fff", fontSize: px(big ? 14 : 13), fontWeight: active ? 700 : 400,
        background: active ? c : "rgba(255,255,255,0.05)",
        border: active ? "1px solid " + c : "1px solid transparent",
        opacity: disabled ? 0.5 : 1,
        ...focusHalo(c, focused),
      }}
    >
      {children}
    </Btn>
  );
}

// Self-focused CardBtn for isolated actions (owns its focus state).
export function ActionCard({ color, active, disabled, center, big, onClick, children }: any) {
  const [focused, setFocused] = useState(false);
  return (
    <CardBtn
      color={color}
      active={active}
      disabled={disabled}
      focused={focused}
      center={center !== false}
      big={big}
      onClick={onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
    >
      {children}
    </CardBtn>
  );
}

// Square icon button (voice toolbar) with the same halo treatment. `active`
// paints the accent as a solid background (e.g. muted/live state).
export function toolbarBtnStyle(px: (n: number) => number) {
  return {
    height: px(48), width: px(52), minWidth: px(52), minHeight: px(48),
    padding: 0, marginRight: px(6), boxSizing: "border-box" as const,
    overflow: "visible" as const, lineHeight: 1, fontSize: px(20),
  };
}

export function IconBtn({ color, active, disabled, title, onClick, children }: any) {
  const [focused, setFocused] = useState(false);
  const { px } = useQamUi();
  const c = color || ACCENT;
  return (
    <Btn
      disabled={disabled}
      onClick={onClick}
      title={title}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        ...toolbarBtnStyle(px),
        marginRight: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        borderRadius: px(6), color: "#fff",
        background: active ? c : "rgba(255,255,255,0.06)",
        opacity: disabled ? 0.5 : 1,
        ...focusHalo(c, focused, 1.06),
      }}
    >
      {children}
    </Btn>
  );
}

// ── Vocabulaire commun des listes et des blocs ──────────────────────────────
// #45 (Havok027) : « applique l'interface vocale comme l'interface textuelle,
// à TOUS les menus ». La 1.31 avait redessiné la liste des serveurs du vocal
// (cartes arrondies + halo partagé + pastilles + rail d'accent) mais ce
// traitement vivait dans ChannelBrowser, en un seul exemplaire, et le reste du
// plugin (MP, liste de serveurs du textuel, participants, sélecteurs, modales)
// gardait le focus natif de Steam et des tailles en dur. On énonce donc le
// langage ICI, une fois, et chaque écran s'y branche — sinon la prochaine vue
// dépareillera exactement de la même façon.

// Pastille teintée : un compte, un état (« LIVE », « en appel », 3 actifs).
// Fond = la couleur à 16 %, texte = la couleur pleine. Se lit d'un coup d'œil
// sans entrer en concurrence avec le libellé voisin, qui est en blanc.
export function Pill({ color, children, title }: any) {
  const { px } = useQamUi();
  const c = color || ONLINE;
  return (
    <span
      title={title}
      style={{
        display: "inline-flex", alignItems: "center", gap: px(3), flexShrink: 0,
        fontSize: px(10), fontWeight: 700, lineHeight: 1.4, color: c,
        background: hexA(c, 0.16), borderRadius: px(8),
        padding: `${px(1)}px ${px(6)}px`,
      }}
    >
      {children}
    </span>
  );
}

// `#rrggbb` + alpha → `rgba(...)`. Les couleurs sémantiques sont des hex
// (ACCENT/DANGER/ONLINE) et les fonds teintés en ont besoin en rgba.
export function hexA(hex: string, a: number): string {
  const h = (hex || "").replace("#", "");
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Surface d'un bloc (une personne dans le vocal, une conversation, un
// événement). Même arrondi et même fond que les rangées de serveur, plus un
// liseré : sans lui, deux blocs collés se lisent comme un seul pavé gris.
// Curseurs : deux mesures, prises au CDP le 13/09 dans le document du QAM.
//
//   .steamcord-slider          258 px → 234 px utiles
//     div anonyme              234 px  ✓
//       div anonyme            234 px  ✓
//         div anonyme, flex    270 px   min-width: 270px   ← LE coupable
//           …SliderControl…    270 px
//             .SliderTrack     270 px, overflow: hidden, pastille en pseudo-élément
//
// Ce n'est ni une largeur du contrôle ni une marge : un div ANONYME du composant
// Steam impose un plancher de 270 px à tout le sous-arbre. Il déborde donc de
// 36 px de la place qu'on lui donne, et son propre `overflow: hidden` coupe la
// pastille arrivée au bout. Trois tentatives ont échoué avant d'aller mesurer :
// marge 12 px, marge 20 px, `overflow: visible` sur la liste — toutes AU-DESSUS
// du problème, qui est entièrement sous notre conteneur.
//
// On relâche donc le plancher (`min-width: 0` suffit : les parents sont déjà en
// `flex: 1 1 auto`, ils se remettent à la bonne taille tout seuls) et on laisse
// la pastille dépasser son rail. Scopé à une classe à nous : les curseurs natifs
// de Steam partagent ce composant, on n'y touche pas.
//
// ⚠️ Le style va dans le document de l'ÉLÉMENT, pas dans `document`. Le plugin
// s'exécute dans SharedJSContext mais s'affiche dans la fenêtre du QAM : une
// première version injectait dans le mauvais document — la classe était bien
// posée, la règle n'existait nulle part, et rien ne changeait.
const SLIDER_FIX_CSS =
  ".steamcord-slider *{min-width:0!important}" +
  ".steamcord-slider .SliderTrack{overflow:visible!important}";

export function useSliderClipFix() {
  return useCallback((el: HTMLElement | null) => {
    const doc = el && el.ownerDocument;
    if (!doc || doc.getElementById("steamcord-slider-fix")) return;
    try {
      const style = doc.createElement("style");
      style.id = "steamcord-slider-fix";
      style.textContent = SLIDER_FIX_CSS;
      doc.head.appendChild(style);
    } catch (_) { /* purement cosmétique : on laisse Steam rogner */ }
  }, []);
}

export function Card({ tint, active, children, style }: any) {
  const { px } = useQamUi();
  const c = tint || ACCENT;
  return (
    <div
      style={{
        borderRadius: px(10), boxSizing: "border-box", width: "100%", maxWidth: "100%",
        overflow: "visible",
        background: active ? hexA(c, 0.14) : "rgba(255,255,255,0.05)",
        border: `1px solid ${active ? hexA(c, 0.4) : "rgba(255,255,255,0.06)"}`,
        transition: "background .12s ease, border-color .12s ease",
        ...(style || {}),
      }}
    >
      {children}
    </div>
  );
}

// Rail d'accent vertical : rattache un contenu à CE qui le précède (salons
// d'un serveur déplié, aperçu sous un pseudo). Sans lui, dès qu'on a fait
// défiler un peu, une liste imbriquée se confond avec la liste parente.
export function Rail({ children, color }: any) {
  const { px } = useQamUi();
  return (
    <div style={{
      marginLeft: px(13), marginTop: px(3), paddingLeft: px(9),
      borderLeft: `${px(2)}px solid ${hexA(color || ACCENT, 0.35)}`,
    }}>
      {children}
    </div>
  );
}

// Rangée cliquable pleine largeur : LE motif de toutes les listes du plugin
// (serveur, salon, conversation, événement, capture, clip). `active` peint
// l'accent en fond, le focus manette reprend le halo commun. C'est la
// généralisation de GuildRowBtn, qui était le seul à l'avoir.
export function RowBtn({
  active, color, disabled, sub, flex, gap, minHeight, radius, onClick, title, children,
}: any) {
  const [focused, setFocused] = useState(false);
  const { px } = useQamUi();
  const c = color || ACCENT;
  return (
    <Btn
      disabled={disabled}
      onClick={onClick}
      title={title}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        display: "flex", alignItems: "center", gap: px(gap ?? (sub ? 7 : 9)),
        // `flex` : la rangée partage sa ligne avec des puces (mode réorganisation).
        width: flex ? undefined : "100%", flex: flex ? 1 : undefined,
        minWidth: 0, margin: 0, boxSizing: "border-box",
        padding: sub ? `${px(5)}px ${px(9)}px` : `${px(6)}px ${px(9)}px`,
        minHeight: px(minHeight ?? (sub ? 32 : 42)),
        borderRadius: px(radius ?? (sub ? 8 : 10)),
        overflow: "visible", lineHeight: 1.2, color: "#fff",
        fontSize: px(sub ? 12 : 13),
        opacity: disabled ? 0.5 : 1,
        background: active
          ? c
          : focused ? (sub ? hexA(c, 0.7) : hexA(c, 0.85)) : "rgba(255,255,255,0.05)",
        ...focusHalo(c, focused, sub ? 1.01 : 1.02),
      }}
    >
      {children}
    </Btn>
  );
}

// Bouton d'action compact DANS un bloc (couper le son de quelqu'un, regarder
// son partage, plein écran d'une tuile). Plus discret qu'une ActionCard, même
// halo. `on` = état enclenché, peint en couleur pleine.
export function InlineBtn({ on, color, tone, big, disabled, onClick, title, children }: any) {
  const [focused, setFocused] = useState(false);
  const { px } = useQamUi();
  const c = color || ACCENT;
  const rest = tone === "accent" ? hexA(ACCENT, 0.45) : "rgba(255,255,255,0.08)";
  return (
    <Btn
      disabled={disabled}
      onClick={onClick}
      title={title}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        width: "100%", margin: 0, padding: `${px(big ? 7 : 5)}px 0`, minHeight: px(big ? 34 : 28),
        boxSizing: "border-box", borderRadius: px(big ? 10 : 8),
        display: "flex", alignItems: "center", justifyContent: "center", gap: px(big ? 8 : 6),
        fontSize: px(big ? 12 : 11), fontWeight: 600, lineHeight: 1.2, color: "#fff",
        overflow: "visible", opacity: disabled ? 0.5 : 1,
        background: on ? c : focused ? hexA(ACCENT, 0.85) : rest,
        ...focusHalo(on ? c : ACCENT, focused),
      }}
    >
      {children}
    </Btn>
  );
}

// Puce d'action minuscule alignée à droite d'un titre (rafraîchir, replier).
// Reprend le halo au lieu du focus natif, qui posait un fond clair et du texte
// sombre sur ces boutons-là aussi.
export function MiniBtn({ onClick, disabled, title, children }: any) {
  const [focused, setFocused] = useState(false);
  const { px } = useQamUi();
  return (
    <Btn
      disabled={disabled}
      onClick={onClick}
      title={title}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        margin: 0, padding: `${px(3)}px ${px(9)}px`, minHeight: px(26), minWidth: 0,
        boxSizing: "border-box", borderRadius: px(8), fontSize: px(11), lineHeight: 1.2,
        color: "#fff", overflow: "visible", opacity: disabled ? 0.5 : 1,
        display: "flex", alignItems: "center", gap: px(5),
        background: focused ? hexA(ACCENT, 0.85) : "rgba(255,255,255,0.06)",
        ...focusHalo(ACCENT, focused, 1.06),
      }}
    >
      {children}
    </Btn>
  );
}

// Titre de section : même graisse et même discrétion partout (aperçu local,
// « salons », « à venir »). Sans ça chaque écran inventait sa propre étiquette.
export function SectionLabel({ children, style }: any) {
  const { px } = useQamUi();
  return (
    <div style={{
      fontSize: px(10), fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase",
      opacity: 0.55, marginBottom: px(3), display: "flex", alignItems: "center", gap: px(5),
      ...(style || {}),
    }}>
      {children}
    </div>
  );
}

// Message d'état d'une liste (chargement, vide, erreur) — trois écrans les
// écrivaient avec trois tailles et trois opacités différentes.
export function Notice({ tone, children }: any) {
  const { px } = useQamUi();
  const color = tone === "error" ? "#ff6b6b" : tone === "warn" ? "#ffb74d" : "#fff";
  return (
    <div style={{
      padding: `${px(8)}px ${px(6)}px`, fontSize: px(12), lineHeight: 1.35,
      color, opacity: tone ? 0.95 : 0.6,
    }}>
      {children}
    </div>
  );
}

// En-tête de section repliable (soundboard, overlays, événements). Trois
// écrans dessinaient le leur, avec trois tailles et trois chevrons différents
// (dont deux caractères « ▴/▾ ») — c'est exactement ce que #45 reproche.
export function CollapseHeader({ open, icon, right, onClick, children }: any) {
  const [focused, setFocused] = useState(false);
  const { px } = useQamUi();
  return (
    <Btn
      onClick={onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        width: "100%", padding: `${px(6)}px ${px(9)}px`, fontSize: px(12),
        minHeight: px(34), margin: 0, boxSizing: "border-box", borderRadius: px(10),
        display: "flex", gap: px(7), alignItems: "center", overflow: "visible",
        color: "#fff", fontWeight: open ? 700 : 500, lineHeight: 1.2,
        background: open ? hexA(ACCENT, 0.28) : "rgba(255,255,255,0.05)",
        border: `1px solid ${open ? hexA(ACCENT, 0.4) : "rgba(255,255,255,0.06)"}`,
        ...focusHalo(ACCENT, focused),
      }}
    >
      {icon}
      <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {children}
      </span>
      {right}
      <span style={{
        display: "flex", flexShrink: 0, opacity: 0.6,
        transform: open ? "rotate(180deg)" : "none", transition: "transform .12s ease",
      }}>
        <IcChevronDown size={px(12)} />
      </span>
    </Btn>
  );
}

// Corps d'une section dépliée : légèrement en retrait du fond, arrondi comme
// son en-tête, pour qu'on voie où la section commence et où elle finit.
export function CollapseBody({ children }: any) {
  const { px } = useQamUi();
  return (
    <div style={{
      marginTop: px(4), padding: `${px(6)}px ${px(6)}px ${px(2)}px`,
      borderRadius: px(10), background: "rgba(255,255,255,0.03)",
      display: "flex", flexDirection: "column", gap: px(6),
    }}>
      {children}
    </div>
  );
}
