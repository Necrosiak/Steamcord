const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../defaults/steamcord_client.js'), 'utf8');
const block = source.slice(source.indexOf('// BEGIN STREAM VISIBILITY POLICY'), source.indexOf('// END STREAM VISIBILITY POLICY'));
function fixture() {
 const context = { window: {} }; vm.createContext(context); vm.runInContext(block, context);
 const relays = new Set(), povs = new Set(), subscriptions = [], calls = [];
 const policy = context.window.__sc_createVideoVisibility({
  hasPov: uid => povs.has(uid), relayUsers: () => [...relays], subscriptions: () => subscriptions,
  start: uid => { relays.add(uid); calls.push(['start',uid]); },
  stop: uid => { relays.delete(uid); calls.push(['stop',uid]); }, close: key => calls.push(['close',key]),
 });
 return {policy,relays,povs,subscriptions,calls};
}
test('desktop policy leaves manually watched streams alone',()=>{
 const f=fixture();f.relays.add('a');f.subscriptions.push({userId:'a',key:'stream:a',viewing:true});
 f.policy.update(false,[]);f.policy.enforce();assert.deepEqual(f.calls,[]);
});
test('hidden QAM stops the video subscription, without touching voice or volume',()=>{
 const f=fixture();f.relays.add('a');f.subscriptions.push({userId:'a',key:'stream:a',viewing:true});
 f.policy.update(true,[]);assert.deepEqual(f.calls,[['stop','a'],['close','stream:a']]);
 f.policy.enforce();assert.equal(f.calls.filter(c=>c[0]==='close').length,1);
});
test('reopening a visible watched surface resumes the suspended relay once',()=>{
 const f=fixture();f.relays.add('a');f.policy.update(true,[]);f.policy.update(true,['a']);f.policy.enforce();
 assert.deepEqual(f.calls,[['stop','a'],['start','a']]);assert.equal(f.policy.canWatch('a'),true);
});
test('fullscreen and expanded surfaces retain only their watched streams',()=>{
 const f=fixture();f.relays.add('a');f.relays.add('b');
 f.subscriptions.push({userId:'a',key:'stream:a',viewing:true},{userId:'b',key:'stream:b',viewing:true});
 f.policy.update(true,['b']);assert.deepEqual(f.calls,[['stop','a'],['close','stream:a']]);
});
test('native streams without a watched UI surface are closed too',()=>{
 const f=fixture();f.subscriptions.push({userId:'a',key:'stream:a',viewing:true},{userId:'b',key:'stream:b',viewing:false});
 f.policy.update(true,[]);assert.deepEqual(f.calls,[['close','stream:a']]);
});
test('a running in-game POV remains visible when QAM is closed',()=>{
 const f=fixture();f.povs.add('a');f.relays.add('a');f.subscriptions.push({userId:'a',key:'stream:a',viewing:true});
 f.policy.update(true,[]);assert.deepEqual(f.calls,[]);assert.equal(f.policy.canWatch('a'),true);
 f.povs.delete('a');f.policy.enforce();assert.deepEqual(f.calls,[['stop','a'],['close','stream:a']]);
});
test('stop watching removes suspended intent and cannot auto-resume later',()=>{
 const f=fixture();f.policy.update(true,[]);f.policy.defer('a');f.policy.forget('a');f.policy.update(true,['a']);assert.deepEqual(f.calls,[]);
});
test('a watch request arriving before visibility is resumed by its lease',()=>{
 const f=fixture();f.policy.update(true,[]);assert.equal(f.policy.canWatch('a'),false);f.policy.defer('a');
 f.policy.update(true,['a']);assert.deepEqual(f.calls,[['start','a']]);
});
