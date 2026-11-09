"""Optional proxy for Discord and for Steamcord's own downloads.

Discord is blocked in some countries, so the plugin lets you name the proxy it
should use instead of a VPN that captures the whole machine. The setting lives
in Settings ▸ Proxy and reaches three places:

* **Vesktop / Discord.** Chromium takes `--proxy-server` (see
  `chromium_flags()`), so the gateway WebSocket, the login, the CDN and Go Live
  signalling all go through the proxy.
* **Steamcord's own requests.** The updater (GitHub), the QR-login exchange
  with Discord, attachment downloads and the Windows Vesktop download all use
  `aiohttp_proxy()` / `urllib_opener()`.
* **Helper processes** that fetch images (the in-game overlay): `env()`.

Why a local bridge instead of pointing Chromium straight at the proxy? Two of
the three cases cannot be done otherwise:

1. `--proxy-server` takes **no credentials** — Chromium ignores
   `user:pass@host` there and asks with a modal dialog nobody can answer on a
   Deck (Vesktop runs minimized). Chromium also supports no SOCKS5
   authentication at all. So when the proxy needs a login, and for SOCKS in
   general, Steamcord runs `CONNECT`-style HTTP proxy on 127.0.0.1 that adds
   the credential (or speaks SOCKS5 itself) and points everything at it.
2. `aiohttp` has no SOCKS support, and `urllib` has no proxy authentication.
   Both can talk HTTP to the local bridge.

The bridge always uses a preferred port from ADAPTER_PORTS so that a backend
restart lands on the same port and a Vesktop that is already running keeps a
working route.

What a proxy CANNOT carry is voice and video: Chromium never sends WebRTC's
UDP through a proxy, and Discord's voice servers take no TCP fallback worth
using. Voice therefore still needs a system-wide tunnel (v2rayN/Hiddify TUN,
WireGuard…) — the UI says so instead of pretending.
"""

import asyncio
import base64
import ipaddress
import json
import os
import ssl
import struct
from urllib.parse import unquote, urlsplit

from decky import logger  # type: ignore

import host

CONFIG_FILE = host.settings_file("steamcord-proxy.json")

# Proxy kinds we can drive. "https" is an HTTP proxy reached over TLS.
SCHEMES = ("socks5", "socks4", "http", "https")
DEFAULT_PORTS = {"socks5": 1080, "socks4": 1080, "http": 8080, "https": 8080}
# Preferred loopback ports for the bridge: stable across backend restarts (see
# the module docstring), tried in order, port 0 as the last resort.
ADAPTER_PORTS = (39021, 39022, 39023, 39024, 39025)
ADAPTER_HOST = "127.0.0.1"
_HEAD_LIMIT = 64 * 1024
_HANDSHAKE_TIMEOUT = 30
_TUNNEL_TIMEOUT = 20

# Stable error codes: the panel translates them (t("proxy_err_" + code)).
USER_FIELDS = ("enabled", "scheme", "host", "port", "username", "password", "bypass")


def _defaults():
    return {
        "enabled": False,
        "scheme": "socks5",
        "host": "",
        "port": DEFAULT_PORTS["socks5"],
        "username": "",
        "password": "",
        # Extra hosts Chromium must reach directly (comma separated). Chromium
        # already skips localhost on its own; this is for e.g. a LAN address.
        "bypass": "",
    }


# ── configuration ───────────────────────────────────────────────────────────
def _clean_host(value):
    """'socks5://user:pass@1.2.3.4:1080' pasted into the host field, or a bare
    hostname. Returns (host, port, scheme, username, password) with the parts
    the pasted URL carried (None where it said nothing)."""
    text = str(value or "").strip()
    if not text:
        return "", None, None, None, None
    if "://" not in text and "@" not in text and "/" not in text:
        return text, None, None, None, None
    if "://" not in text:
        text = "socks5://" + text
    try:
        parts = urlsplit(text)
    except ValueError:
        return str(value).strip(), None, None, None, None
    scheme = (parts.scheme or "").lower()
    if (parts.path or "") not in ("", "/") or parts.query or parts.fragment:
        # "socks5://user:pass@host:1080/" is a URL; ".../steam" is a mistake we
        # must not hand to Chromium, which would only truncate it silently.
        return str(value).strip(), None, None, None, None
    user = unquote(parts.username) if parts.username else None
    password = unquote(parts.password) if parts.password else None
    return ((parts.hostname or "").strip(), parts.port,
            scheme if scheme in SCHEMES else None, user, password)


