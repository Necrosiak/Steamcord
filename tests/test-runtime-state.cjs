const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { test } = require('node:test');

test('confirmed pause reaches all mounted views and defeats a stale initial read', async () => {
  const effects = [], views = [], resolves = [], events = new Set();
  const code = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname,
    '../src/hooks/useSteamcordState.ts'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS }
    }).outputText;
  const intervals = new Set();
  const context = { exports: {}, setTimeout: () => 1, clearTimeout: () => {},
    setInterval: fn => { intervals.add(fn); return fn; }, clearInterval: fn => intervals.delete(fn),
    require: name => {
    if (name === 'react') return {
      useState: () => { const view = { state: undefined }; views.push(view);
        return [view.state, value => { view.state = typeof value === 'function' ? value(view.state) : value; }]; },
      useEffect: effect => effects.push(effect),
    };
    if (name === '@decky/api') return {
      call: () => new Promise(resolve => resolves.push(resolve)),
      addEventListener: (_, listener) => events.add(listener),
      removeEventListener: (_, listener) => events.delete(listener),
    };
    throw new Error(name);
  }};
  vm.runInNewContext(code, context);
  context.exports.useSteamcordState(); context.exports.useSteamcordState();
  const cleanups = effects.map(effect => effect());
  context.exports.publishDiscordRuntime(false);
  resolves[0]({ discord_enabled: true, loaded: true });
  await Promise.resolve();
  for (const view of views) {
    assert.equal(view.state.discord_enabled, false);
    assert.equal(view.state.loaded, false);
  }
  context.exports.publishDiscordRuntime(true);
  assert.ok(views.every(view => view.state.discord_enabled));
  assert.equal(intervals.size, 1, 'all views share a single fallback timer');
  resolves.at(-1)({ discord_enabled: true, loaded: true, logged_in: true });
  await Promise.resolve();
  assert.ok(views.every(view => view.state.loaded), 'resume recovers without another state event');
  for (const cleanup of cleanups) cleanup();
  assert.equal(events.size, 0);
  assert.equal(intervals.size, 0);
  context.exports.publishDiscordRuntime(false);
  assert.ok(views.every(view => view.state.discord_enabled));
});
