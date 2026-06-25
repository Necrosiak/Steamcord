# Streamcord

**Discord w trybie gry Steam** — wtyczka [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) dla Steam Deck / Bazzite / SteamOS.

🌍 **Języki:** [English](../README.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Italiano](README.it.md) · [Português](README.pt.md) · [Nederlands](README.nl.md) · **Polski** · [Русский](README.ru.md)

> **Streamcord to niezależny fork [marios8543/Deckcord](https://github.com/marios8543/Deckcord).**
> Nie jest powiązany z oryginalnym projektem Deckcord, ani przez niego wspierany czy zatwierdzony.
> Kod znacznie się różni — większość funkcji została przepisana lub dodana od zera.
>
> Interfejs jest w pełni przetłumaczony na 9 języków i automatycznie podąża za językiem SteamOS.

---

## Funkcje (i jak działają)

- **Logowanie kodem QR** — Zeskanuj kod QR aplikacją Discord na telefonie, aby zalogować się natychmiast. Na telefonie: *Discord → Ustawienia → Skanuj kod QR*, a następnie wyceluj w kod pokazany w panelu. Bez wpisywania hasła na Decku.
- **Logowanie na pełnym ekranie (zapasowe)** — Otwiera Discord na pełnym ekranie, aby zalogować się e-mailem/hasłem lub rozwiązać CAPTCHA, gdy QR nie jest możliwy.
- **Czat głosowy** — Dołączaj do kanałów głosowych i słysz wszystkich, każdy członek pokazany na żywo (pierścień mówienia, plakietki wyciszenia/ogłuszenia) oraz suwak głośności na osobę (0–200 %).
- **Wiadomości prywatne (DM i grupy)** — Przeglądaj rozmowy oraz rozpoczynaj/dołączaj do połączeń głosowych ze znajomymi bezpośrednio z menu szybkiego dostępu. Aktywne połączenia są wyróżnione.
- **Przeglądarka głosowa serwerów** — Zobacz, w których kanałach głosowych są ludzie (z awatarami), zanim dołączysz.
- **Wycisz / Ogłusz / Rozłącz** — Sterowanie głosem jednym dotknięciem z QAM.
- **Go Live (udostępnianie ekranu)** — Udostępnij cały ekran na kanale głosowym.
- **Przekazywanie mikrofonu** — Twój mikrofon jest przechwytywany w interfejsie Steam i przekazywany do Discorda, więc inni cię słyszą, mimo że Discord działa w ukrytej karcie w tle. Wejście i wyjście automatycznie podążają za domyślnym urządzeniem audio (podłącz słuchawki, a przełączy się samo).
- **Status gry** — Pokazuje grę, w którą grasz, jako twój status na Discordzie.
- **Powiadomienia w grze** — DM-y i wzmianki pojawiają się jako powiadomienia Steam.
- **Push-to-talk** — Z fizycznym przyciskiem (domyślnie R5).
- **Wysyłanie zrzutów ekranu** — Wyślij zrzut ekranu Steam na dowolny kanał Discord.
- **[Vencord](https://vencord.dev/)** jest wstrzykiwany automatycznie, dając dostęp do swojego ekosystemu wtyczek.

---

## Jak działa dźwięk (najtrudniejsza część)

Discord działa w **ukrytym** widoku przeglądarki wewnątrz Steam. Dwie rzeczy sprawiają, że głos działa:

1. **Słyszenie innych** — Chromium zawiesza dźwięk w ukrytych kartach (polityka autoodtwarzania). Streamcord wznawia dźwięk Discorda symulowanym przez CDP gestem użytkownika, aby przychodzący głos faktycznie grał na twoim domyślnym wyjściu.
2. **Bycie słyszanym** — Ukryta karta nie może przechwycić mikrofonu, więc prawdziwy mikrofon jest przechwytywany w kontekście interfejsu Steam i przekazywany do Discorda przez lokalne połączenie WebRTC.

Wejście i wyjście automatycznie podążają za twoim domyślnym urządzeniem.

---

## Instalacja

> **Jeszcze nie ma w Decky Store.** Instalacja ręczna w trybie deweloperskim.

1. Włącz **tryb deweloperski** w Decky → Ustawienia ogólne
2. Przejdź do **Deweloper** w ustawieniach Decky
3. Zainstaluj z adresu URL:
   `https://github.com/Necrosiak/Streamcord/releases/latest/download/Streamcord.zip`

### Wymaganie (udostępnianie ekranu)
Serwer udostępniania używa systemowego Pythona + GStreamer. Zainstaluj zależności Pythona raz:
```bash
python -m pip install --user aiohttp aiohttp_cors
```

---

## Budowanie ze źródeł

```bash
git clone https://github.com/Necrosiak/Streamcord
cd Streamcord
pnpm install
pnpm run build
# skopiuj dist/, main.py, defaults/, plugin.json, package.json do ~/homebrew/plugins/Streamcord/
sudo systemctl restart plugin_loader
```

---

## Podziękowania

- Oryginalny projekt: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — architektura, BrowserView, udostępnianie ekranu GStreamer
- [@aagaming](https://github.com/AAGaming00) — obsługa mikrofonu przez kartę SteamClient (przekazywanie WebRTC)
- [@Epictek](https://github.com/Epictek) — podstawa logowania kodem QR
- [@jessebofill](https://github.com/jessebofill) — kod łatania menu Steam
