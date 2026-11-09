// The proxy settings panel must never come up empty.
//
// Reported after the 0.0.x update: "Панель настроек прокси пустует" — only the
// "Proxy" heading, nothing under it. The section used to hold its config in
// `useState(null)` and `return null` until a backend answer arrived, so when the
// call was rejected (new bundle, Python not reloaded after the update) the whole
// section vanished. These tests pin the three cases that matter: backend
// silent, proxy off, proxy configured.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/components/ProxySettings.tsx'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React,
  jsxFactory: 'h', jsxFragmentFactory: 'Fragment',
} }).outputText;

// ── a tiny React for one component ─────────────────────────────────────────
function fixture(answer) {
  const values = [];
  const mounted = new Set();
  const calls = [];
  let index = 0;
  const context = {
    exports: {}, Fragment: 'Fragment',
    h: (type, props, ...children) => ({ type, props: props || {}, children }),
    require(name) {
      if (name === 'react') return {
        useState: (initial) => {
          const key = index++;
          if (!(key in values)) values[key] = initial;
          return [values[key], (v) => { values[key] = typeof v === 'function' ? v(values[key]) : v; }];
        },
        useEffect: (fn) => {
          const key = index++;
          if (!mounted.has(key)) { mounted.add(key); fn(); }
        },
      };
      if (name === '@decky/ui') return {
        PanelSectionRow: 'row', ToggleField: 'toggle', Dropdown: 'dropdown', TextField: 'textfield',
      };
      if (name === '@decky/api') return {
        call: async (...args) => { calls.push(args); return answer(...args); },
      };
      if (name === '../i18n') return { t: (key) => key };
      if (name === './Styled') return { Notice: 'notice', RowBtn: 'button' };
      throw new Error('unexpected import: ' + name);
    },
  };
  vm.runInNewContext(code, context);
  const render = () => { index = 0; return context.exports.ProxySection(); };
  const nodes = (tree) => !tree || typeof tree !== 'object' ? []
    : [tree, ...tree.children.flat(Infinity).flatMap(nodes)];
  const all = (tree) => nodes(tree).filter(n => typeof n === 'object' && n && n.type);
  const byType = (tree, type) => all(tree).filter(n => n.type === type);
  const button = (tree, key) => all(tree).find(n => n.type === 'button' && n.children.includes(key));
  return { calls, render, all, byType, button };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a silent backend still shows the controls and says what is wrong', async () => {
  const f = fixture(async () => { throw new Error('method not found: get_proxy'); });
  let tree = f.render();
  await tick();
  tree = f.render();

  assert.equal(f.byType(tree, 'toggle').length, 1, 'the on/off switch must be there');
  assert.ok(f.byType(tree, 'notice').some(n => n.children.includes('proxy_err_backend')),
    'the panel explains that the backend did not answer');
  assert.ok(f.button(tree, 'proxy_save'), 'Save is reachable');
  assert.ok(f.button(tree, 'proxy_reload'), 'and it can be retried');
});

test('proxy off: a switch and the two actions, no fields', async () => {
  const f = fixture(async () => ({
    enabled: false, scheme: 'socks5', host: '', port: 1080,
    username: '', password: '', bypass: '', active: false, bridge: false,
  }));
  f.render();
  await tick();
  const tree = f.render();

  assert.equal(f.byType(tree, 'toggle')[0].props.checked, false);
  assert.equal(f.byType(tree, 'textfield').length, 0, 'nothing to fill in while it is off');
  assert.ok(f.button(tree, 'proxy_test') && f.button(tree, 'proxy_save'));
});

test('a configured proxy fills every field and saving sends them all', async () => {
  const stored = {
    enabled: true, scheme: 'socks5', host: 'proxy.example', port: 1081,
    username: 'user', has_password: true, bypass: 'localhost', active: true, bridge: true,
  };
  const f = fixture(async (name) => {
    if (name === 'get_proxy') return stored;
    if (name === 'set_proxy') return { ok: true, config: { ...stored, enabled: false }, restart_required: true };
    return { ok: true, restarted: true };
  });
  f.render();
  await tick();
  let tree = f.render();

  assert.equal(f.byType(tree, 'toggle')[0].props.checked, true);
  const fields = f.byType(tree, 'textfield');
  assert.equal(fields.length, 5, 'host, port, user, password, bypass');
  assert.equal(fields[0].props.value, 'proxy.example');
  assert.equal(fields[1].props.value, '1081');
  assert.equal(f.byType(tree, 'dropdown')[0].props.selectedOption, 'socks5');
  // The stored password is never sent to the panel: masked, empty field.
  assert.equal(fields[3].props.value, '');
  assert.equal(fields[3].props.bIsPassword, true);

  await f.button(tree, 'proxy_save').props.onClick();
  const sent = f.calls.find(c => c[0] === 'set_proxy');
  // Empty password field = keep the stored one (null, not '').
  assert.deepEqual(sent, ['set_proxy', true, 'socks5', 'proxy.example', '1081', 'user', null, 'localhost']);

  // The backend says Discord has to restart: the button appears, and pressing
  // it asks the backend to do it (a call in progress ends, hence the warning).
  tree = f.render();
  assert.ok(f.byType(tree, 'notice').some(n => n.children.includes('proxy_restart_needed')));
  await f.button(tree, 'proxy_restart').props.onClick();
  assert.ok(f.calls.some(c => c[0] === 'apply_proxy'));
});

test('Retry recovers once the backend answers', async () => {
  let up = false;
  const f = fixture(async (name) => {
    if (!up) throw new Error('method not found: get_proxy');
    return {
      enabled: false, scheme: 'socks5', host: '', port: 1080,
      username: '', password: '', bypass: '', active: false, bridge: false,
    };
  });
  f.render();
  await tick();
  let tree = f.render();
  assert.ok(f.button(tree, 'proxy_reload'));

  up = true;
  await f.button(tree, 'proxy_reload').props.onClick();
  await tick();
  tree = f.render();
  assert.equal(f.button(tree, 'proxy_reload'), undefined, 'the warning is gone');
  assert.equal(f.byType(tree, 'toggle').length, 1);
});

test('a save answered with an error code is translated, not swallowed', async () => {
  const f = fixture(async (name) => {
    if (name === 'get_proxy') return {
      enabled: true, scheme: 'http', host: 'proxy', port: 8080,
      username: '', password: '', bypass: '', active: true, bridge: true,
    };
    return { ok: false, error: 'proxy_err_port' };
  });
  f.render();
  await tick();
  let tree = f.render();
  await f.button(tree, 'proxy_save').props.onClick();
  tree = f.render();
  assert.ok(f.byType(tree, 'notice').some(n => n.children.includes('proxy_err_port')));
});
