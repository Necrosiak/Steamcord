// #86: the Steamcord entry in Steam's main menu can be turned off.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/patches/menuPatch.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React } }).outputText;

function load(store) {
  const registered = new Set();
  let registrations = 0;
  const context = {
    exports: {},
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    React: { createElement: () => null },
    require: name => name === '../steamMenu'
      ? { registerSteamMenu: entry => { registrations++; registered.add(entry.id); return () => registered.delete(entry.id); } }
      : name === 'react' ? { createElement: () => null } : {},
  };
  vm.createContext(context);
  vm.runInContext('(function(exports, require){' + compiled + '})(exports, require)', context);
  return { menu: context.exports, registered, count: () => registrations };
}

test('the entry is shown by default', () => {
  const { menu, registered } = load({});
  menu.patchMenu();
  assert.ok(registered.has('steamcord'));
  assert.equal(menu.menuEntryEnabled(), true);
});

test('turning it off removes the entry and survives a reload', () => {
  const store = {};
  const first = load(store);
  first.menu.patchMenu();
  first.menu.setMenuEntryEnabled(false);
  assert.equal(first.registered.has('steamcord'), false);
  const reloaded = load(store);
  reloaded.menu.patchMenu();
  assert.equal(reloaded.registered.has('steamcord'), false);
});

test('turning it back on registers the entry once', () => {
  const { menu, registered, count } = load({ STEAMCORD_MENU_ENTRY: '0' });
  menu.patchMenu();
  menu.setMenuEntryEnabled(true);
  menu.setMenuEntryEnabled(true);
  assert.ok(registered.has('steamcord'));
  assert.equal(count(), 1);
});

test('unloading the plugin removes the entry', () => {
  const { menu, registered } = load({});
  const unpatch = menu.patchMenu();
  unpatch();
  assert.equal(registered.has('steamcord'), false);
});
