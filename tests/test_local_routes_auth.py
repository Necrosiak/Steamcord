import types
import unittest
from unittest.mock import AsyncMock, Mock
from test_audio_overlay_regressions import methods

class LocalRoutes(unittest.IsolatedAsyncioTestCase):
    async def test_unauthenticated_calls_have_no_side_effects(self):
        names={'_openkb','_voice_render','_voice_hide','_pov_feed','_serve_clip'}
        p=methods(names, local_key_ok=lambda request:request.query.get('k')=='session-secret',
                  Response=lambda status=200,**_:types.SimpleNamespace(status=status),
                  WebSocketResponse=Mock(side_effect=AssertionError('unauthenticated websocket prepared')),
                  setOSK=AsyncMock())
        p.shared_js_tab=types.SimpleNamespace(ensure_open=AsyncMock(),evaluate=AsyncMock())
        p._await_shared_tab=AsyncMock(return_value=None)
        p._clip_index={}
        for name in sorted(names):
            with self.subTest(route=name):
                response=await getattr(p,name)(types.SimpleNamespace(query={}))
                self.assertEqual(response.status,403)
        p.shared_js_tab.ensure_open.assert_not_awaited()
        p.shared_js_tab.evaluate.assert_not_awaited()

    async def test_valid_key_allows_keyboard_command(self):
        osk=AsyncMock()
        p=methods({'_openkb'}, local_key_ok=lambda r:r.query.get('k')=='session-secret',
                  Response=lambda status=200,**_:types.SimpleNamespace(status=status),setOSK=osk)
        p.shared_js_tab=types.SimpleNamespace(ensure_open=AsyncMock())
        response=await p._openkb(types.SimpleNamespace(query={'k':'session-secret'}))
        self.assertEqual(response.status,200)
        osk.assert_awaited_once_with(p.shared_js_tab,True)

import os
import secrets
import tempfile

class ClipTokens(unittest.IsolatedAsyncioTestCase):
    async def test_tokens_are_random_and_stable_during_one_session(self):
        p=methods({'list_videos'},_secrets=secrets,
                  _steam_clips=lambda:[('/fixture/clip', '123', 42, 1)],_list_videos=lambda:[],
                  DISCORD_UPLOAD_LIMIT=1024,DISCORD_PLAYABLE=('.mp4',))
        p._clip_tokens={};p._clip_index={}
        first=(await p.list_videos())[0]['token']
        self.assertGreaterEqual(len(first),32)
        self.assertEqual((await p.list_videos())[0]['token'],first)
        p._clip_tokens={}
        self.assertNotEqual((await p.list_videos())[0]['token'],first)
