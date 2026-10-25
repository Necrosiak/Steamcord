// Steamcord sound filtering must leave unmarked Steam notifications unchanged.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync("src/notify.ts", "utf8");
const silentStart = source.indexOf("const SILENT_TOAST_WINDOW_MS");
const silentEnd = source.indexOf("const NATIVE_TOASTS_KEY", silentStart);
assert.ok(silentStart >= 0 && silentEnd > silentStart, "silent toast filter exists");
const nativeSounds = [];
class NotificationStore {
  PlayNotificationSound(n) { nativeSounds.push(n); }
}
const notificationStore = new NotificationStore();
const silentContext = { window: { NotificationStore: notificationStore }, console };
const silentJs = ts.transpileModule(source.slice(silentStart, silentEnd) + "\nthis.mark = markToastSilent;", {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
vm.runInNewContext(silentJs, silentContext);
silentContext.mark("76561201685444586");
notificationStore.PlayNotificationSound({ data: { steamid_sender: () => "76561201685444586" } });
assert.equal(nativeSounds.length, 0, "current SteamUI sender getter is silenced");
notificationStore.PlayNotificationSound({ data: { steamid_sender: () => "76561201685444586" } });
assert.equal(nativeSounds.length, 1, "unmarked sound is retained");
silentContext.mark("76561201685444586");
notificationStore.PlayNotificationSound({ data: { steamid: () => "76561201685444586" } });
assert.equal(nativeSounds.length, 1, "older SteamUI getter is still silenced");
delete notificationStore.PlayNotificationSound;
silentContext.mark("76561201685444586");
notificationStore.PlayNotificationSound({ data: { steamid_sender: () => "76561201685444586" } });
assert.equal(nativeSounds.length, 1, "filter reattaches after SteamUI replaces its method");
console.log("Steamcord sound filtering preserves unrelated notification sounds");
