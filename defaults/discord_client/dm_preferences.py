"""Account-scoped private-channel pins and exact Discord snowflake ordering."""
import json
import os
from pathlib import Path
import tempfile


def pins_path(user_id):
    user_id = str(user_id or "")
    if not user_id.isdigit():
        raise ValueError("Discord account not ready")
    return Path.home() / ".config/steamcord-dm-pins" / f"{user_id}.json"


def load_pins(user_id):
    try:
        data = json.loads(pins_path(user_id).read_text())
        return list(dict.fromkeys(str(value) for value in data if str(value).isdigit())) if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def set_pin(user_id, channel_id, pinned):
    channel_id = str(channel_id or "")
    if not channel_id.isdigit():
        raise ValueError("Invalid private channel")
    path = pins_path(user_id)
    pins = load_pins(user_id)
    pins = [value for value in pins if value != channel_id]
    if pinned:
        pins.insert(0, channel_id)
    save_pins(path, pins)


def move_pin(user_id, channel_id, direction):
    if direction not in (-1, 1):
        raise ValueError("Invalid move direction")
    pins = load_pins(user_id)
    channel_id = str(channel_id)
    if channel_id not in pins:
        raise ValueError("Channel is not pinned")
    index = pins.index(channel_id)
    target = index + direction
    if 0 <= target < len(pins):
        pins[index], pins[target] = pins[target], pins[index]
        save_pins(pins_path(user_id), pins)


def save_pins(path, pins):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as handle:
            temporary = handle.name
            json.dump(pins, handle)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def order_channels(channels, pins):
    def activity(channel):
        value = str(channel.get("last_message_id") or channel.get("id") or "0")
        return int(value) if value.isdigit() else 0
    rows = [{**channel, "pinned": str(channel["id"]) in pins}
            for channel in channels if isinstance(channel, dict) and channel.get("id")]
    positions = {channel_id: index for index, channel_id in enumerate(pins)}
    return sorted(rows, key=lambda channel: (
        0 if channel["pinned"] else 1,
        positions.get(str(channel["id"]), 0) if channel["pinned"] else -activity(channel)))
