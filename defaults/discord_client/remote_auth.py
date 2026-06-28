import io
import base64
import asyncio
import segno


def _make_qr_b64(url: str) -> str:
    qr = segno.make(url, error="L")
    buf = io.BytesIO()
    qr.save(buf, kind="svg", scale=6, border=2)
    return "data:image/svg+xml;base64," + base64.b64encode(buf.getvalue()).decode()


class RemoteAuth:
    """State holder for QR code. The actual remote auth protocol runs in steamcord_client.js."""

    def __init__(self):
        self.qr_b64 = None
        self._done = asyncio.Event()  # kept for watcher compatibility

    def start(self, on_state_change):
        pass  # JS handles the remote auth

    def stop(self):
        self.qr_b64 = None


import json
import ssl
from aiohttp import ClientSession


DISCORD_DESKTOP_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) discord/0.0.56 Chrome/120.0.6099.115 "
    "Electron/28.1.4 Safari/537.36"
)

REMOTE_AUTH_LOGIN_URL = "https://discord.com/api/v9/users/@me/remote-auth/login"


async def exchange_ticket(ticket: str, priv_jwk_json: str):
    """POST ticket to Discord. Returns (token, captcha_needed)."""
    import ssl as ssl_mod
    ssl_ctx = ssl_mod.create_default_context(cafile="/etc/ssl/certs/ca-bundle.crt")

    headers = {
        "Content-Type": "application/json",
        "User-Agent": DISCORD_DESKTOP_UA,
        "X-Discord-Locale": "fr",
        "X-Discord-Timezone": "Europe/Paris",
    }
    try:
        async with ClientSession(headers=headers) as session:
            async with session.post(
                REMOTE_AUTH_LOGIN_URL,
                json={"ticket": ticket},
                ssl=ssl_ctx,
                timeout=__import__('aiohttp').ClientTimeout(total=20),
            ) as resp:
                body = await resp.json()
                if resp.status == 400 and "captcha_key" in body:
                    import logging
                    logging.getLogger(__name__).error(
                        f"exchange_ticket: status={resp.status} keys={list(body.keys())}"
                    )
                    return None, True
                if resp.status != 200 or "encrypted_token" not in body:
                    import logging
                    logging.getLogger(__name__).error(
                        f"exchange_ticket: status={resp.status} keys={list(body.keys())}"
                    )
                    return None, False
                enc_b64 = body["encrypted_token"]

        # Decrypt encrypted_token with RSA private key (OAEP-SHA256)
        from cryptography.hazmat.primitives.asymmetric.padding import OAEP, MGF1
        from cryptography.hazmat.primitives.hashes import SHA256
        from cryptography.hazmat.primitives.serialization import load_pem_private_key
        from cryptography.hazmat.backends import default_backend
        import json as _json

        jwk = _json.loads(priv_jwk_json)
        # Build RSA key from JWK
        from cryptography.hazmat.primitives.asymmetric.rsa import (
            RSAPrivateNumbers, RSAPublicNumbers
        )
        def _b64url_to_int(s):
            padded = s + "=" * (-len(s) % 4)
            return int.from_bytes(base64.urlsafe_b64decode(padded), "big")

        n, e = _b64url_to_int(jwk["n"]), _b64url_to_int(jwk["e"])
        d = _b64url_to_int(jwk["d"])
        p, q = _b64url_to_int(jwk["p"]), _b64url_to_int(jwk["q"])
        dp = _b64url_to_int(jwk["dp"])
        dq = _b64url_to_int(jwk["dq"])
        qi = _b64url_to_int(jwk["qi"])

        pub = RSAPublicNumbers(e, n)
        priv = RSAPrivateNumbers(p, q, d, dp, dq, qi, pub).private_key(default_backend())

        enc_bytes = base64.b64decode(enc_b64)
        token_bytes = priv.decrypt(enc_bytes, OAEP(mgf=MGF1(SHA256()), algorithm=SHA256(), label=None))
        return token_bytes.decode(), False
    except Exception as ex:
        import logging
        logging.getLogger(__name__).error(f"exchange_ticket error: {ex}")
        return None, False