def normalise(raw):
    """Validated settings dict from a loose one. Raises ValueError(<code>)."""
    cfg = _defaults()
    raw = raw if isinstance(raw, dict) else {}

    cfg["enabled"] = bool(raw.get("enabled", cfg["enabled"]))

    scheme = str(raw.get("scheme") or cfg["scheme"]).strip().lower()
    if scheme in ("socks", "socks5h"):
        scheme = "socks5"
    elif scheme in ("http", "https", "socks4", "socks5"):
        pass
    else:
        raise ValueError("proxy_err_scheme")
    cfg["scheme"] = scheme

    hostname, url_port, url_scheme, url_user, url_pass = _clean_host(raw.get("host"))
    # A pasted URL wins over the other fields: the user just typed it, and a
    # stale port left in the form would otherwise silently override it.
    if url_scheme:
        cfg["scheme"] = url_scheme
    if url_user:
        cfg["username"] = url_user
    if url_pass:
        cfg["password"] = url_pass
    if not hostname:
        if cfg["enabled"]:
            raise ValueError("proxy_err_host")
        hostname = ""
    # A bare host: no scheme, no port, no path — refuse the rest rather than
    # hand Chromium a flag it will silently ignore.
    if hostname and any(ch in hostname for ch in " /\\@?#"):
        raise ValueError("proxy_err_host")
    cfg["host"] = hostname

    port = raw.get("port")
    if url_port:
        port = url_port
    if port in (None, ""):
        port = DEFAULT_PORTS[cfg["scheme"]]
    try:
        port = int(str(port).strip())
    except (TypeError, ValueError):
        raise ValueError("proxy_err_port")
    if not 1 <= port <= 65535:
        raise ValueError("proxy_err_port")
    cfg["port"] = port

    for field in ("username", "password"):
        value = raw.get(field)
        if value is None or (field == "username" and url_user) \
                or (field == "password" and url_pass):
            continue
        cfg[field] = str(value)
    if "\n" in cfg["username"] + cfg["password"] or "\r" in cfg["username"] + cfg["password"]:
        raise ValueError("proxy_err_host")
    # No login without a username: clearing the username is how the panel
    # removes a stored password (the panel never receives the password back).
    if not cfg["username"]:
        cfg["password"] = ""

    bypass = raw.get("bypass")
    entries = [part.strip() for part in str(bypass or "").replace(";", ",").split(",")]
    cfg["bypass"] = ",".join(entry for entry in entries if entry)
    if any(ch in cfg["bypass"] for ch in "\\\"\n\r"):
        raise ValueError("proxy_err_bypass")
    return cfg


def load():
    """Settings from disk, normalised. Never raises: a broken file means off."""
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        return _defaults()
    except Exception as e:
        logger.warning(f"[proxy] ignoring unreadable {CONFIG_FILE}: {e!r}")
        return _defaults()
    try:
        return normalise(raw)
    except ValueError as e:
        logger.warning(f"[proxy] stored settings are invalid ({e}) — proxy off")
        return _defaults()


def save(values):
    """Merge `values` into the settings, validate, persist. Returns
    {"ok": True, "config": cfg} or {"ok": False, "error": <code>}.
    The file is written 0600 — it can hold a password."""
    raw = load()
    for field in USER_FIELDS:
        if field in values and values[field] is not None:
            raw[field] = values[field]
    try:
        cfg = normalise(raw)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    try:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        tmp = CONFIG_FILE + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(cfg, f)
        os.replace(tmp, CONFIG_FILE)
    except Exception as e:
        logger.warning(f"[proxy] cannot save {CONFIG_FILE}: {e!r}")
        return {"ok": False, "error": "proxy_err_save"}
    return {"ok": True, "config": cfg}


