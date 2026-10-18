const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const ts = require('typescript');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/chatPanelLayout.ts'), 'utf8');
const context = {exports: {}, require: () => ({})};
vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, context);
const height = context.exports.chatPanelHeight;

function element({viewport = 800, top = 300, scale = 1, scroll = 0} = {}) {
  const parent = {scrollTop: scroll, parentElement: null, clientHeight: viewport,
    getBoundingClientRect: () => ({top: 0})};
  return {offsetHeight: 180, parentElement: parent,
    getBoundingClientRect: () => ({top: top - scroll * scale, height: 180 * scale}),
    ownerDocument: {defaultView: {innerHeight: viewport, getComputedStyle: () => ({overflowY: 'auto'})}}};
}

test('uses actual rendering window and available viewport', () => assert.equal(height(element()), 488));
test('ancestor scroll cannot grow the chat panel', () => {
  assert.equal(height(element({scroll: 150})), height(element({scroll: 0})));
});
test('theme scaling is converted back to CSS dimensions', () => {
  assert.equal(height(element({scale: 2})), 244);
});
test('small viewports do not force a 180px minimum and overflow the composer', () => {
  assert.equal(height(element({viewport: 380})), 68);
  assert.equal(height(element({viewport: 200})), 0);
});
test('visual viewport resize reserves space when an on-screen keyboard reduces the view', () => {
  const el = element();
  el.ownerDocument.defaultView.visualViewport = {offsetTop: 0, height: 500};
  assert.equal(height(el), 188);
});
test('insufficient viewport still leaves the header and composer usable', () => {
  const el = element({viewport: 200});
  el.children = [{hasAttribute: () => false, getBoundingClientRect: () => ({height: 120})},
    {hasAttribute: () => true, getBoundingClientRect: () => ({height: 1000})}];
  assert.equal(height(el), 120);
});
test('messages scroll independently and composer never shrinks', () => {
  const chat = fs.readFileSync(path.join(root, 'src/components/TextChat.tsx'), 'utf8');
  assert.match(chat, /data-sc-chat-panel[^\n]*overflow: "hidden"/);
  assert.match(chat, /flex: "1 1 0", minHeight: 0, overflowY: "auto"/);
  assert.match(chat, /data-sc-chat-composer[^\n]*flexShrink: 0/);
  assert.ok(!chat.includes('fillPreview.height'));
});
test('off requires confirmation and resume is available before loading checks', () => {
  const button = fs.readFileSync(path.join(root, 'src/components/DiscordRuntimeControl.tsx'), 'utf8');
  assert.match(button, /onClick=\{\(\) => setConfirm\(true\)\}/);
  assert.match(button, /onClick=\{\(\) => change\(false\)\}/);
  assert.ok(button.indexOf('discord_runtime_cancel') < button.indexOf('discord_runtime_stop'));
  const entry = fs.readFileSync(path.join(root, 'src/index.tsx'), 'utf8');
  assert.ok(entry.indexOf('if (state?.discord_enabled === false)') < entry.indexOf('if (!state?.loaded)'));
});
