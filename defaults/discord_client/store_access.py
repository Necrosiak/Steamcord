from asyncio import Event, wait_for

class User:
    def __init__(self, data) -> None:
        self.id = data["id"]
        self.name = data["username"]
        self.discriminator = data["discriminator"]
        self.avatar = data["avatar"]

        self.is_muted = False
        self.is_deafened = False
        self.is_live = False        # partage d'écran (Go Live)
        self.is_video = False       # caméra activée
        self.is_speaking = False

    @classmethod
    def from_vc(self, data):
        usr = User({"id": data["userId"], "username": "", "discriminator": None, "avatar": ""})
        usr.is_muted = data["mute"]
        usr.is_deafened = data["deaf"]
        usr.is_speaking = False
        return usr

    async def populate(self, api):
        if self.name:
            return

        r = await api.get_user(self.id)
        self.name = r["username"]
        self.discriminator = r["discriminator"]
        self.avatar = r["avatar"]

    def to_dict(self):
        return {
            "id": self.id,
            "username": str(self),
            "avatar": self.avatar,
            "is_muted": self.is_muted,
            "is_deafened": self.is_deafened,
            "is_live": self.is_live,
            "is_video": self.is_video,
            "is_speaking": self.is_speaking,
        }

    def __str__(self) -> str:
        return f"{self.name}{'#'+self.discriminator if self.discriminator and self.discriminator != '0' else ''}"


class Response:
    def __init__(self) -> None:
        self.lock = Event()
        self.response = None


class StoreAccess:
    def __init__(self) -> None:
        self.request_increment = 0
        self.requests = {}
        # Posé par EventHandler.main() à la connexion du client injecté. Avant
        # ça (ou pendant une re-init Vesktop), il n'existait PAS → AttributeError
        # brut dans le QAM.
        self.ws = None

    def _set_result(self, increment, result):
        # .get : la réponse peut arriver APRÈS le timeout de la requête (entrée
        # déjà retirée) — un KeyError ici tuerait la boucle d'events du ws.
        response = self.requests.get(increment)
        if response is None:
            return
        response.result = result
        response.lock.set()

    async def _store_access_request(self, command, id="", **kwargs):
        # Bascule Bureau↔gamemode : Vesktop meurt et le ws client traîne en
        # fermeture pendant la re-init (~2 min). Échouer NET avec un code stable
        # que le frontend traduit, au lieu d'exposer « Cannot write to closing
        # transport » brut dans le QAM.
        if self.ws is None or self.ws.closed:
            raise Exception("discord_reconnecting")
        self.request_increment += 1
        increment = self.request_increment
        response = Response()
        self.requests[increment] = response
        try:
            await self.ws.send_json({"type": command, "id": id, "increment": increment, **kwargs})
            # Si le ws meurt entre l'envoi et la réponse, lock n'est jamais posé
            # → sans timeout l'appel Decky resterait suspendu pour toujours
            # (spinner infini côté QAM).
            await wait_for(response.lock.wait(), timeout=30)
        except Exception:
            raise Exception("discord_reconnecting")
        finally:
            self.requests.pop(increment, None)
        return response.result

    async def get_user(self, id):
        return await self._store_access_request("$getuser", id)

    async def get_channel(self, id):
        return await self._store_access_request("$getchannel", id)

    async def get_guild(self, id):
        return await self._store_access_request("$getguild", id)

    async def get_media(self):
        return await self._store_access_request("$getmedia")

    async def get_last_channels(self):
        return await self._store_access_request("$get_last_channels")

    async def post_screenshot(self, channel_id, data):
        return await self._store_access_request("$screenshot", channel_id=channel_id, attachment_b64=data)

    async def get_screen_bounds(self):
        return await self._store_access_request("$get_screen_bounds")

    async def get_guilds_vc(self):
        return await self._store_access_request("$get_guilds_vc")

    async def join_vc(self, channel_id, guild_id):
        return await self._store_access_request("$join_vc", id=channel_id, guild_id=guild_id)

    async def get_voice_states(self, channel_id):
        return await self._store_access_request("$get_voice_states", id=channel_id)

    async def get_dm_channels(self):
        return await self._store_access_request("$get_dm_channels")

    async def dm_call(self, channel_id, join_existing=False):
        return await self._store_access_request("$dm_call", id=channel_id, join_existing=join_existing)

    async def get_text_channels(self):
        return await self._store_access_request("$get_text_channels")

    async def get_messages(self, channel_id, before=None):
        return await self._store_access_request("$get_messages", id=channel_id, before=before)

    async def send_message(self, channel_id, content):
        return await self._store_access_request("$send_message", id=channel_id, content=content)

    async def get_local_mute(self, user_id):
        return await self._store_access_request("$get_local_mute", id=user_id)

    async def get_user_volume(self, user_id, context="default"):
        return await self._store_access_request("$get_user_volume", id=user_id, context=context)

    async def toggle_local_mute(self, user_id):
        return await self._store_access_request("$toggle_local_mute", id=user_id)
    async def set_local_mute(self, user_id, muted):
        return await self._store_access_request("$set_local_mute", id=user_id, muted=muted)

    async def get_audio_processing(self):
        return await self._store_access_request("$get_audio_processing")

    async def set_noise_reduction(self, mode):
        return await self._store_access_request("$set_noise_reduction", mode=mode)

    async def set_echo_cancellation(self, enabled):
        return await self._store_access_request("$set_echo_cancellation", enabled=enabled)

    async def set_automatic_gain_control(self, enabled):
        return await self._store_access_request("$set_automatic_gain_control", enabled=enabled)