def public(cfg):
    """Settings for the panel: everything but the password, which never leaves
    the backend (the panel shows on stream, see streamer mode)."""
    out = {k: v for k, v in cfg.items() if k != "password"}
    out["has_password"] = bool(cfg.get("password"))
    return out


def is_active(cfg=None):
    cfg = cfg if cfg is not None else load()
    return bool(cfg.get("enabled") and cfg.get("host"))


def describe(cfg=None):
    """Log-safe one-liner: host:port and whether it has a login, never a secret."""
    cfg = cfg if cfg is not None else load()
    if not is_active(cfg):
        return "off"
    login = " +login" if cfg["username"] else ""
    return f"{cfg['scheme']}://{cfg['host']}:{cfg['port']}{login}"


def _hostport(cfg):
    """`host:port` as a URL authority — an IPv6 literal gets its brackets."""
    return f"[{cfg['host']}]:{cfg['port']}" if ":" in cfg["host"] else f"{cfg['host']}:{cfg['port']}"


def _upstream_url(cfg):
    """The upstream proxy as a URL, credentials included — for clients that
    speak HTTP-proxy and cannot use the bridge (a worker thread, or the moment
    before the bridge is up). SOCKS URLs only reach urllib/aiohttp by mistake,
    which is why every caller prefers `bridge_url()` first."""
    # urllib/aiohttp cannot do a proxy over TLS. Reaching an "https" proxy in
    # clear would hand its login to anyone on the path, so without the bridge
    # there is no route at all for it (callers then go direct, as before the
    # proxy setting existed).
    if cfg["scheme"] == "https":
        return None
    auth = ""
    if cfg["username"]:
        auth = f"{_quote(cfg['username'])}:{_quote(cfg['password'])}@"
    scheme = "http" if cfg["scheme"] == "http" else cfg["scheme"]
    return f"{scheme}://{auth}{_hostport(cfg)}"


def _quote(value):
    from urllib.parse import quote
    return quote(str(value), safe="")


# ── what Vesktop gets on its command line ───────────────────────────────────
def _proxy_server_value(cfg, bridge):
    """`--proxy-server` value. Chromium takes every scheme we know as-is —
    `https://` there means a proxy reached over TLS. `bridge` is the local
    bridge URL when one is running, else None (no login: Chromium can do it
    itself, and it is the only case where it can)."""
    return bridge if bridge else f"{cfg['scheme']}://{_hostport(cfg)}"


def chromium_flags(cfg=None, bridge=None):
    """Extra Electron/Chromium arguments for the proxy, or [] when it is off."""
    cfg = cfg if cfg is not None else load()
    if not is_active(cfg):
        return []
    flags = [f"--proxy-server={_proxy_server_value(cfg, bridge)}"]
    if cfg["bypass"]:
        # No `<-loopback>`: Chromium's implicit rule keeps localhost direct, and
        # naming a host here must not start routing our own panel/overlay
        # traffic (and the bridge itself) through the proxy.
        flags.append(f"--proxy-bypass-list={cfg['bypass']}")
    # Discord serves media over HTTP/3 when it can, and QUIC is UDP: a proxied
    # Chromium would lose those requests (they never reach the proxy).
    flags.append("--disable-quic")
    return flags


def env(cfg=None, bridge=None):
    """Proxy environment for helper processes (the overlay loads avatars with
    urllib). Empty when the proxy is off, so nothing changes for everyone else.
    Points at the bridge so a login travels without being put in an argv."""
    cfg = cfg if cfg is not None else load()
    if not is_active(cfg):
        return {}
    url = bridge or _upstream_url(cfg)
    if not url:
        return {}
    out = {"http_proxy": url, "https_proxy": url, "HTTP_PROXY": url, "HTTPS_PROXY": url}
    if cfg["bypass"]:
        out["no_proxy"] = cfg["bypass"]
        out["NO_PROXY"] = cfg["bypass"]
    return out


def aiohttp_proxy(cfg=None, bridge=None):
    """`proxy=` value for aiohttp, or None. aiohttp speaks HTTP only, so a
    SOCKS proxy always needs the bridge."""
    cfg = cfg if cfg is not None else load()
    if not is_active(cfg):
        return None
    return bridge or _upstream_url(cfg)


