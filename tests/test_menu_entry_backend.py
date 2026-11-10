"""#86: the Steam menu entry choice is kept in steamcord-view.json."""
import json
import os
import tempfile
import unittest

from test_audio_overlay_regressions import methods


class MenuEntryBackendTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.p = methods({'get_open_view', 'set_open_view'})
        self.tmp = tempfile.TemporaryDirectory()
        self.p._VIEW_CFG = os.path.join(self.tmp.name, 'steamcord-view.json')
        self.p._VIEW_TOPS, self.p._VIEW_SRCS = ('voice', 'text'), ('servers', 'dms')
        self.p._VIEW_BIGS, self.p._VIEW_MENUS, self.p._VEIL_MIN = ('qam', 'big'), ('on', 'off'), 60

    def tearDown(self):
        self.tmp.cleanup()

    async def test_menu_choice_round_trips_and_keeps_other_values(self):
        await self.p.set_open_view('text', None, None, 80)
        self.assertEqual((await self.p.set_open_view(None, None, None, None, 'off'))['ok'], True)
        view = await self.p.get_open_view()
        self.assertEqual((view['menu'], view['top'], view['veil']), ('off', 'text', 80))
        # An older frontend sends only the first four values: the menu stays.
        await self.p.set_open_view('voice', None)
        self.assertEqual((await self.p.get_open_view())['menu'], 'off')

    async def test_unknown_or_hand_edited_values_are_rejected(self):
        self.assertFalse((await self.p.set_open_view(None, None, None, None, 'maybe'))['ok'])
        with open(self.p._VIEW_CFG, 'w') as f:
            json.dump({'menu': True}, f)
        self.assertIsNone((await self.p.get_open_view())['menu'])


if __name__ == '__main__':
    unittest.main()
