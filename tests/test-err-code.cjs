// Les erreurs d'appel Decky : le code levé côté Python est dans pythonTraceback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const src = fs.readFileSync('src/i18n.ts', 'utf8');
const start = src.indexOf('export function errCode');
const end = src.indexOf('\n}\n', start) + 3;
const ctx = { exports: {} };
vm.runInNewContext(ts.transpileModule(src.slice(start, end), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, ctx);
const { errCode } = ctx.exports;

function deckyError(last) {
  const e = new Error('');
  e.name = 'Python Exception';
  e.pythonTraceback = `Traceback (most recent call last):\n  File "decky_loader/plugin/messages.py", line 44, in wait_for_result\n${last}\n`;
  return e;
}

test('code levé côté Python, tel que Decky le renvoie', () => {
  const e = deckyError('Exception: thread_need_message');
  assert.equal(String(e), 'Python Exception', 'le défaut d’origine : rien dans le texte');
  assert.equal(errCode(e), 'thread_need_message');
  assert.equal(errCode(deckyError('Exception: discord_reconnecting')), 'discord_reconnecting');
  assert.equal(errCode(deckyError('RuntimeError: stores_not_ready')), 'stores_not_ready');
});

test('autres erreurs : message, puis texte', () => {
  assert.equal(errCode(new Error('offline')), 'offline');
  assert.equal(errCode('brut'), 'brut');
  assert.equal(errCode(deckyError('  something odd')), 'Python Exception');
});
