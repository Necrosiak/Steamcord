import asyncio
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

from test_audio_overlay_regressions import methods
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cloud_game', ROOT/'defaults/discord_client/cloud_game.py')
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)


class CloudGameTests(unittest.TestCase):
    def test_only_explicit_launcher_names_are_eligible(self):
        for name in ('GeForce NOW', 'NVIDIA GeForce NOW', 'GeForceNOW'):
            self.assertTrue(cloud.is_geforce_launcher(name))
        for name in ('Chrome', 'Portal 2', 'GeForceNOW-presence', 'GeForce Experience'):
            self.assertFalse(cloud.is_geforce_launcher(name))
        with patch.object(cloud, '_native_linux_pids') as probe:
            self.assertEqual(cloud.detect_geforce_game('Portal 2')['reason'], 'not_gfn')
            probe.assert_not_called()

    def test_title_formats_and_punctuation(self):
        for title, game in [('Portal 2 on GeForce NOW', 'Portal 2'),
                            ('Baldur’s Gate 3 — NVIDIA GeForce NOW', 'Baldur’s Gate 3'),
                            ('GeForce NOW - Half-Life 2', 'Half-Life 2'),
                            ('Cyberpunk 2077™', 'Cyberpunk 2077'),
                            ('Metro: Last Light - GeForce NOW', 'Metro: Last Light')]:
            self.assertEqual(cloud.game_from_title(title), game)
        for name in ('Terrorbane', 'The Error Within', 'Loading Human'):
            self.assertEqual(cloud.game_from_title(name+' on GeForce NOW'), name)
        for title in ('GeForce NOW', 'NVIDIA GeForce NOW', 'GeForce NOW - Games',
                      'GeForce NOW - Library', 'Application Launch failed', 'Loading',
                      'Accueil', 'GeForce NOW - Connecting…', 'GeForce NOW - Error code: 123', 'Portal 2\nsecret', '\0', 'x' * 301):
            self.assertIsNone(cloud.game_from_title(title), title)

    def test_process_probe_does_not_match_installers_browsers_or_presence_tools(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for pid, command in {'1':b'/app/GeForceNOW\0', '2':b'/usr/bin/chrome\0https://play.geforcenow.com\0',
                                 '3':b'/bin/geforcenow-presence\0', '4':b'/bin/sh\0GeForceNOW\0'}.items():
                (root/pid).mkdir(); (root/pid/'cmdline').write_bytes(command)
            self.assertEqual(cloud._native_linux_pids(root), {1})

    def test_x11_checks_native_class_and_uses_supplied_display(self):
        env = {'DISPLAY':':7', 'XAUTHORITY':'fixture', 'PATH':'fixture'}
        def run(args, **kwargs):
            self.assertEqual(kwargs['env'], env)
            self.assertNotIn('shell', kwargs)
            if '-root' in args:
                out = '_NET_CLIENT_LIST(WINDOW): window id # 0x1, 0x2, 0x3'
            else:
                wid = args[args.index('-id')+1]
                out = {'0x1':'WM_CLASS(STRING) = "chrome", "Google-chrome"\n_NET_WM_NAME(UTF8_STRING) = "Fake Game on GeForce NOW"',
                       '0x2':'WM_CLASS(STRING) = "geforcenow", "GeForceNOW"\n_NET_WM_NAME(UTF8_STRING) = "Portal 2 on GeForce NOW"',
                       '0x3':'WM_CLASS(STRING) = "geforcenow-presence", "geforcenow-presence"\nWM_NAME(STRING) = "Other Game"'}[wid]
            return types.SimpleNamespace(returncode=0, stdout=out)
        self.assertEqual(cloud._x11_titles(env, run=run, which=lambda *a, **k:'fixture'), ['Portal 2 on GeForce NOW'])

    def test_gamescope_root_children_fallback_and_unavailable_tools(self):
        def run(args, **kwargs):
            out = ('No such atom' if args[0]=='xprop' and '-root' in args else
                   '     0x44 "Portal 2" ("geforcenow" "GeForceNOW")' if args[0]=='xwininfo' else
                   'WM_CLASS(STRING) = "geforcenow", "com.nvidia.geforcenow"\nWM_NAME(STRING) = "Portal 2"')
            return types.SimpleNamespace(returncode=0, stdout=out)
        self.assertEqual(cloud._x11_titles({'DISPLAY':':2'}, run=run, which=lambda *a,**k:'fixture'), ['Portal 2'])
        self.assertIsNone(cloud._x11_titles({}, run=run, which=lambda *a,**k:'fixture'))
        self.assertIsNone(cloud._x11_titles({'DISPLAY':':2'}, run=run, which=lambda *a,**k:None))

    def test_timeout_and_ambiguous_windows_do_not_retain_a_previous_game(self):
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired('xprop', .4)
        self.assertIsNone(cloud._x11_titles({'DISPLAY':':2'}, run=timeout, which=lambda *a,**k:'fixture'))
        with patch.object(cloud.sys, 'platform', 'linux'), patch.object(cloud, '_native_linux_pids', return_value={42}), patch.object(cloud, '_x11_titles') as titles:
            for value, reason, game in [(['Portal 2'], 'detected', 'Portal 2'),
                                        (['Portal 2','Half-Life 2'], 'ambiguous', None),
                                        (['GeForce NOW'], 'no_game', None),
                                        (None, 'unavailable', None)]:
                titles.return_value=value
                report=cloud.detect_geforce_game('GeForce NOW', {})
                self.assertEqual((report['reason'],report['game']), (reason,game))

    def test_report_counts_window_and_title_kinds_without_titles(self):
        self.assertEqual(cloud.classify_title('GeForce NOW'), ('branding', None))
        self.assertEqual(cloud.classify_title('NVIDIA GeForce NOW'), ('branding', None))
        self.assertEqual(cloud.classify_title('GeForce NOW - Library'), ('page', None))
        self.assertEqual(cloud.classify_title('Error code: 7'), ('page', None))
        self.assertEqual(cloud.classify_title('Portal 2\nsecret'), ('invalid', None))
        self.assertEqual(cloud.classify_title('GeForce NOW Beta (Portal 2)'), ('unknown', None))
        self.assertEqual(cloud.classify_title('Portal 2 on GeForce NOW'), ('game', 'Portal 2'))
        def fake_titles(env, stats=None):
            stats['windows'] = 9
            return ['GeForce NOW', 'Secret Game Title - GeForce NOW Beta']
        with patch.object(cloud.sys, 'platform', 'linux'), patch.object(cloud, '_native_linux_pids', return_value={42}), \
                patch.object(cloud, '_x11_titles', side_effect=fake_titles):
            report = cloud.detect_geforce_game('GeForce NOW', {})
        self.assertEqual(report, {'game': None, 'reason': 'no_game', 'source': 'x11-title', 'windows': 9,
                                  'gfn_windows': 2, 'title_kinds': {'branding': 1, 'unknown': 1}})
        self.assertNotIn('Secret', repr(report))

    def test_x11_reports_how_many_windows_were_inspected(self):
        def run(args, **kwargs):
            out = ('_NET_CLIENT_LIST(WINDOW): window id # 0x1, 0x2, 0x2' if '-root' in args else
                   'WM_CLASS(STRING) = "steam", "Steam"\n_NET_WM_NAME(UTF8_STRING) = "Steam"')
            return types.SimpleNamespace(returncode=0, stdout=out)
        stats = {}
        self.assertEqual(cloud._x11_titles({'DISPLAY': ':2'}, run=run, which=lambda *a, **k: 'fixture', stats=stats), [])
        self.assertEqual(stats, {'windows': 2})

    def test_windows_uses_only_native_process_owners(self):
        host = types.SimpleNamespace(processes=lambda:[(1,r'C:\GFN\GeForceNOW.exe'), (2,r'C:\Browser\chrome.exe')])
        with patch.dict(sys.modules, {'host':host}), patch.object(cloud.sys, 'platform', 'win32'), patch.object(cloud, '_windows_titles', return_value=['Portal 2']) as titles:
            self.assertEqual(cloud.detect_geforce_game('NVIDIA GeForce NOW')['game'], 'Portal 2')
            titles.assert_called_once_with({1})


class CloudRpcTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.p = methods({'_rpc_payload'}, _desktop_session=lambda:False, _running_executables=lambda:['game.exe'])
        self.p._rpc_game, self.p._rpc_since = 'GeForce NOW', 123
        self.p._rpc_pref=Mock(return_value=True)
        self.p._rpc_detect_pref=Mock(return_value=True)
        self.p._rpc_override_pref=Mock(return_value='')
        self.detector=Mock(return_value={'game':'Portal 2', 'reason':'detected', 'source':'x11-title'})
        self.mods = {'discord_client.cloud_game':types.SimpleNamespace(is_geforce_launcher=cloud.is_geforce_launcher, detect_geforce_game=self.detector),
                     'vesktop':types.SimpleNamespace(_user_env=lambda:{'DISPLAY':':0'},_steam_display_env=lambda:{'DISPLAY':':7','XAUTHORITY':'current'})}

    async def test_cloud_title_is_sent_with_correct_display_and_without_local_game_candidates(self):
        with patch.dict(sys.modules,self.mods):
            payload=await self.p._rpc_payload()
        self.assertEqual(payload['cloud_game'],'Portal 2')
        self.assertEqual(payload['game'],'GeForce NOW')
        self.assertEqual(payload['procs'],[])
        self.detector.assert_called_once_with('GeForce NOW',{'DISPLAY':':7','XAUTHORITY':'current'})

    async def test_manual_title_disabled_detection_or_disabled_presence_skip_queries(self):
        with patch.dict(sys.modules,self.mods):
            self.p._rpc_override_pref.return_value='My title'
            self.assertIsNone((await self.p._rpc_payload())['cloud_game'])
            self.p._rpc_override_pref.return_value=''
            self.p._rpc_detect_pref.return_value=False
            await self.p._rpc_payload()
            self.p._rpc_detect_pref.return_value=True
            self.p._rpc_pref.return_value=False
            self.assertIsNone((await self.p._rpc_payload())['game'])
        self.detector.assert_not_called()

    async def test_stale_probe_result_does_not_overwrite_a_new_steam_game(self):
        def change(*args):
            self.p._rpc_game='Half-Life 2'
            return {'game':'Portal 2','reason':'detected','source':'x11-title'}
        self.detector.side_effect=change
        with patch.dict(sys.modules,self.mods):
            payload=await self.p._rpc_payload()
        self.assertEqual(payload['game'],'Half-Life 2')
        self.assertIsNone(payload['cloud_game'])
        self.assertEqual(payload['procs'],['game.exe'])


class RescanLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_old_cancelled_scanner_cannot_erase_the_new_task(self):
        gate = asyncio.Event()
        async def sleep(_):
            await gate.wait()
        p = methods({'_rpc_rescan_arm'}, create_task=asyncio.create_task, sleep=sleep)
        p._rpc_rescan_task = None
        p._rpc_game = 'GeForce NOW'
        p._rpc_pref = Mock(return_value=True)
        p.RPC_RESCAN_PERIOD = 20
        p._rpc_rescan_arm()
        old = p._rpc_rescan_task
        await asyncio.sleep(0)
        p._rpc_pref.return_value = False
        p._rpc_rescan_arm()
        p._rpc_pref.return_value = True
        p._rpc_rescan_arm()
        new = p._rpc_rescan_task
        self.assertIsNot(old, new)
        await asyncio.sleep(0)
        self.assertIs(p._rpc_rescan_task, new)
        new.cancel()
        for task in (old, new):
            try:
                await task
            except asyncio.CancelledError:
                pass
        self.assertIsNone(p._rpc_rescan_task)


class CloudFailureBoundaryTests(unittest.TestCase):
    def test_window_query_failures_are_unavailable_not_a_valid_empty_lobby(self):
        def denied(*args, **kwargs):
            return types.SimpleNamespace(returncode=1, stdout='')
        self.assertIsNone(cloud._x11_titles({'DISPLAY':':9'}, run=denied, which=lambda *a,**k:'fixture'))

    def test_overlarge_window_list_aborts_without_publishing_partial_results(self):
        run=Mock(return_value=types.SimpleNamespace(returncode=0,stdout=' '.join(hex(x) for x in range(129))))
        self.assertIsNone(cloud._x11_titles({'DISPLAY':':9'},run=run,which=lambda *a,**k:'fixture'))
        self.assertEqual(run.call_count,1)

    def test_dead_native_process_does_not_read_or_retain_window_titles(self):
        with patch.object(cloud.sys,'platform','linux'),patch.object(cloud,'_native_linux_pids',return_value=set()),patch.object(cloud,'_x11_titles') as titles:
            self.assertEqual(cloud.detect_geforce_game('GeForce NOW')['reason'],'not_running')
            titles.assert_not_called()

    def test_bad_x_properties_do_not_execute_code_or_escape_native_class_filter(self):
        properties=[
            'WM_CLASS(STRING) = __import__("os").system("never")',
            'WM_CLASS(STRING) = "Google-chrome"\nWM_NAME(STRING) = "Portal 2 on GeForce NOW"',
            'WM_CLASS(STRING) = 12, {"bad": 1}\nWM_NAME(STRING) = "Portal 2"',
            'WM_CLASS(STRING) = "GeForceNOW"\nWM_NAME(STRING) = __import__("os").getcwd()',
        ]
        for props in properties:
            def run(args,**kwargs):
                return types.SimpleNamespace(returncode=0,stdout='window id # 0x1' if '-root' in args else props)
            with self.subTest(properties=props):
                self.assertEqual(cloud._x11_titles({'DISPLAY':':9'},run=run,which=lambda *a,**k:'fixture'),[])

    def test_windows_native_api_filters_owners_visibility_and_lengths_with_wide_handles(self):
        import ctypes
        from ctypes import wintypes
        owned=2**42+1
        windows={owned:(7,True,'Baldur’s Gate 3'),owned+1:(8,True,'Private other app'),
                 owned+2:(7,False,'Hidden'),owned+3:(7,True,'x'*301)}
        class Fn:
            def __init__(self,fn):self.fn=fn
            def __call__(self,*args):return self.fn(*args)
        def pid(hwnd,out):
            ctypes.cast(out,ctypes.POINTER(wintypes.DWORD))[0]=windows[hwnd][0]
            return 1
        def name(hwnd,buffer,size):
            buffer.value=windows[hwnd][2]
            return len(buffer.value)
        api=types.SimpleNamespace(
            EnumWindows=Fn(lambda cb,_:all(cb(hwnd,0) for hwnd in windows)),
            IsWindowVisible=Fn(lambda hwnd:windows[hwnd][1]),
            GetWindowThreadProcessId=Fn(pid),
            GetWindowTextLengthW=Fn(lambda hwnd:len(windows[hwnd][2])),GetWindowTextW=Fn(name))
        with patch.object(ctypes,'WinDLL',return_value=api,create=True),patch.object(ctypes,'WINFUNCTYPE',ctypes.CFUNCTYPE,create=True):
            self.assertEqual(cloud._windows_titles({7}),['Baldur’s Gate 3'])
            api.EnumWindows.fn=lambda *args:False
            self.assertIsNone(cloud._windows_titles({7}))


class XpropEncodingTests(unittest.TestCase):
    def test_legacy_utf8_bytes_and_genuine_latin1_are_both_read_correctly(self):
        cases = [(r'"Baldur\342\200\231s Gate 3"','Baldur’s Gate 3'),
                 (r'"Pok\351mon"','Pokémon'),
                 (r'"A \"quoted\" game"','A "quoted" game')]
        for literal, expected in cases:
            def run(args,**kwargs):
                if '-root' in args:
                    out='window id # 0x1'
                else:
                    self.assertIn('8s',args)
                    out='WM_CLASS(STRING) = "GeForceNOW"\nWM_NAME(STRING) = '+literal
                return types.SimpleNamespace(returncode=0,stdout=out)
            with self.subTest(literal=literal):
                self.assertEqual(cloud._x11_titles({'DISPLAY':':9'},run=run,which=lambda *a,**k:'fixture'),[expected])
