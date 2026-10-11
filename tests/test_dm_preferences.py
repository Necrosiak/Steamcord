import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("dm_preferences", Path(__file__).parents[1] / "defaults/discord_client/dm_preferences.py")
prefs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prefs)


class DmPreferencesTests(unittest.TestCase):
    def test_moves_only_pins_and_persists_order(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(prefs.Path,"home",return_value=Path(directory)):
            for channel in ("1", "2", "3"):
                prefs.set_pin("123",channel,True)
            prefs.move_pin("123","2",-1)
            self.assertEqual(prefs.load_pins("123"),["2","3","1"])
            prefs.move_pin("123","2",1)
            self.assertEqual(prefs.load_pins("123"),["3","2","1"])
            prefs.move_pin("123","1",1)
            self.assertEqual(prefs.load_pins("123"),["3","2","1"])
            with self.assertRaises(ValueError): prefs.move_pin("123","4",-1)
            with self.assertRaises(ValueError): prefs.move_pin("123","1",0)

    def test_exact_snowflake_order_and_no_call_priority(self):
        rows = [{"id":"1", "last_message_id":"9007199254740992", "active_call":True},
                {"id":"2", "last_message_id":"9007199254740993"}]
        self.assertEqual([row["id"] for row in prefs.order_channels(rows, [])], ["2","1"])
        self.assertNotIn("pinned", rows[0])

    def test_new_pin_goes_first_and_unpin_restores_activity(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(prefs.Path,"home",return_value=Path(directory)):
            prefs.set_pin("123", "1", True)
            prefs.set_pin("123", "2", True)
            rows = [{"id":"1","last_message_id":"100"}, {"id":"2","last_message_id":"50"}, {"id":"3","last_message_id":"200"}]
            self.assertEqual([row["id"] for row in prefs.order_channels(rows,prefs.load_pins("123"))],["2","1","3"])
            prefs.set_pin("123","2",False)
            self.assertEqual([row["id"] for row in prefs.order_channels(rows,prefs.load_pins("123"))],["1","3","2"])
            self.assertEqual(prefs.load_pins("456"), [])
            self.assertEqual(prefs.load_pins("123"), ["1"])

    def test_repins_are_deduplicated_and_moved_to_top(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(prefs.Path,"home",return_value=Path(directory)):
            for channel in ("1","2","1"):
                prefs.set_pin("123",channel,True)
            self.assertEqual(prefs.load_pins("123"), ["1","2"])

    def test_bad_inputs_and_missing_metadata(self):
        with self.assertRaises(ValueError):
            prefs.pins_path("../other")
        with self.assertRaises(ValueError):
            prefs.set_pin("123","../other",True)
        self.assertEqual(prefs.order_channels([None,{}, {"id":"1","last_message_id":"bad"}],[]),[{"id":"1","last_message_id":"bad","pinned":False}])

    def test_all_channels_are_kept_including_old_pins(self):
        rows = [{"id":str(index),"last_message_id":str(index)} for index in range(1,101)]
        ordered = prefs.order_channels(rows,["1"])
        self.assertEqual(len(ordered),100)
        self.assertEqual(ordered[0]["id"],"1")

