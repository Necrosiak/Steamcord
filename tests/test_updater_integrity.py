"""#114: the self-updater checks the published checksum and rolls back a
partially applied update."""
import hashlib
import io
import sys
import tempfile
import types
import unittest
import urllib.error
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "defaults"))
sys.modules.setdefault("decky", types.SimpleNamespace(
    logger=types.SimpleNamespace(info=lambda *a: None, warning=lambda *a: None, error=lambda *a: None),
    DECKY_PLUGIN_DIR="/tmp"))
import updater  # noqa: E402

URL = "https://github.com/Necrosiak/Steamcord/releases/download/v9.9.9/Steamcord.zip"


def make_zip(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr("Steamcord/" + name, data)
    return buf.getvalue()


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def serve(zip_bytes, checksum):
    def opener(req, timeout):
        url = req.full_url
        if url.endswith(".sha256"):
            if checksum is None:
                raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
            return FakeResp(f"{checksum}  Steamcord.zip\n".encode())
        return FakeResp(zip_bytes)
    return opener


class UpdaterIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.plugin = Path(self.tmp.name)
        (self.plugin / "main.py").write_text("old main")
        (self.plugin / "a.py").write_text("old a")
        patcher = mock.patch.object(updater, "DECKY_PLUGIN_DIR", str(self.plugin))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def apply(self, zip_bytes, checksum):
        with mock.patch.object(updater, "_urlopen", serve(zip_bytes, checksum)), \
             mock.patch.object(updater, "_restorecon_best_effort", lambda p: None):
            updater._apply_blocking(URL)

    def test_matching_checksum_installs(self):
        z = make_zip({"main.py": "new main", "a.py": "new a"})
        self.apply(z, hashlib.sha256(z).hexdigest())
        self.assertEqual((self.plugin / "main.py").read_text(), "new main")

    def test_missing_checksum_still_installs(self):
        self.apply(make_zip({"main.py": "new main"}), None)
        self.assertEqual((self.plugin / "main.py").read_text(), "new main")

    def test_wrong_checksum_changes_nothing(self):
        with self.assertRaises(ValueError):
            self.apply(make_zip({"main.py": "evil"}), "0" * 64)
        self.assertEqual((self.plugin / "main.py").read_text(), "old main")

    def test_failed_write_rolls_back(self):
        z = make_zip({"a.py": "new a", "main.py": "new main", "new.py": "brand new"})
        real = updater._replace_file
        calls = []

        def flaky(src, dst):
            calls.append(dst.name)
            if len(calls) == 3:
                raise OSError("disk full")
            real(src, dst)

        with mock.patch.object(updater, "_replace_file", side_effect=flaky):
            with self.assertRaises(OSError):
                self.apply(z, hashlib.sha256(z).hexdigest())
        self.assertEqual((self.plugin / "main.py").read_text(), "old main")
        self.assertEqual((self.plugin / "a.py").read_text(), "old a")
        self.assertFalse((self.plugin / "new.py").exists())


if __name__ == "__main__":
    unittest.main()
