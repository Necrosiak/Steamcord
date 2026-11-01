const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function host(userAgent, reply) {
  let calls = 0;
  let repaints = 0;
  const effects = [];
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/host.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
      jsxFactory: 'window.SP_REACT.createElement', jsxFragmentFactory: 'window.SP_REACT.Fragment' }
  }).outputText;
  vm.runInNewContext(source, { exports, navigator: { userAgent },
    window: { SP_REACT: { createElement: (_tag, _props, children) => children, Fragment: 'fragment' } },
    require: (name) => name === '@decky/api'
      ? { call: async (method) => { assert.equal(method, 'get_host'); calls++; return reply(); } }
      : { useState: () => [0, () => { repaints++; }], useEffect: fn => effects.push(fn) }
  });
  return { api: exports, calls: () => calls, effects, repaints: () => repaints };
}

test('Windows controls stay hidden before backend detection, without mounting their children', () => {
  const { api } = host('Windows NT 10.0', () => ({}));
  assert.equal(api.onWindows(), true);
  assert.equal(api.supports('overlay'), false);
  assert.equal(api.HostFeature({ name: 'game_audio_share', children: 'control' }), null);
});

test('backend overrides user agent and missing Windows features stay unavailable', async () => {
  const { api, calls } = host('Linux', () => ({ os: 'windows', features: { overlay: false } }));
  await Promise.all([api.initHost(), api.initHost()]);
  assert.equal(calls(), 1);
  assert.equal(api.onWindows(), true);
  assert.equal(api.supports('keep_awake'), false);
  assert.equal(api.HostFeature({ name: 'overlay', children: 'control' }), null);
});

test('Linux capabilities remain available in both views', async () => {
  const { api } = host('Windows', () => ({ os: 'linux', features: { overlay: true } }));
  await api.initHost();
  assert.equal(api.onWindows(), false);
  assert.equal(api.supports('controller_shortcut'), true);
  assert.equal(api.HostFeature({ name: 'overlay', children: 'control' }), 'control');
});

test('failed detection retains safe Windows defaults and can retry', async () => {
  let fail = true;
  const { api, calls } = host('Windows', () => {
    if (fail) throw Error('backend restarting');
    return { os: 'windows', features: {} };
  });
  await api.initHost();
  assert.equal(api.supports('audio_routing'), false);
  fail = false;
  await api.initHost();
  assert.equal(calls(), 2);
});

test('a capability reply between render and subscription still repaints the view', async () => {
  const { api, effects, repaints } = host('Windows', () => ({ os: 'windows', features: { stream_preview: true } }));
  assert.equal(api.HostFeature({ name: 'stream_preview', children: 'preview' }), null);
  await api.initHost();
  assert.equal(repaints(), 0);
  effects[0]();
  assert.equal(repaints(), 1);
  assert.equal(api.HostFeature({ name: 'stream_preview', children: 'preview' }), 'preview');
});
