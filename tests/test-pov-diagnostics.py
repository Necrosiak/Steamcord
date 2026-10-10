"""POV diagnostics report stages and counts without stream/user data."""

import contextlib
import importlib.util
import io
import pathlib
import sys

spec = importlib.util.spec_from_file_location("overlay_test", pathlib.Path(sys.argv[1]))
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


class Area:
    def clear_pov_frame(self, _uid):
        return False


class Decoder:
    def __init__(self, uid, on_frame):
        self.uid = uid
        self.on_frame = on_frame

    def push(self, _payload):
        self.on_frame(self.uid, bytearray(4), 1, 1)

    def close(self):
        pass


class RunningThread:
    def is_alive(self):
        return True


overlay.PovDecoder = Decoder
receiver = overlay.PovReceiver(Area())
receiver.thread = RunningThread()
private_uid = b"secret-user-123"
private_payload = b"private-video-bytes"
prefix = bytes([len(private_uid)]) + private_uid
output = io.StringIO()
with contextlib.redirect_stdout(output):
    receiver._handle_message(prefix + b"\x01" + b"init")
    receiver._handle_message(prefix + b"\x00" + private_payload)
    receiver.log_health()

assert receiver.diag == {"connections": 0, "inits": 1, "media": 1, "frames": 2}
log = output.getvalue()
assert "POV decoder init received" in log
assert "POV first decoded frame" in log
assert "POV health: ws=0 init=1 media=1 decoded=2 decoders=1" in log
assert private_uid.decode() not in log
assert private_payload.decode() not in log
print("POV diagnostic counters and privacy OK")
