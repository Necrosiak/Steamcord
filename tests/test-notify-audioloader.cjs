// Focused regression check for the Decky toast sound path (#68 / #72).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync("src/notify.ts", "utf8");
const start = source.indexOf("let pluginToastAudioManager: any;");
const end = source.indexOf("const NATIVE_TOASTS_KEY", start);
assert.ok(start >= 0 && end > start, "plugin toast sound helper exists");
assert.match(source, /chatStyleNotification\(\{[^\n]+quiet: true \}\);\s*\/\/[^\n]*\n\s*if \(toast\?\.playSound !== false\) playPluginToastSound\(\)/);

const played = [];
let searches = 0;
const audioManager = {
  PlayAudioURL(url) {
    // AudioLoader's beforePatch rewrites the same URL when a pack is active.
    const mapped = url.slice(8) === "deck_ui_toast.wav" ? "chime.wav" : url.slice(8);
    played.push(`sounds_custom/test-pack/${mapped}`);
  },
};
const audioParent = { GamepadUIAudio: { m_AudioPlaybackManager: audioManager } };
const context = {
  findModuleExport(predicate) {
    searches++;
    assert.equal(predicate(audioParent), true);
    return audioParent;
  },
  console,
};
const js = ts.transpileModule(source.slice(start, end) + "\nthis.play = playPluginToastSound;", {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
vm.runInNewContext(js, context);
context.play();
context.play();
assert.deepEqual(played, [
  "sounds_custom/test-pack/chime.wav",
  "sounds_custom/test-pack/chime.wav",
]);
assert.equal(searches, 1, "audio manager is cached");

const silentStart = source.indexOf("const SILENT_TOAST_WINDOW_MS");
const silentEnd = source.indexOf("// Un toast Decky rerouté", silentStart);
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
console.log("Decky toast sound uses the AudioLoader-compatible Steam audio path");
