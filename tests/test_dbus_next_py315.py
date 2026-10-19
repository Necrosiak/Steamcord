import importlib
import sys
import typing
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class DbusNextPython315Test(unittest.TestCase):
    """Python 3.15 removed typing.no_type_check_decorator (#75, Anatase)."""

    def test_imports_without_no_type_check_decorator(self):
        saved = getattr(typing, "no_type_check_decorator", None)
        saved_modules = {k: v for k, v in sys.modules.items() if k.startswith("dbus_next")}
        try:
            if saved is not None:
                del typing.no_type_check_decorator
            for name in saved_modules:
                del sys.modules[name]
            sys.path.insert(0, str(ROOT / "py_modules"))
            service = importlib.import_module("dbus_next.service")
            importlib.import_module("dbus_next.aio")

            class Probe(service.ServiceInterface):
                @service.method()
                def Ping(self) -> "s":
                    return "pong"

            self.assertEqual(Probe("org.example.Probe").name, "org.example.Probe")
        finally:
            sys.path.remove(str(ROOT / "py_modules"))
            if saved is not None:
                typing.no_type_check_decorator = saved
            for name in [k for k in sys.modules if k.startswith("dbus_next")]:
                del sys.modules[name]
            sys.modules.update(saved_modules)


if __name__ == "__main__":
    unittest.main()