def client_proxy_url(cfg=None):
    """Proxy URL for a client that cannot start the bridge itself — urllib run
    in a worker thread (the updater). The bridge when it is up, else the
    upstream proxy directly; a login only survives the first case for SOCKS."""
    cfg = cfg if cfg is not None else load()
    if not is_active(cfg):
        return None
    return bridge_url() or _upstream_url(cfg)


def urllib_opener(cfg=None, bridge=None):
    """A urllib opener that routes through the proxy, or None (use urlopen)."""
    import urllib.request

    cfg = cfg if cfg is not None else load()
    url = client_proxy_url(cfg) if bridge is None else aiohttp_proxy(cfg, bridge)
    if not url:
        return None
    # ProxyHandler understands credentials in the URL for Basic auth; that is
    # what the bridge would add anyway, and it covers urllib's missing
    # authenticated-proxy support. The HTTPS handler is built here because
    # `open()` cannot take `context=` — the updater needs the system CA store.
    import ssl as _ssl
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": url, "https": url}),
        urllib.request.HTTPSHandler(context=_ssl_context() or _ssl.create_default_context()),
    )


# ── local bridge ────────────────────────────────────────────────────────────
class ProxyError(Exception):
    """The proxy refused, or answered something we cannot use."""


_state = {"server": None, "port": 0, "key": None, "loop": None}


def _key(cfg):
    return (cfg["scheme"], cfg["host"], cfg["port"], cfg["username"], cfg["password"])


def bridge_url():
    """The running bridge as a proxy URL, or None."""
    return f"http://{ADAPTER_HOST}:{_state['port']}" if _state["server"] else None


async def ensure_bridge(cfg=None):
    """Start (or restart) the local bridge for `cfg` and return its URL.

    Idempotent: called before every Vesktop launch and by the settings
    methods. Returns None when the proxy is off (and stops the bridge)."""
    cfg = cfg if cfg is not None else load()
    loop = asyncio.get_running_loop()
    if not is_active(cfg):
        await stop_bridge()
        return None
    if (_state["server"] is not None and _state["key"] == _key(cfg)
            and _state["loop"] is loop and _state["server"].is_serving()):
        return bridge_url()
    await stop_bridge()
    key = _key(cfg)
    server = None
    for port in ADAPTER_PORTS + (0,):
        try:
            server = await asyncio.start_server(
                lambda r, w: _handle_client(r, w, cfg), ADAPTER_HOST, port)
            break
        except OSError:
            if port == 0:
                logger.warning("[proxy] cannot open the local bridge on any port")
                return None
    if server is None:
        return None
    sockname = server.sockets[0].getsockname() if server.sockets else (ADAPTER_HOST, 0)
    _state.update(server=server, port=sockname[1], key=key, loop=loop)
    logger.info(f"[proxy] up: {describe(cfg)} (bridge {bridge_url()})")
    return bridge_url()


async def stop_bridge():
    server = _state.get("server")
    _state.update(server=None, port=0, key=None, loop=None)
    if server is not None:
        server.close()
        try:
            await server.wait_closed()
        except Exception:
            pass
        logger.info("[proxy] bridge stopped")


async def _prepare(cfg=None):
    """Bridge URL plus the Chromium flags that match it (None when off)."""
    cfg = cfg if cfg is not None else load()
    if not is_active(cfg):
        await stop_bridge()
        return cfg, None, []
    bridge = await ensure_bridge(cfg)
    if bridge is None and cfg["username"]:
        # Without the bridge Chromium cannot send the login: say so instead of
        # letting Discord fail with a 407 nobody can answer.
        logger.warning("[proxy] local bridge unavailable — the proxy login "
                       "cannot be applied; Discord may not connect")
    return cfg, bridge, chromium_flags(cfg, bridge)


async def chromium_flags_for_launch():
    """Flags to append to the Vesktop command line right now."""
    _cfg, _bridge, flags = await _prepare()
    return flags


