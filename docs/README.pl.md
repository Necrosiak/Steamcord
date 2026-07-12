# Steamcord

**Discord w trybie gry Steam** — wtyczka [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) dla Steam Deck / Bazzite / SteamOS.

🌍 **Języki:** [English](../README.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Italiano](README.it.md) · [Português](README.pt.md) · [Nederlands](README.nl.md) · **Polski** · [Русский](README.ru.md)

> **Steamcord to niezależny projekt.** Pierwotnie zainspirowany przez
> [Deckcord](https://github.com/marios8543/Deckcord) (zobacz Podziękowania), ale kod został
> w dużej części przepisany i podąża teraz własną drogą — nie jest powiązany z tym projektem
> ani przez niego zatwierdzony.
>
> Interfejs jest w pełni przetłumaczony na 9 języków i automatycznie podąża za językiem SteamOS.

---

## Jak to działa

Steamcord uruchamia **[Vesktop](https://github.com/Vencord/Vesktop)** — prawdziwego, natywnego klienta Discord — niewidocznie w tle i steruje nim przez Chrome DevTools Protocol. Wtyczka wstrzykuje do niego mały klient i udostępnia wszystko w **menu szybkiego dostępu** Steam.

Przejście na natywność rozwiązuje trudne problemy starego podejścia z ukrytą przeglądarką: **twój mikrofon i dźwięk głosowy działają natywnie**, dokładnie jak w desktopowej aplikacji Discord — bez sztuczek przechwytywania, bez obejść autoodtwarzania. Vesktop jest uruchamiany (i instalowany, jeśli go brak) automatycznie, pozostaje zalogowany po restarcie i nigdy nie potrzebuje okna pulpitu w trybie gry.

---

## Funkcje

- **Jeden Discord na konto Steam (multi-sesja)** — Każdy użytkownik Steam na maszynie ma **własny profil Discorda**: zmień konto Steam, a Steamcord automatycznie przełączy Discorda w kilka sekund (za pierwszym razem pokaże logowanie QR; potem każda sesja jest zapamiętana). Nikt nie trafi na cudzego Discorda.
- **Logowanie kodem QR** — Zeskanuj kod QR aplikacją Discord na telefonie, aby zalogować się natychmiast. Na telefonie: *Discord → Ustawienia → Skanuj kod QR*, a następnie wyceluj w kod pokazany w panelu. Bez wpisywania hasła na Decku.
- **Logowanie na pełnym ekranie (zapasowe)** — Otwiera Discord na pełnym ekranie, aby zalogować się e-mailem/hasłem lub rozwiązać CAPTCHA, gdy QR nie jest możliwy.
- **Ujednolicona nawigacja** — Karty **Głos / Tekst / ⚙️ Ustawienia** u góry, a pod nimi wspólny przełącznik **Serwery / DM**: ten sam wybór źródła działa dla głosu i tekstu.
- **Czat głosowy** — Dołączaj do kanałów głosowych i słysz wszystkich, każdy członek pokazany na żywo (pierścień mówienia, plakietki wyciszenia/ogłuszenia), suwak głośności na osobę (0–200 %) **oraz lokalne wyciszenie na osobę** (wycisz kogoś tylko dla siebie, bez jego wiedzy). Mikrofon i dźwięk są natywne (Vesktop).
- **Wiadomości prywatne (DM i grupy)** — Przeglądaj rozmowy oraz rozpoczynaj/dołączaj do połączeń głosowych ze znajomymi bezpośrednio z menu szybkiego dostępu. Aktywne połączenia są wyróżnione.
- **Przeglądarka głosowa serwerów** — Zobacz, w których kanałach głosowych są ludzie (z awatarami), zanim dołączysz.
- **Czat tekstowy — serwery *i* DM** — Czytaj i odpowiadaj na kanale serwera **lub w prywatnej rozmowie** z poziomu QAM (pole na całą szerokość, klawiatura Steam otwiera się sama). **Załączone obrazy pokazują się jako miniatury** (ładowane tylko gdy kanał jest otwarty), a **linki otwierają się w przeglądarce trybu gry**. Automatyczne przewijanie do najnowszej wiadomości.
- **Status Discord na twojej nazwie** — Twoja **klikalna nazwa użytkownika** u góry pokazuje aktualny status; stuknij ją, aby go zmienić. Opcjonalna automatyczna synchronizacja sprawia, że Discord **podąża za twoim statusem Steam** w tle; ręczny wybór statusu przełącza z powrotem na tryb ręczny.
- **Wybór urządzeń audio** — W Ustawieniach wybierz urządzenie **wyjściowe (dźwięk Discorda)** i **wejściowe (mikrofon)** — *Auto (domyślne systemowe)* lub konkretne, np. dźwięk Discorda tylko na **słuchawki**, podczas gdy gra zostaje na HDMI.
- **Wycisz / Ogłusz / Rozłącz** — Sterowanie głosem jednym dotknięciem z QAM.
- **Udostępnianie ekranu** — Udostępnij cały ekran na kanale głosowym (Go Live). Działa natywnie w trybie pulpitu / Big Picture. **W trybie gry (gamescope) to _beta_:** gamescope nie ma portalu przechwytywania ekranu (zwykłe Go Live daje czarny ekran), więc osobny przycisk **„Udostępnij ekran (tryb gry)”** przechwytuje grę przez wirtualną kamerę (v4l2loopback) zasilaną bezpośrednio z wyjścia PipeWire gamescope'a — jedyna działająca tam ścieżka przechwytywania. Wymaga jednorazowej konfiguracji v4l2loopback.
- **Udostępnianie dźwięku gry** — Przesyłaj dźwięk swojej gry na kanał głosowy **razem ze swoim głosem**. Dwa suwaki miksu (🎙️ głos / 🎮 gra) decydują, co słyszą inni, podczas gdy ty dalej normalnie słyszysz grę — i działa to nawet **bez fizycznego mikrofonu** (wtyczka tworzy wirtualne wejście *Steamcord Mic*).
- **Powiadomienia w grze** — Przychodzące połączenia DM i wzmianki pojawiają się jako **natywne powiadomienia Steam (popup + dźwięk)**, respektując twój status Discord (wyciszone przy niewidoczny / nie przeszkadzać).
- **🕹️ Skrót kontrolera do głosu** — Przechwyć **dowolną kombinację przycisków kontrolera** i przypisz ją do **wyciszenia (przełącznik)** lub **push-to-talk**. Działa globalnie w grze, nawet przy zamkniętym QAM (konfiguracja w zakładce Ustawienia).
- **Wysyłanie zrzutów ekranu** — Wyślij zrzut ekranu Steam prosto do otwartej rozmowy.
- **[Vencord](https://vencord.dev/)** jest wbudowany w Vesktop, dając dostęp do swojego ekosystemu wtyczek.
- 🐧 **Kompatybilność** — aktywnie pracujemy nad wsparciem każdego systemu zdolnego uruchomić Steam w trybie gry / Big Picture (na razie Linux): przenośna detekcja, dołączone zależności Pythona, brak założeń specyficznych dla dystrybucji. Notatki dla dystrybucji: [OS-NOTES.md](OS-NOTES.md).

---

## 📸 Zrzuty ekranu

<p align="center">
  <img src="img/steamcord-servers.jpg" width="49%" alt="Discord servers"/>
  <img src="img/steamcord-dm-chat.jpg" width="49%" alt="Direct messages"/>
</p>
<p align="center">
  <img src="img/steamcord-voice-call.jpg" width="49%" alt="Voice call"/>
  <img src="img/steamcord-voice-live.jpg" width="49%" alt="Screen share live"/>
</p>

## Instalacja

> **Jeszcze nie ma w Decky Store.** Instalacja ręczna w trybie deweloperskim.

1. Włącz **tryb deweloperski** w Decky → Ustawienia ogólne
2. Przejdź do **Deweloper** w ustawieniach Decky
3. Zainstaluj z adresu URL:
   `https://github.com/Necrosiak/Steamcord/releases/latest/download/Steamcord.zip`

Vesktop jest instalowany i uruchamiany automatycznie przez wtyczkę przy pierwszym uruchomieniu. Wystarczy zalogować się raz (QR lub pełny ekran) i pozostajesz zalogowany.

### Wymaganie (udostępnianie ekranu)
Udostępnianie ekranu działa od razu — wtyczka automatycznie instaluje zależność Pythona (aiohttp) przy pierwszym uruchomieniu. GStreamer pochodzi z systemu.

---

## Budowanie ze źródeł

```bash
git clone https://github.com/Necrosiak/Steamcord
cd Steamcord
pnpm install
pnpm run build
# skopiuj dist/, main.py, defaults/, plugin.json, package.json do ~/homebrew/plugins/Steamcord/
sudo systemctl restart plugin_loader
```

---

## 🐛 Issues i pomysły — śmiało!

Bug, dziwne zachowanie na twojej dystrybucji, brakująca funkcja?
**Otwórz [issue](https://github.com/Necrosiak/Steamcord/issues)** — każde
zgłoszenie bezpośrednio kształtuje to, co powstanie dalej. Podaj jeśli możesz:

- dystrybucję i wersję (Bazzite 42, CachyOS, Ubuntu 24.04…) oraz jak działa Steam (tryb gry / Big Picture / pulpit)
- wersję wtyczki (Ustawienia → Aktualizacja) i czy Vesktop jest flatpakiem czy natywny
- co zrobiłeś, czego oczekiwałeś, co się stało zamiast tego
- logi: `~/homebrew/logs/Steamcord/` oraz `journalctl -b | grep -i steamcord`

Prośby o funkcje i zgłoszenia „działa!” na nietypowych konfiguracjach są równie cenne.

## Podziękowania

- Oryginalny projekt: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — architektura, BrowserView, udostępnianie ekranu GStreamer
- [@aagaming](https://github.com/AAGaming00) — obsługa mikrofonu przez kartę SteamClient (przekazywanie WebRTC)
- [@Epictek](https://github.com/Epictek) — podstawa logowania kodem QR
- [@jessebofill](https://github.com/jessebofill) — kod łatania menu Steam
- [Vesktop / Vencord](https://github.com/Vencord/Vesktop) — natywny klient Discord, którym steruje Steamcord
