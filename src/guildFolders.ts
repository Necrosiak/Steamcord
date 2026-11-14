// Dossiers de serveurs (#101) : logique partagée par les trois listes de
// serveurs (QAM vocal, QAM texte, vue agrandie).
import { useState } from "react";

export interface GuildFolder { id: string; name: string | null; color: number | null }

type Item<G> = { guild: G; index: number };
export type FolderEntry<G> =
  | { kind: "guild"; guild: G; index: number }
  | { kind: "folder"; folder: GuildFolder; items: Item<G>[] };

// Regroupe les serveurs d'un même dossier à la place du PREMIER d'entre eux
// dans la liste reçue : l'ordre Steamcord (réorganisation, masquage) reste
// celui de la liste, le dossier ne fait que replier ses membres. `index` est
// la position dans la liste d'entrée, pour les boutons ↑/↓ des appelants.
export function groupByFolder<G extends { folder?: GuildFolder | null }>(list: G[]): FolderEntry<G>[] {
  const out: FolderEntry<G>[] = [];
  const byId = new Map<string, { kind: "folder"; folder: GuildFolder; items: Item<G>[] }>();
  list.forEach((guild, index) => {
    const f = guild.folder;
    if (!f || !f.id) { out.push({ kind: "guild", guild, index }); return; }
    let entry = byId.get(f.id);
    if (!entry) { entry = { kind: "folder", folder: f, items: [] }; byId.set(f.id, entry); out.push(entry); }
    entry.items.push({ guild, index });
  });
  // Un dossier dont un seul serveur est affiché (les autres masqués dans
  // Steamcord) n'apporte qu'un niveau de plus : le serveur s'affiche seul.
  return out.map((e) => e.kind === "folder" && e.items.length === 1 ? { kind: "guild" as const, ...e.items[0] } : e);
}

// Dossier sans nom : Discord affiche les noms de ses serveurs, on fait pareil.
export function folderLabel(folder: GuildFolder, guilds: { name: string }[]): string {
  if (folder.name && folder.name.trim()) return folder.name;
  const names = guilds.slice(0, 3).map((g) => g.name).join(", ");
  return guilds.length > 3 ? names + "…" : names;
}

export function folderColor(folder: GuildFolder): string {
  if (folder.color == null || !Number.isFinite(folder.color)) return "#5865f2";
  return "#" + (Number(folder.color) >>> 0).toString(16).padStart(6, "0").slice(-6);
}

// Dossiers ouverts : mémorisés dans ce navigateur (confort d'affichage
// seulement, rien de grave s'il se vide). Fermés par défaut, c'est le but.
const OPEN_KEY = "steamcord.openGuildFolders";
function readOpen(): string[] {
  try { const v = JSON.parse(localStorage.getItem(OPEN_KEY) || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
export function useOpenFolders(): [Set<string>, (id: string) => void] {
  const [open, setOpen] = useState<Set<string>>(() => new Set(readOpen()));
  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...next])); } catch {}
    return next;
  });
  return [open, toggle];
}
