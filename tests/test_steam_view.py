import importlib.util
from pathlib import Path
import types
import unittest
from unittest.mock import AsyncMock

spec=importlib.util.spec_from_file_location('steam_view',Path(__file__).resolve().parents[1]/'defaults/tab_utils/steam_view.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class SteamView(unittest.IsolatedAsyncioTestCase):
    async def test_supported_view_is_waited_for_and_reports_success(self):
        tab=types.SimpleNamespace(ensure_open=AsyncMock(),evaluate=AsyncMock(return_value={'result':{'result':{'value':True}}}))
        self.assertTrue(await module.set_voice_view(tab,True))
        tab.ensure_open.assert_awaited_once()
        self.assertTrue(tab.evaluate.await_args.kwargs['wait'])
        self.assertNotIn('__VISIBLE__',tab.evaluate.await_args.args[0])

    async def test_missing_tab_invalid_reply_or_cdp_failure_are_safe(self):
        self.assertFalse(await module.set_voice_view(None,True))
        tab=types.SimpleNamespace(ensure_open=AsyncMock(),evaluate=AsyncMock(return_value={'result':{}}))
        self.assertFalse(await module.set_voice_view(tab,False))
        tab.evaluate.side_effect=RuntimeError('CDP unavailable')
        self.assertFalse(await module.set_voice_view(tab,True))
        tab.evaluate.reset_mock();self.assertFalse(await module.set_voice_view(tab,'true'));tab.evaluate.assert_not_awaited()