async def _handle_client(client_reader, client_writer, cfg):
    try:
        method, target, version, head = await _read_head(client_reader)
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ValueError):
        _close(client_writer)
        return
    try:
        if method.upper() == "CONNECT":
            await _tunnel(cfg, target, client_reader, client_writer)
        else:
            await _forward(cfg, method, target, version, head, client_reader, client_writer)
    except ProxyError as e:
        logger.warning(f"[proxy] {target}: {e}")
        _respond(client_writer, 502, "Bad Gateway")
    except (asyncio.TimeoutError, OSError) as e:
        logger.warning(f"[proxy] {target}: {e!r}")
        _respond(client_writer, 502, "Bad Gateway")
    except Exception as e:  # never kill the server task on one bad request
        logger.warning(f"[proxy] {target}: unexpected {e!r}")
        _close(client_writer)
    finally:
        try:
            await client_writer.wait_closed()
        except Exception:
            pass


async def _read_head(reader):
    """(method, target, version, raw-head-without-final-blank-line)."""
    raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), _HANDSHAKE_TIMEOUT)
    if len(raw) > _HEAD_LIMIT:
        raise ValueError("head too large")
    text = raw.decode("latin-1")
    head = text[:-4]
    request_line = head.split("\r\n", 1)[0]
    parts = request_line.split(" ")
    if len(parts) != 3:
        raise ValueError(f"bad request line {request_line!r}")
    return parts[0], parts[1], parts[2], head


async def _tunnel(cfg, target, client_reader, client_writer):
    """CONNECT host:port — the path every Discord (WSS/HTTPS) connection takes."""
    hostname, port = _split_target(target)
    try:
        up_reader, up_writer = await _dial_upstream(cfg, hostname, port)
    except ProxyError:
        raise
    except (OSError, asyncio.TimeoutError) as e:
        raise ProxyError(f"upstream {describe(cfg)} unreachable ({e!r})")
    client_writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
    try:
        await client_writer.drain()
    except OSError:
        _close(up_writer)
        return
    await _splice(client_reader, client_writer, up_reader, up_writer)


def _split_target(target):
    """'host:443', '[::1]:443' -> (host, port)."""
    if target.startswith("["):
        end = target.find("]")
        if end < 0 or ":" not in target[end:]:
            raise ProxyError(f"bad CONNECT target {target!r}")
        try:
            return target[1:end], int(target[end + 1:].lstrip(":"))
        except ValueError:
            raise ProxyError(f"bad CONNECT target {target!r}")
    if ":" not in target:
        raise ProxyError(f"bad CONNECT target {target!r}")
    hostname, _, port = target.rpartition(":")
    try:
        return hostname, int(port)
    except ValueError:
        raise ProxyError(f"bad CONNECT target {target!r}")


async def _dial_upstream(cfg, hostname, port):
    """Open a tunnel to hostname:port through the configured proxy.
    Returns (reader, writer) sitting inside that tunnel."""
    scheme = cfg["scheme"]
    if scheme in ("http", "https"):
        reader, writer = await _open(cfg)
        auth = ""
        if cfg["username"]:
            token = base64.b64encode(
                f"{cfg['username']}:{cfg['password']}".encode()).decode()
            auth = f"Proxy-Authorization: Basic {token}\r\n"
        writer.write(
            f"CONNECT {hostname}:{port} HTTP/1.1\r\n"
            f"Host: {hostname}:{port}\r\n"
            f"Proxy-Connection: keep-alive\r\n{auth}\r\n".encode("latin-1"))
        await writer.drain()
        status = await asyncio.wait_for(reader.readuntil(b"\r\n"), _TUNNEL_TIMEOUT)
        line = status.decode("latin-1").strip()
        parts = line.split(" ")
        if len(parts) < 2 or parts[1] != "200":
            body = await _drain_reply(reader)
            _close(writer)
            raise ProxyError(f"proxy refused CONNECT ({line!r}) {body}")
        # Swallow the rest of the CONNECT response headers.
        while True:
            line = await asyncio.wait_for(reader.readuntil(b"\r\n"), _TUNNEL_TIMEOUT)
            if line in (b"\r\n", b"\n"):
                break
            if line.startswith(b"Proxy-Authenticate") and not cfg["username"]:
                _close(writer)
                raise ProxyError("proxy wants a login — set username/password")
        return reader, writer
    if scheme == "socks5":
        return await _socks5(cfg, hostname, port)
    if scheme == "socks4":
        return await _socks4(cfg, hostname, port)
    raise ProxyError(f"unsupported proxy scheme {scheme!r}")


