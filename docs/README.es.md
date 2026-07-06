# Steamcord

**Discord en el Modo Juego de Steam** — un plugin de [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) para Steam Deck / Bazzite / SteamOS.

🌍 **Idiomas:** [English](../README.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · **Español** · [Italiano](README.it.md) · [Português](README.pt.md) · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [Русский](README.ru.md)

> **Steamcord es un proyecto independiente.** Originalmente se inspiró en
> [Deckcord](https://github.com/marios8543/Deckcord) (ver Créditos), pero el código se ha
> reescrito en gran parte y ahora sigue su propia dirección — no está afiliado ni respaldado
> por ese proyecto.
>
> La interfaz está totalmente traducida a 9 idiomas y sigue automáticamente el idioma de SteamOS.

---

## Cómo funciona

Steamcord ejecuta **[Vesktop](https://github.com/Vencord/Vesktop)** — un cliente de Discord nativo de verdad — invisible en segundo plano, y lo controla mediante el Chrome DevTools Protocol. El plugin le inyecta un pequeño cliente y expone todo en el **menú de acceso rápido** de Steam.

Pasar a nativo resuelve los problemas difíciles del antiguo enfoque de navegador oculto: **tu micrófono y el audio de voz funcionan de forma nativa**, igual que en la app de escritorio de Discord — sin trucos de captura ni rodeos de reproducción automática. Vesktop se inicia (y se instala si falta) automáticamente, mantiene la sesión tras reiniciar y nunca necesita una ventana de escritorio en el Modo Juego.

---

## Funciones

- **Un Discord por cuenta de Steam (multisesión)** — Cada usuario de Steam de la máquina tiene **su propio perfil de Discord**: cambia de cuenta de Steam y Steamcord cambia de Discord automáticamente en segundos (la primera vez muestra el login QR; después cada sesión queda recordada). Nadie acaba en el Discord de otra persona.
- **Inicio de sesión con código QR** — Escanea un código QR con la app móvil de Discord para entrar al instante. En tu teléfono: *Discord → Ajustes → Escanear código QR*, luego apunta al código del panel. Sin escribir contraseñas en la Deck.
- **Inicio de sesión en pantalla completa (alternativa)** — Abre Discord en pantalla completa para entrar con correo/contraseña o resolver un CAPTCHA cuando el QR no es posible.
- **Navegación unificada** — Pestañas **Voz / Texto / ⚙️ Ajustes** arriba, con un selector **Servidores / MD** compartido debajo: el mismo interruptor de fuente sirve para la voz y el texto.
- **Chat de voz** — Únete a canales de voz y escucha a todos, con cada miembro mostrado en vivo (anillo al hablar, distintivos de silencio/ensordecer), un control de volumen por persona (0–200 %) **y un silencio local por persona** (silencia a alguien solo para ti, sin que lo sepa). Micrófono y audio nativos (Vesktop).
- **Mensajes directos (MD y grupos)** — Explora tus conversaciones e inicia/únete a llamadas de voz con amigos directamente desde el menú de acceso rápido. Las llamadas activas se resaltan.
- **Explorador de voz de servidores** — Mira qué canales de voz tienen gente (con avatares) antes de unirte.
- **Chat de texto — servidores *y* MD** — Lee y responde a un canal de servidor **o a una conversación privada** desde el QAM (campo a ancho completo, el teclado de Steam se abre solo). **Las imágenes adjuntas se muestran como miniaturas** (cargadas solo mientras el canal está abierto) y **los enlaces se abren en el navegador del Modo Juego**. Desplazamiento automático al último mensaje.
- **Estado de Discord en tu nombre** — Tu **nombre de usuario clicable** arriba muestra tu estado actual; tócalo para cambiarlo. Una sincronización automática opcional hace que Discord **siga tu estado de Steam** en segundo plano; elegir un estado a mano vuelve al modo manual.
- **Selección de dispositivos de audio** — Desde Ajustes, elige el dispositivo de **salida (sonido de Discord)** y de **entrada (micrófono)** — *Auto (predeterminado del sistema)* o uno concreto, p. ej. enviar el sonido de Discord solo a tus **auriculares** mientras el juego sigue por HDMI.
- **Silenciar / Ensordecer / Desconectar** — Controles de voz con un toque desde el QAM.
- **Compartir pantalla** — Comparte toda tu pantalla en un canal de voz (Go Live). Funciona de forma nativa en Escritorio / Big Picture. **En el Modo Juego (gamescope) está en _beta_:** gamescope no tiene portal de captura de pantalla (el Go Live normal se ve negro), así que un botón aparte **«Compartir pantalla (modo juego)»** captura el juego mediante una cámara virtual (v4l2loopback) alimentada directamente por la salida PipeWire de gamescope — el único camino de captura que funciona ahí. Requiere una configuración única de v4l2loopback.
- **Compartir el audio del juego** — Transmite el sonido de tu juego al canal de voz **junto con tu voz**. Dos controles de mezcla (🎙️ voz / 🎮 juego) definen lo que oyen los demás, mientras tú sigues oyendo el juego con normalidad — y funciona incluso **sin micrófono físico** (el plugin crea una entrada virtual *Steamcord Mic*).
- **Notificaciones en el juego** — Las llamadas de MD entrantes y las menciones aparecen como **notificaciones nativas de Steam (popup + sonido)**, respetando tu estado de Discord (silenciadas en invisible / no molestar).
- **Pulsar para hablar** — Con una tecla física (R5 por defecto).
- **Enviar capturas** — Envía una captura de Steam directamente a la conversación que tengas abierta.
- **[Vencord](https://vencord.dev/)** está integrado en Vesktop, dando acceso a su ecosistema de plugins.
- 🟣 **Streaming en Twitch** — emite en Twitch desde los controles de voz: guarda tu clave de stream (por cuenta de Steam, oculta y guardada de forma segura) y elige resolución / fps / bitrate. Codificado con ffmpeg desde la captura del juego.
- 🐧 **Compatibilidad** — trabajamos activamente para soportar todos los SO capaces de ejecutar Steam en modo juego / Big Picture (Linux por ahora): detección portable, dependencias Python incluidas, sin suposiciones específicas de distribución.

---

## Instalación

> **Aún no está en la Decky Store.** Instalación manual mediante el modo desarrollador.

1. Activa el **modo desarrollador** en Decky → Ajustes generales
2. Ve a **Desarrollador** en los ajustes de Decky
3. Instala desde la URL:
   `https://github.com/Necrosiak/Steamcord/releases/latest/download/Steamcord.zip`

Vesktop se instala y se inicia automáticamente con el plugin la primera vez. Solo inicia sesión una vez (QR o pantalla completa) y permaneces conectado.

### Requisito (compartir pantalla)
La pantalla compartida funciona de inmediato: el complemento instala automáticamente su dependencia de Python (aiohttp) en el primer arranque. GStreamer lo proporciona el sistema.

---

## Compilar desde el código fuente

```bash
git clone https://github.com/Necrosiak/Steamcord
cd Steamcord
pnpm install
pnpm run build
# copia dist/, main.py, defaults/, plugin.json, package.json a ~/homebrew/plugins/Steamcord/
sudo systemctl restart plugin_loader
```

---

## Créditos

- Proyecto original: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — arquitectura, BrowserView, compartir pantalla con GStreamer
- [@aagaming](https://github.com/AAGaming00) — soporte de micrófono vía la pestaña SteamClient (relé WebRTC)
- [@Epictek](https://github.com/Epictek) — base del inicio de sesión con QR
- [@jessebofill](https://github.com/jessebofill) — código de parcheo del menú de Steam
- [Vesktop / Vencord](https://github.com/Vencord/Vesktop) — el cliente de Discord nativo que controla Steamcord
