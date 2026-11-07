const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const client = fs.readFileSync(path.join(__dirname, '../defaults/steamcord_client.js'), 'utf8');
function helper(name, end, context = {}) {
  const start = client.indexOf(`        window.${name} =`);
  assert.ok(start >= 0);
  context.window ||= {};
  vm.runInNewContext(client.slice(start, client.indexOf(end, start)), context);
  return context.window[name];
}

test('local relay retains resolution and raises bitrate for screen and camera separately', async () => {
  const configure = helper('__sc_configureRelaySender', '\n        window.STEAMCORD_startVideoRelay');
  for (const [kind, bitrate] of [['screen', 18000000], ['camera', 6000000]]) {
    let result;
    const params = {transactionId: 'keep', encodings: [{rid: 'a', active: true}, {rid: 'b', active: false}]};
    assert.equal(await configure({getParameters: () => params, setParameters: async p => result = p}, kind), true);
    assert.equal(result.degradationPreference, 'maintain-resolution');
    assert.equal(result.transactionId, 'keep');
    assert.equal(result.encodings[1].active, false);
    for (const enc of result.encodings) { assert.equal(enc.maxBitrate, bitrate); assert.equal(enc.scaleResolutionDownBy, 1); }
  }
});
test('older media engines and rejected sender parameters remain usable', async () => {
  const configure = helper('__sc_configureRelaySender', '\n        window.STEAMCORD_startVideoRelay');
  assert.equal(await configure({}, 'screen'), false);
  assert.equal(await configure({getParameters: () => ({encodings: []})}, 'screen'), false);
  assert.equal(await configure({getParameters: () => ({encodings: [{}]}), setParameters: async () => {throw Error('unsupported');}}, 'screen'), false);
});
test('video diagnostics never return participant/device IDs, SDP or network addresses', async () => {
  const pc = {connectionState: 'connected', getStats: async () => new Map([
    ['out', {type:'outbound-rtp', kind:'video', frameWidth:1920, frameHeight:1080, framesPerSecond:60, bytesSent:123, qualityLimitationReason:'cpu', remoteId:'secret'}],
    ['ip', {type:'local-candidate', address:'secret-ip'}],
  ])};
  const diagnostics = helper('__sc_videoDiagnostics', '\n        // A second encode', {
    window: {STEAMCORD_SHARE_STREAM: {getVideoTracks: () => [{getSettings: () => ({width:1280, height:720, deviceId:'secret-device'})}]},
      STEAMCORD_VIDEO: {'secret-user': {pc}}, __sc_videoTracksFor: () => [{kind:'screen', t:{getSettings: () => ({width:1920, height:1080, groupId:'secret-group'})}}]},
    setTimeout, clearTimeout,
  });
  const report = await diagnostics();
  assert.equal(report.capture[0].width, 1280);
  assert.equal(report.relays[0].stats[0].frameWidth, 1920);
  assert.ok(!JSON.stringify(report).includes('secret'));
});

test('WebKit overlay renders centered roster, self badges and escaped names', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../defaults/game_overlay/voice.html'), 'utf8');
  const roster = {style:{setProperty(){}},className:'',innerHTML:''};
  const pov = {style:{setProperty(){}},className:'',innerHTML:''};
  const data = {voice:{enabled:true, settings:{pos:'center-right',opacity:60}, users:[{username:'<self>',is_deafened:true,is_live:true}],events:[]},pov:{enabled:false}};
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    window:{OVERLAY_CFG:{stateUrl:'fixture'}}, document:{getElementById: id => id==='roster'?roster:pov},
    fetch:async()=>({ok:true,text:async()=>JSON.stringify(data)}),setInterval(){},setTimeout(){}, console,
  });
  for(let i=0;i<8;i++) await Promise.resolve();
  assert.equal(roster.className, 'on center-right');
  assert.equal(roster.style.opacity, '0.6');
  assert.ok(roster.innerHTML.includes('&lt;self&gt;'));
  assert.equal((roster.innerHTML.match(/<svg /g)||[]).length,2);
});
