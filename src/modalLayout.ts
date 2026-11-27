// Steam modal layout compatibility. No React components or global Steam objects.
// ── Modales « full-bleed » (grille multi-POV, plein écran vidéo) ─────────────
// ModalRoot contraint son contenu à ~573px de large (DialogContent_InnerWidth,
// mesuré au CDP sur écran 1500px : tuiles squelettiques). On déborde du cadre
// en largeur viewport, centré via la marge (les % de margin se réfèrent au
// parent). PAS de position:fixed : le dialog a un transform (animation) qui
// devient le containing block du fixed → contenu effondré (mesuré : 612×28).
export const FULL_BLEED = {
  width: "96vw", marginLeft: "calc((100% - 96vw) / 2)", boxSizing: "border-box" as const,
};

// La vidéo occupe le viewport entier ; le titre se superpose à l'image.
// Le ratio reste intact (bandes noires si la source n'a pas le ratio écran).
export const VIDEO_FULL_BLEED = {
  width: "100vw", height: "100vh", margin: 0, top: 0, left: 0,
  boxSizing: "border-box" as const, position: "fixed" as const, zIndex: 2147483647,
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

export const videoFullscreenMarkerRef = (el: HTMLDivElement | null) => {
  chromeHideMarkerRef(el);
  if (!el) return;
  [0, 300, 800].forEach(ms => setTimeout(() => {
    if (!el.isConnected) return;
    // Le cadre du dialog Steam ajoute marges et limite de hauteur. Les
    // styles empruntés sont rendus à la fermeture par releaseClosed().
    let p = el.parentElement?.parentElement;
    let outsideDialog = false;
    // A containing block can live ABOVE ModalOverlayContent (or be created
    // by will-change / individual transforms). Walk the complete ancestor
    // chain, keeping size/chrome edits confined to the dialog itself.
    for (; p; p = p.parentElement) {
      const animation = el.ownerDocument.defaultView?.getComputedStyle(p).animationName;
      // Steam's fill-forward transform animation retains a fixed containing
      // block in CEF even when the computed transform has been overridden.
      if (animation && animation !== "none") setOwned(p, el, "animation", "none");
      if (!outsideDialog) {
        for (const [key, value] of [["max-width", "none"], ["max-height", "none"],
          ["padding", "0"], ["overflow", "visible"]]) setOwned(p, el, key, value);
      }
      for (const [key, value] of [["transform", "none"], ["translate", "none"],
        ["rotate", "none"], ["scale", "none"], ["perspective", "none"],
        ["filter", "none"], ["backdrop-filter", "none"], ["contain", "none"],
        ["will-change", "auto"], ["content-visibility", "visible"], ["container-type", "normal"]])
        setOwned(p, el, key, value);
      if (p.classList.contains("ModalOverlayContent")) {
        setOwned(p, el, "z-index", "2147483647");
        const layer = p.parentElement;
        if (layer && layer !== el.ownerDocument.body && layer !== el.ownerDocument.documentElement)
          setOwned(layer, el, "z-index", "2147483647");
        outsideDialog = true;
      }
    }
  }, ms));
};