async def _drain_reply(reader):
    try:
        chunk = await asyncio.wait_for(reader.read(512), 2)
        return chunk.decode("latin-1", "replace").strip()
    except Exception:
        return ""


async def _open(cfg):
    use_tls = cfg["scheme"] == "https"
    ctx = _ssl_context() if use_tls else None
    return await asyncio.wait_for(
        asyncio.open_connection(cfg["host"], cfg["port"], ssl=ctx,
                                server_hostname=cfg["host"] if use_tls else None),
        _TUNNEL_TIMEOUT)


async def _socks5(cfg, hostname, port):
    reader, writer = await _open(cfg)
    try:
        if cfg["username"]:
            writer.write(b"\x05\x02\x00\x02")
        else:
            writer.write(b"\x05\x01\x00")
        await writer.drain()
        version, method = await _readexactly(reader, 2)
        if method == 0x02:
            if not cfg["username"]:
                raise ProxyError("SOCKS5 proxy wants a login — set username/password")
            user = cfg["username"].encode()[:255]
            password = cfg["password"].encode()[:255]
            writer.write(b"\x01" + bytes([len(user)]) + user + bytes([len(password)]) + password)
            await writer.drain()
            _ver, status = await _readexactly(reader, 2)
            if status != 0:
                raise ProxyError("SOCKS5 login refused")
        elif method != 0x00:
            raise ProxyError("SOCKS5 proxy accepted no auth method")
        name = hostname.encode("idna") if not _is_ip(hostname) else hostname.encode()
        if _is_ip(hostname):
            address = (b"\x01" + ipaddress.ip_address(hostname).packed
                       if ":" not in hostname else b"\x04" + ipaddress.ip_address(hostname).packed)
        else:
            address = b"\x03" + bytes([len(name)]) + name
        writer.write(b"\x05\x01\x00" + address + struct.pack(">H", port))
        await writer.drain()
        _ver, status, _rsv, atyp = await _readexactly(reader, 4)
        if status != 0:
            raise ProxyError(f"SOCKS5 connect refused (code {status})")
        if atyp == 0x01:
            await _readexactly(reader, 4)
        elif atyp == 0x04:
            await _readexactly(reader, 16)
        elif atyp == 0x03:
            (length,) = await _readexactly(reader, 1)
            await _readexactly(reader, length)
        await _readexactly(reader, 2)
        return reader, writer
    except Exception:
        _close(writer)
        raise


async def _socks4(cfg, hostname, port):
    reader, writer = await _open(cfg)
    try:
        user = cfg["username"].encode()[:255]
        if _is_ip(hostname) and ":" not in hostname:
            address = ipaddress.ip_address(hostname).packed
            tail = b""
        else:
            # SOCKS4a: 0.0.0.x means "the name follows", so DNS happens at the
            # proxy — the whole point when the ISP blocks the name.
            address = b"\x00\x00\x00\x01"
            tail = hostname.encode("idna") + b"\x00"
        writer.write(b"\x04\x01" + struct.pack(">H", port) + address + user + b"\x00" + tail)
        await writer.drain()
        _ver, status = await _readexactly(reader, 2)
        if status != 0x5A:
            raise ProxyError(f"SOCKS4 connect refused (code {status})")
        await _readexactly(reader, 6)
        return reader, writer
    except Exception:
        _close(writer)
        raise


