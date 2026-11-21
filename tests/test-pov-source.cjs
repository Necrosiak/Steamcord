const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const text = fs.readFileSync(path.join(__dirname, '../defaults/steamcord_client.js'), 'utf8');
const start = text.indexOf('        window.STEAMCORD_startPov =');
const end = text.indexOf('        // Discord\'s MediaEngine', start);

function fixture() {
  const tracks = [{kind:'screen', t:{id:'screen', readyState:'live', muted:false}},
                  {kind:'camera', t:{id:'camera', readyState:'live', muted:false}}];
  const recorded = [], watched = [], recorders = [], sent = [];
  const window = {STEAMCORD_POV:{}, STEAMCORD_VIDEO:{},
    __sc_holdSinks(){}, __sc_releaseSinks(){}, __sc_videoTracksFor:()=>tracks,
    __sc_streamsForChannel:()=>[{key:'stream',s:{ownerId:'u'}}],
    STEAMCORD_WS:{send(msg){sent.push(JSON.parse(msg));}}};
  class Recorder {
    static isTypeSupported(){return true;}
    constructor(stream){this.state='inactive';recorded.push(stream.tracks[0].id);recorders.push(this);}
    start(){this.state='recording';}
    stop(){this.state='inactive';this.onstop?.();}
  }
  vm.runInNewContext(text.slice(start,end), {window, console:{log(){},error(){}},
    Vencord:{Webpack:{findStore:name=>name==='SelectedChannelStore'?{getVoiceChannelId:()=> 'c'}:
      name==='UserStore'?{getCurrentUser:()=>({id:'me'})}:{getViewerIds:()=>[]},
      findByCode:code=>code.includes('STREAM_WATCH')?()=>watched.push('watch'):()=>{}}},
    MediaRecorder:Recorder, MediaStream:class {constructor(tracks){this.tracks=tracks;}},
    btoa:s=>Buffer.from(s,'binary').toString('base64'), setTimeout(){}, clearTimeout(){}});
  return {window,recorded,watched,tracks,recorders,sent};
}
async function flush(){for(let i=0;i<12;i++) await Promise.resolve();}

for(const source of ['auto','screen','camera']) test(`POV ${source} selects the requested source`,async()=>{
  const f=fixture(); f.window.STEAMCORD_startPov('u','webm',source); await flush();
  assert.deepEqual(f.recorded,[source==='camera'?'camera':'screen']);
  assert.equal(f.watched.length,source==='camera'?0:1);
  f.window.STEAMCORD_stopPov('u'); await flush();
  assert.equal(f.window.STEAMCORD_POV.u,undefined);
});
test('stopping an old source does not erase a newly started camera recorder', async()=>{
  const f=fixture();f.window.STEAMCORD_startPov('u','webm','screen');await flush();
  f.window.STEAMCORD_stopPov('u');f.window.STEAMCORD_startPov('u','webm','camera');
  const fresh=f.window.STEAMCORD_POV.u;await flush();
  assert.equal(f.window.STEAMCORD_POV.u,fresh);
  assert.deepEqual(f.recorded,['screen','camera']);
  f.window.STEAMCORD_stopPov('u');await flush();
});
test('a pending old blob cannot overwrite the new camera init',async()=>{
  const f=fixture();f.window.STEAMCORD_startPov('u','webm','screen');await flush();
  let release;
  f.recorders[0].ondataavailable({data:{size:1,arrayBuffer:()=>new Promise(resolve=>{release=resolve;})}});
  await flush();
  f.window.STEAMCORD_stopPov('u');f.window.STEAMCORD_startPov('u','webm','camera');await flush();
  release(new Uint8Array([7]).buffer);await flush();
  assert.deepEqual(f.sent,[]);
  f.recorders[1].ondataavailable({data:{size:1,arrayBuffer:async()=>new Uint8Array([8]).buffer}});
  await flush();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].init,true);assert.equal(f.sent[0].kind,'camera');
  f.window.STEAMCORD_stopPov('u');await flush();
});
