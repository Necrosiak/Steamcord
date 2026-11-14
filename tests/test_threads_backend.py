"""#100: arguments of get_threads/create_thread are cleaned before reaching Discord."""
import types
import unittest
from unittest.mock import AsyncMock

from test_audio_overlay_regressions import methods


class ThreadsBackendTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.p = methods({'_thread_tags', 'get_threads', 'create_thread'})
        self.api = types.SimpleNamespace(get_threads=AsyncMock(return_value={'threads': []}),
                                         create_thread=AsyncMock(return_value={'id': '1'}))
        self.p.evt_handler = types.SimpleNamespace(api=self.api)

    async def test_get_threads_cleans_offset_name_and_tags(self):
        await self.p.get_threads(42, '25', '  door  ', ['1', 'x', 2, '../3'])
        self.api.get_threads.assert_awaited_with('42', 25, 'door', ['1', '2'])
        await self.p.get_threads('42', 'bad', None, 'not-a-list')
        self.api.get_threads.assert_awaited_with('42', 0, '', [])
        await self.p.get_threads('42', -5, 'x' * 300)
        self.assertEqual(self.api.get_threads.await_args.args[1:3], (0, 'x' * 100))

    async def test_older_frontend_without_filters_still_works(self):
        await self.p.get_threads('42')
        self.api.get_threads.assert_awaited_with('42', 0, '', [])

    async def test_create_thread_trims_and_filters_tags(self):
        await self.p.create_thread(42, '  Title ', ' body ', ['7', 'nope'])
        self.api.create_thread.assert_awaited_with('42', 'Title', 'body', ['7'])
        await self.p.create_thread('42', 'T')
        self.api.create_thread.assert_awaited_with('42', 'T', '', [])


if __name__ == '__main__':
    unittest.main()
