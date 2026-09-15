// Navigation de la vue agrandie, offerte aux composants qu'elle affiche : ouvrir
// un chat ou les membres d'un serveur dans le bloc de droite. Hors de la vue
// (QAM), un chat s'ouvre dans la fenêtre plein écran habituelle.
// Fichier à part pour éviter l'import circulaire DiscordExpanded ↔ FriendsHub.
import { showModal } from "@decky/ui";
import { createContext, useContext } from "react";
import { ChatFullscreenModal } from "./ChatFullscreen";

export type OpenChat = (channelId: string, name: string, isDm: boolean) => void;
export type OpenMembers = (guildId: string, name: string) => void;

export const ExpandedNavContext = createContext<{ openChat: OpenChat; openMembers: OpenMembers } | null>(null);

export function useOpenChat(): OpenChat {
  const nav = useContext(ExpandedNavContext);
  return nav?.openChat || ((channelId, name, isDm) => { showModal(<ChatFullscreenModal channelId={channelId} channelName={name} isDm={isDm} />); });
}

// null hors de la vue agrandie : l'appelant n'affiche alors pas l'entrée.
export function useOpenMembers(): OpenMembers | null {
  return useContext(ExpandedNavContext)?.openMembers ?? null;
}
