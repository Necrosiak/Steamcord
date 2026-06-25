# Streamcord

**Discord no Modo Jogo do Steam** — um plugin [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) para Steam Deck / Bazzite / SteamOS.

🌍 **Idiomas:** [English](../README.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Italiano](README.it.md) · **Português** · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [Русский](README.ru.md)

> **Streamcord é um fork independente de [marios8543/Deckcord](https://github.com/marios8543/Deckcord).**
> Não é afiliado, endossado ou suportado pelo projeto Deckcord original.
> O código divergiu bastante — a maioria das funções foi reescrita ou adicionada do zero.
>
> A interface está totalmente traduzida em 9 idiomas e segue automaticamente o idioma do SteamOS.

---

## Funcionalidades (e como funcionam)

- **Login por código QR** — Escaneie um código QR com o app do Discord no celular para entrar na hora. No celular: *Discord → Configurações → Ler código QR*, depois aponte para o código mostrado no painel. Sem digitar senha no Deck.
- **Login em tela cheia (alternativa)** — Abre o Discord em tela cheia para entrar com e-mail/senha ou resolver um CAPTCHA quando o QR não é possível.
- **Chat de voz** — Entre em canais de voz e ouça todos, com cada membro mostrado ao vivo (anel ao falar, selos de mudo/sem áudio) e um controle de volume por pessoa (0–200 %).
- **Mensagens diretas (DMs e grupos)** — Navegue pelas suas conversas e inicie/entre em chamadas de voz com amigos direto pelo menu de acesso rápido. Chamadas ativas são destacadas.
- **Navegador de voz dos servidores** — Veja quais canais de voz têm pessoas (com avatares) antes de entrar.
- **Mudo / Sem áudio / Desconectar** — Controles de voz com um toque pelo QAM.
- **Go Live (compartilhar tela)** — Compartilhe sua tela inteira em um canal de voz.
- **Relé de microfone** — Seu microfone é capturado na interface do Steam e retransmitido ao Discord, para que te ouçam mesmo com o Discord rodando em uma aba oculta em segundo plano. A entrada e a saída seguem automaticamente seu dispositivo de áudio padrão (conecte um fone e ele troca sozinho).
- **Status de jogo** — Mostra o jogo que você está jogando como seu status no Discord.
- **Notificações no jogo** — DMs e menções aparecem como notificações do Steam.
- **Push-to-talk** — Com uma tecla física (R5 por padrão).
- **Enviar capturas** — Envie uma captura do Steam para qualquer canal do Discord.
- **[Vencord](https://vencord.dev/)** é injetado automaticamente, dando acesso ao seu ecossistema de plugins.

---

## Como o áudio funciona (a parte difícil)

O Discord roda em uma visualização de navegador **oculta** dentro do Steam. Duas coisas fazem a voz funcionar:

1. **Ouvir os outros** — O Chromium suspende o áudio em abas ocultas (política de autoplay). O Streamcord retoma o áudio do Discord com um gesto de usuário simulado via CDP, para que a voz recebida toque na sua saída padrão.
2. **Ser ouvido** — A aba oculta não consegue capturar o microfone, então o microfone real é capturado no contexto da interface do Steam e retransmitido ao Discord por uma conexão WebRTC local.

A entrada e a saída seguem automaticamente seu dispositivo padrão.

---

## Instalação

> **Ainda não está na Decky Store.** Instalação manual pelo modo desenvolvedor.

1. Ative o **modo desenvolvedor** em Decky → Configurações gerais
2. Vá em **Desenvolvedor** nas configurações do Decky
3. Instale pela URL:
   `https://github.com/Necrosiak/Streamcord/releases/latest/download/Streamcord.zip`

### Requisito (compartilhamento de tela)
O servidor de compartilhamento usa o Python do sistema + GStreamer. Instale as dependências do Python uma vez:
```bash
python -m pip install --user aiohttp aiohttp_cors
```

---

## Compilar a partir do código

```bash
git clone https://github.com/Necrosiak/Streamcord
cd Streamcord
pnpm install
pnpm run build
# copie dist/, main.py, defaults/, plugin.json, package.json para ~/homebrew/plugins/Streamcord/
sudo systemctl restart plugin_loader
```

---

## Créditos

- Projeto original: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — arquitetura, BrowserView, compartilhamento de tela GStreamer
- [@aagaming](https://github.com/AAGaming00) — suporte de microfone via a aba SteamClient (relé WebRTC)
- [@Epictek](https://github.com/Epictek) — base do login por QR Code
- [@jessebofill](https://github.com/jessebofill) — código de patch do menu do Steam
