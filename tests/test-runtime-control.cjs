const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/components/DiscordRuntimeControl.tsx'), 'utf8');
const code = ts.transpileModule(source, {compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment',
}}).outputText;

function fixture(enabled = true, succeeds = true) {
  const state = {discord_enabled: enabled};
  const values = []; let index = 0;
  const calls = [];
  const context = {exports: {}, Fragment: 'Fragment', h: (type, props, ...children) => ({type, props: props || {}, children}),
    require: name => {
      if (name === '@decky/ui') return {DialogButton: 'button', Focusable: 'row'};
      if (name === '@decky/api') return {call: async (...args) => {
        calls.push(args); return {ok: succeeds, enabled: succeeds ? args[1] : state.discord_enabled};
      }};
      if (name === 'react') return {useState: initial => {
        const key = index++;
        if (!(key in values)) values[key] = initial;
        return [values[key], value => values[key] = value];
      }};
      if (name.includes('useSteamcordState')) return {useSteamcordState: () => state,
        publishDiscordRuntime: enabled => { state.discord_enabled = enabled; }};
      if (name.includes('i18n')) return {t: key => key};
      throw new Error(name);
    }};
  vm.runInNewContext(code, context);
  const render = () => { index = 0; return context.exports.DiscordRuntimeControl(); };
  const flatten = node => !node || typeof node !== 'object' ? [] : [node, ...node.children.flat(Infinity).flatMap(flatten)];
  const button = (tree, key) => flatten(tree).find(n => n.type === 'button' && n.children.includes(key));
  return {calls, render, button, flatten};
}

test('first activation only opens confirmation; cancel does not stop Discord', () => {
  const f = fixture();
  f.button(f.render(), 'discord_runtime_off').props.onClick();
  assert.equal(f.calls.length, 0);
  f.button(f.render(), 'discord_runtime_cancel').props.onClick();
  assert.ok(f.button(f.render(), 'discord_runtime_off'));
  assert.equal(f.calls.length, 0);
});

test('confirmation stacks full-width buttons without native minimum-width overflow', () => {
  const f = fixture();
  f.button(f.render(), 'discord_runtime_off').props.onClick();
  const tree = f.render();
  const group = f.flatten(tree).find(n => n.type === 'row');
  assert.equal(group.props['flow-children'], 'column');
  assert.equal(group.props.style.flexDirection, 'column');
  for (const key of ['discord_runtime_cancel', 'discord_runtime_stop']) {
    const style = f.button(tree, key).props.style;
    assert.equal(style.minWidth, 0);
    assert.equal(style.width, '100%');
    assert.equal(style.maxWidth, '100%');
    assert.equal(style.boxSizing, 'border-box');
  }
});

test('confirmed stop calls the backend once, then shows resume instead of logout', async () => {
  const f = fixture();
  f.button(f.render(), 'discord_runtime_off').props.onClick();
  await f.button(f.render(), 'discord_runtime_stop').props.onClick();
  assert.deepEqual(f.calls, [['set_discord_runtime', false]]);
  assert.ok(f.button(f.render(), 'discord_runtime_on'));
});

test('resume uses runtime API, not a systemd restart or token login', async () => {
  const f = fixture(false);
  await f.button(f.render(), 'discord_runtime_on').props.onClick();
  assert.deepEqual(f.calls, [['set_discord_runtime', true]]);
  assert.ok(f.button(f.render(), 'discord_runtime_off'));
});

test('backend failure keeps resume accessible and reports the error', async () => {
  const f = fixture(false, false);
  await f.button(f.render(), 'discord_runtime_on').props.onClick();
  const tree = f.render();
  assert.ok(f.flatten(tree).some(n => n.props.role === 'alert'));
  assert.ok(f.button(tree, 'discord_runtime_on'));
});
