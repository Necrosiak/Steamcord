"""Guarded CDP boundary for Steam's hidden Discord BrowserView.

These are undocumented Steam APIs. Keep their assumptions here, and report
unsupported instead of letting one missing method break an HTTP control route.
"""

_VIEW_SCRIPT = """(() => {
    const tab = window.DISCORD_TAB;
    const view = tab && tab.m_browserView;
    if (typeof view?.SetBounds !== 'function' || typeof view?.SetVisible !== 'function') return false;
    try {
        if (__VISIBLE__) {
            view.SetBounds(0, 0, 1, 1);
            view.SetVisible(true);
        } else {
            const width = Number(tab.WIDTH), height = Number(tab.HEIGHT);
            if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return false;
            view.SetVisible(false);
            view.SetBounds(0, 0, width, height);
        }
        return true;
    } catch (_) { return false; }
})()"""


async def set_voice_view(tab, visible):
    if tab is None or not isinstance(visible, bool):
        return False
    try:
        await tab.ensure_open()
        result = await tab.evaluate(_VIEW_SCRIPT.replace('__VISIBLE__', 'true' if visible else 'false'), wait=True)
        return (result or {}).get('result', {}).get('result', {}).get('value') is True
    except Exception:
        return False
