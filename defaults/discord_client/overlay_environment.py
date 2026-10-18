"""Build an X11 overlay environment without assuming gamescope uses :0."""


def overlay_environment(base, session, steam, desktop=False):
    env = {**base, **session}
    if not desktop:
        # The user systemd manager can still contain a stale desktop DISPLAY.
        # Steam's own XWayland display/cookie are authoritative in Game Mode.
        for key in ('DISPLAY', 'XAUTHORITY'):
            if steam.get(key):
                env[key] = steam[key]
        if steam.get('DISPLAY') and not steam.get('XAUTHORITY'):
            env.pop('XAUTHORITY', None)
    env.setdefault('DISPLAY', ':0')
    if '/tmp/_MEI' in env.get('LD_LIBRARY_PATH', ''):
        env.pop('LD_LIBRARY_PATH', None)
    return env