async def _forward(cfg, method, target, version, head, client_reader, client_writer):
    """Plain http:// request (no CONNECT). Discord itself is all TLS, so this
    only covers the odd http URL a page might still emit; SOCKS proxies are
    reached the same way, with the request rewritten to origin-form."""
    parts = urlsplit(target)
    if parts.scheme not in ("http",) or not parts.hostname:
        _respond(client_writer, 400, "Bad Request")
        return
    port = parts.port or 80
    if cfg["scheme"] in ("http", "https"):
        reader, writer = await _open(cfg)
        lines = [f"{method} {target} {version}"]
        for line in head.split("\r\n")[1:]:
            if not line:
                continue
            name = line.split(":", 1)[0].strip().lower()
            if name in ("proxy-authorization", "proxy-connection"):
                continue
            lines.append(line)
        if cfg["username"]:
            token = base64.b64encode(
                f"{cfg['username']}:{cfg['password']}".encode()).decode()
            lines.append(f"Proxy-Authorization: Basic {token}")
        writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
    else:
        reader, writer = await _dial_upstream(cfg, parts.hostname, port)
        origin_form = parts.path or "/"
        if parts.query:
            origin_form += "?" + parts.query
        lines = [f"{method} {origin_form} {version}"] + head.split("\r\n")[1:]
        writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
    try:
        await writer.drain()
    except OSError:
        _close(writer)
        return
    await _splice(client_reader, client_writer, reader, writer)


async def _splice(client_reader, client_writer, up_reader, up_writer):
    async def pump(source, sink):
        try:
            while True:
                data = await source.read(65536)
                if not data:
                    break
                sink.write(data)
                await sink.drain()
        except (asyncio.IncompleteReadError, OSError, asyncio.CancelledError):
            pass
        finally:
            try:
                if sink.can_write_eof():
                    sink.write_eof()
            except Exception:
                pass

    tasks = [asyncio.ensure_future(pump(client_reader, up_writer)),
             asyncio.ensure_future(pump(up_reader, client_writer))]
    try:
        # One side done = tunnel done. Chromium closes its sockets outright,
        # never half-way; waiting for the other direction kept every finished
        # connection (and its upstream socket) open until the remote server
        # timed it out.
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        _close(up_writer)
        _close(client_writer)


async def _readexactly(reader, count):
    return await asyncio.wait_for(reader.readexactly(count), _TUNNEL_TIMEOUT)


def _is_ip(text):
    try:
        ipaddress.ip_address(text)
        return True
    except ValueError:
        return False


def _respond(writer, status, reason):
    try:
        writer.write(
            f"HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\n"
            "Connection: close\r\n\r\n".encode())
    except Exception:
        pass
    _close(writer)


def _close(writer):
    try:
        writer.close()
    except Exception:
        pass


def _ssl_context():
    """System CA store: Decky's embedded Python ships no bundle (same trap as
    the updater and the attachment save). Never disables verification."""
    for ca in ("/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/certs/ca-certificates.crt",
               "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", "/etc/ssl/cert.pem"):
        if os.path.exists(ca):
            try:
                return ssl.create_default_context(cafile=ca)
            except Exception:
                pass
    try:
        return ssl.create_default_context()
    except Exception:
        return None


# ── settings button: "Test" ─────────────────────────────────────────────────
async def test(cfg=None):
    """Reach Discord through the configured proxy. {"ok", "ms"} or
    {"ok": False, "error": <code>}."""
    import time

    from aiohttp import ClientSession, ClientTimeout, TCPConnector  # type: ignore

    cfg = cfg if cfg is not None else load()
    if not is_active(cfg):
        return {"ok": False, "error": "proxy_err_off"}
    loop = asyncio.get_running_loop()
    bridge = await ensure_bridge(cfg)
    url = aiohttp_proxy(cfg, bridge)
    started = time.monotonic()
    try:
        connector = TCPConnector(ssl=_ssl_context())
        async with ClientSession(connector=connector,
                                 timeout=ClientTimeout(total=20)) as session:
            async with session.get("https://discord.com/api/v9/gateway",
                                   proxy=url) as resp:
                elapsed = int((time.monotonic() - started) * 1000)
                if resp.status >= 500:
                    return {"ok": False, "error": "proxy_err_discord", "ms": elapsed}
                # Any answer from Discord means the route works, login or not:
                # 200 has a url, 401/429 still proves we reached the API.
                return {"ok": True, "ms": elapsed, "status": resp.status}
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.warning(f"[proxy] test through {describe(cfg)} failed: {e!r}")
        return {"ok": False, "error": "proxy_err_unreachable"}
