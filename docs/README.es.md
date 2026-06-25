# Streamcord

**Discord en el Modo Juego de Steam** — un plugin de [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) para Steam Deck / Bazzite / SteamOS.

🌍 **Idiomas:** [English](../README.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · **Español** · [Italiano](README.it.md) · [Português](README.pt.md) · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [Русский](README.ru.md)

> **Streamcord es un fork independiente de [marios8543/Deckcord](https://github.com/marios8543/Deckcord).**
> No está afiliado, respaldado ni soportado por el proyecto Deckcord original.
> El código ha divergido mucho — la mayoría de las funciones se han reescrito o añadido desde cero.
>
> La interfaz está totalmente traducida a 9 idiomas y sigue automáticamente el idioma de SteamOS.

---

## Funciones (y cómo funcionan)

- **Inicio de sesión con código QR** — Escanea un código QR con la app móvil de Discord para entrar al instante. En tu teléfono: *Discord → Ajustes → Escanear código QR*, luego apunta al código del panel. Sin escribir contraseñas en la Deck.
- **Inicio de sesión en pantalla completa (alternativa)** — Abre Discord en pantalla completa para entrar con correo/contraseña o resolver un CAPTCHA cuando el QR no es posible.
- **Chat de voz** — Únete a canales de voz y escucha a todos, con cada miembro mostrado en vivo (anillo al hablar, distintivos de silencio/ensordecer) y un control de volumen por persona (0–200 %).
- **Mensajes directos (MD y grupos)** — Explora tus conversaciones e inicia/únete a llamadas de voz con amigos directamente desde el menú de acceso rápido. Las llamadas activas se resaltan.
- **Explorador de voz de servidores** — Mira qué canales de voz tienen gente (con avatares) antes de unirte.
- **Silenciar / Ensordecer / Desconectar** — Controles de voz con un toque desde el QAM.
- **Go Live (compartir pantalla)** — Comparte toda tu pantalla en un canal de voz.
- **Relé de micrófono** — Tu micrófono se captura en la interfaz de Steam y se transmite a Discord, para que te oigan aunque Discord corra en una pestaña oculta en segundo plano. La entrada y la salida siguen automáticamente tu dispositivo de audio por defecto (conecta unos auriculares y cambia solo).
- **Estado de juego** — Muestra el juego que juegas como tu estado de Discord.
- **Notificaciones en el juego** — Los MD y menciones aparecen como notificaciones de Steam.
- **Pulsar para hablar** — Con una tecla física (R5 por defecto).
- **Enviar capturas** — Envía una captura de Steam a cualquier canal de Discord.
- **[Vencord](https://vencord.dev/)** se inyecta automáticamente, dando acceso a su ecosistema de plugins.

---

## Cómo funciona el audio (la parte difícil)

Discord corre en una vista de navegador **oculta** dentro de Steam. Dos cosas hacen que la voz funcione:

1. **Oír a los demás** — Chromium suspende el audio en pestañas ocultas (política de reproducción automática). Streamcord reanuda el audio de Discord con un gesto de usuario simulado vía CDP, para que la voz entrante suene en tu salida por defecto.
2. **Que te oigan** — La pestaña oculta no puede capturar el micrófono, así que el micrófono real se captura en el contexto de la interfaz de Steam y se transmite a Discord por una conexión WebRTC local.

La entrada y la salida siguen automáticamente tu dispositivo por defecto.

---

## Instalación

> **Aún no está en la Decky Store.** Instalación manual mediante el modo desarrollador.

1. Activa el **modo desarrollador** en Decky → Ajustes generales
2. Ve a **Desarrollador** en los ajustes de Decky
3. Instala desde la URL:
   `https://github.com/Necrosiak/Streamcord/releases/latest/download/Streamcord.zip`

### Requisito (compartir pantalla)
El servidor de compartir pantalla usa el Python del sistema + GStreamer. Instala las dependencias de Python una vez:
```bash
python -m pip install --user aiohttp aiohttp_cors
```

---

## Compilar desde el código fuente

```bash
git clone https://github.com/Necrosiak/Streamcord
cd Streamcord
pnpm install
pnpm run build
# copia dist/, main.py, defaults/, plugin.json, package.json a ~/homebrew/plugins/Streamcord/
sudo systemctl restart plugin_loader
```

---

## Créditos

- Proyecto original: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — arquitectura, BrowserView, compartir pantalla con GStreamer
- [@aagaming](https://github.com/AAGaming00) — soporte de micrófono vía la pestaña SteamClient (relé WebRTC)
- [@Epictek](https://github.com/Epictek) — base del inicio de sesión con QR
- [@jessebofill](https://github.com/jessebofill) — código de parcheo del menú de Steam
