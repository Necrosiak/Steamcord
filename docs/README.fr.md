# Streamcord

**Discord en Mode Jeu Steam** — un plugin [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) pour Steam Deck / Bazzite / SteamOS.

🌍 **Langues :** [English](../README.md) · **Français** · [Deutsch](README.de.md) · [Español](README.es.md) · [Italiano](README.it.md) · [Português](README.pt.md) · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [Русский](README.ru.md)

> **Streamcord est un fork indépendant de [marios8543/Deckcord](https://github.com/marios8543/Deckcord).**
> Il n'est ni affilié, ni approuvé, ni supporté par le projet Deckcord original.
> Le code a fortement divergé — la plupart des fonctions ont été réécrites ou ajoutées de zéro.
>
> L'interface est entièrement traduite en 9 langues et suit automatiquement la langue de SteamOS.

---

## Fonctionnalités (et comment elles marchent)

- **Connexion par QR code** — Scanne un QR code avec l'app mobile Discord pour te connecter instantanément. Sur ton téléphone : *Discord → Réglages → Scanner le QR Code*, puis vise le code affiché dans le panneau. Aucun mot de passe à taper sur la Deck.
- **Connexion plein écran (secours)** — Ouvre Discord en plein écran pour se connecter par e-mail/mot de passe ou résoudre un CAPTCHA quand le QR n'est pas possible.
- **Chat vocal** — Rejoins les salons vocaux et entends tout le monde, chaque membre affiché en direct (anneau quand il parle, badges muet/sourd) et un curseur de volume par personne (0–200 %).
- **Messages privés (MP & groupes)** — Parcours tes conversations et lance/rejoins des appels vocaux avec tes amis directement depuis le menu d'accès rapide. Les appels actifs sont mis en évidence.
- **Explorateur vocal des serveurs** — Vois quels salons vocaux ont du monde (avec les avatars) avant de rejoindre.
- **Muet / Sourdine / Déconnexion** — Contrôles vocaux en un appui depuis le QAM.
- **Go Live (partage d'écran)** — Partage ton écran entier dans un salon vocal.
- **Relais micro** — Ton micro est capturé dans l'UI Steam et relayé vers Discord, pour qu'on t'entende même si Discord tourne dans un onglet caché en arrière-plan. L'entrée et la sortie suivent automatiquement ton périphérique audio par défaut (branche un casque, ça bascule tout seul).
- **Statut de jeu** — Affiche le jeu auquel tu joues comme statut Discord.
- **Notifications en jeu** — Les MP et mentions apparaissent en notifications Steam.
- **Push-to-talk** — Avec un raccourci physique (R5 par défaut).
- **Envoi de captures** — Envoie une capture Steam dans n'importe quel salon Discord.
- **[Vencord](https://vencord.dev/)** est injecté automatiquement, donnant accès à son écosystème de plugins.

---

## Comment l'audio fonctionne (le plus dur)

Discord tourne dans une vue navigateur **cachée** dans Steam. Deux choses font marcher le vocal :

1. **Entendre les autres** — Chromium suspend l'audio des onglets cachés (politique autoplay). Streamcord réveille l'audio de Discord avec un geste utilisateur simulé via CDP, pour que la voix entrante sorte sur ton périphérique par défaut.
2. **Être entendu** — L'onglet caché ne peut pas capturer le micro, alors le vrai micro est capturé dans le contexte UI de Steam et relayé vers Discord via une connexion WebRTC locale.

L'entrée et la sortie suivent automatiquement ton périphérique par défaut.

---

## Installation

> **Pas encore sur le Decky Store.** Installation manuelle via le mode développeur.

1. Active le **mode développeur** dans Decky → Réglages généraux
2. Va dans **Développeur** dans les réglages Decky
3. Installe depuis l'URL :
   `https://github.com/Necrosiak/Streamcord/releases/latest/download/Streamcord.zip`

### Prérequis (partage d'écran)
Le serveur de partage d'écran utilise le Python système + GStreamer. Installe les dépendances Python une fois :
```bash
python -m pip install --user aiohttp aiohttp_cors
```

---

## Compiler depuis les sources

```bash
git clone https://github.com/Necrosiak/Streamcord
cd Streamcord
pnpm install
pnpm run build
# copier dist/, main.py, defaults/, plugin.json, package.json vers ~/homebrew/plugins/Streamcord/
sudo systemctl restart plugin_loader
```

---

## Remerciements

- Projet original : [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — architecture, BrowserView, partage d'écran GStreamer
- [@aagaming](https://github.com/AAGaming00) — support du micro via l'onglet SteamClient (relais WebRTC)
- [@Epictek](https://github.com/Epictek) — base de la connexion par QR Code
- [@jessebofill](https://github.com/jessebofill) — code de patch du menu Steam
