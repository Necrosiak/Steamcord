const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('src/notify.ts', 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const values = new Map();
const listeners = new Map();
const calls = [];
const chat = [];
const ownHandle = { dismiss() {} };
const unrelatedHandle = { dismiss() {} };
const toaster = { toast(value) { calls.push(value); return value.title === 'Other plugin' ? unrelatedHandle : ownHandle; } };
const original = toaster.toast;
const unrelated = { notifications: [{ decky: true, data: { title: 'Other plugin' } }] };
const tray = [unrelated];
const exportsObject = {};
const context = {
  exports: exportsObject,
  require(name) {
    if (name === '@decky/api') return { toaster };
    if (name === '@decky/ui') return { findModuleExport() {}, Navigation: {} };
    if (name === './i18n') return { t: (key) => key };
    throw new Error(`Unexpected import: ${name}`);
  },
  localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
  window: {
    DeckyPluginLoader: { toaster },
    SteamUIStore: { MainInstanceUIMode: 4 },
    NotificationStore: { m_rgNotificationTray: tray, RemoveGroupFromTray() { assert.fail('must not remove unrelated history'); } },
    SteamClient: { ClientNotifications: { DisplayClientNotification(type, json) { chat.push({ type, payload: JSON.parse(json) }); } } },
    addEventListener(name, fn) { listeners.set(name, fn); },
    dispatchEvent(event) { listeners.get(event.type)?.(); },
  },
  Event: class { constructor(type) { this.type = type; } },
  console,
};
vm.runInNewContext(js, context);
const api = exportsObject;
function checkIsolation() {
  assert.equal(toaster.toast, original);
  assert.equal(toaster.toast({ title: 'Other plugin' }), unrelatedHandle);
  assert.equal(tray.length, 1);
  assert.equal(tray[0], unrelated);
}
checkIsolation();
api.notify({ title: 'Steamcord', body: 'Default chat style', dm: true });
assert.equal(chat.length, 1);
assert.equal(chat[0].type, 2);
assert.equal(chat[0].payload.body, 'Default chat style');
api.setNativeToasts(true);
api.notify({ title: 'Steamcord', body: 'Native', onClick: ownHandle.dismiss });
assert.equal(calls.at(-1).body, 'Native');
assert.equal(calls.at(-1).onClick, ownHandle.dismiss);
checkIsolation();
api.setNativeToasts(false);
checkIsolation();
api.setNativeToasts(true);
context.window.SteamUIStore.MainInstanceUIMode = 7;
api.notify({ title: 'Steamcord', body: 'Desktop fallback' });
assert.equal(chat.at(-1).payload.body, 'Desktop fallback');
context.window.SteamUIStore.MainInstanceUIMode = 4;
api.setStreamerMode('always');
const count = calls.length;
api.notify({ title: 'Steamcord', body: 'Held while streaming' });
assert.equal(calls.length, count);
checkIsolation();
api.setStreamerMode('off');
assert.equal(calls.at(-1).body, 'Held while streaming');
checkIsolation();
// The initializer must not reinstall the removed override.
assert.doesNotMatch(fs.readFileSync('src/index.tsx', 'utf8'), /patchDeckyToaster/);
assert.doesNotMatch(source, /DeckyPluginLoader|RemoveGroupFromTray|m_rgNotificationTray/);
const backend = fs.readFileSync('main.py', 'utf8');
const screenshot = backend.slice(backend.indexOf('async def post_screenshot'), backend.indexOf('async def get_screen_bounds'));
assert.match(screenshot, /await cls\._toast\("Steamcord", "Error while posting screenshot"\)/);
console.log('Steamcord routing preserves the shared toaster, unrelated handles and history');
