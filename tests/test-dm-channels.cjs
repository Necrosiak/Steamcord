const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

async function main() {
  const states = [], listeners = new Map();
  let cleanup, timer, requests = 0, fail = false;
  let rows = [{id:'1', pinned:false}];
  const api = {
    call: async () => { requests++; if (fail) throw Error('offline'); return rows; },
    addEventListener: (name, callback) => listeners.set(name,callback),
    removeEventListener: (name, callback) => { assert.equal(listeners.get(name),callback); listeners.delete(name); },
  };
  const react = {
    useState: initial => { const index=states.push(initial)-1; return [initial,value=>states[index]=value]; },
    useEffect: effect => { cleanup=effect(); },
  };
  const exports = {};
  const context = {exports,require:name=>name==='react'?react:name==='@decky/api'?api:{errText:String},setInterval:callback=>{timer=callback;return 1;},clearInterval:()=>{timer=null;}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/hooks/useDmChannels.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText, context);
  exports.useDmChannels();
  const flush = async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
  await flush();
  assert.equal(states[0],rows);
  rows=[{id:'2',pinned:true},{id:'1',pinned:false}];
  await listeners.get('dm_channels_changed')();
  assert.equal(states[0],rows,'pin/message event refreshes shared list');
  fail=true; await timer();
  assert.equal(states[0],rows,'network failure retains list');
  assert.match(states[1],/offline/);
  cleanup(); const previous=requests;
  assert.equal(listeners.size,0); assert.equal(timer,null);
  assert.equal(requests,previous);

  const source=fs.readFileSync('defaults/steamcord_client.js','utf8');
  const start=source.indexOf('case "$get_dm_channels":');
  const end=source.indexOf('case "$get_profile":',start);
  const body=source.slice(start,end);
  const channels=Array.from({length:40},(_,i)=>({id:String(i+1),type:1,recipients:[],lastMessageId:'9007199254740993'}));
  const window={__sc_dm_activity:{'1':'9007199254740992'}};
  const Vencord={Webpack:{Common:{ChannelStore:{getSortedPrivateChannels:()=>channels},UserStore:{}},findStore:name=>name==='ReadStateStore'?{getLastMessageId:()=> '9007199254740994'}:{}}};
  const result=new Function('window','Vencord','scPresenceOf',`let result;switch('$get_dm_channels'){${body}}return result;`)(window,Vencord,()=>({}));
  assert.equal(result.length,40,'no arbitrary 30-DM cutoff');
  assert.equal(result[0].last_message_id,'9007199254740994','most recent store/dispatch activity wins without float rounding');
  const interceptStart=source.indexOf('// Observe all DM activity');
  const interceptEnd=source.indexOf('// Incoming DM call',interceptStart);
  const sent=[];
  const liveWindow={STEAMCORD_WS:{send:value=>sent.push(JSON.parse(value))}};
  const eventBridge=new Function('e','window','Vencord',source.slice(interceptStart,interceptEnd));
  const client={Webpack:{Common:{ChannelStore:{getChannel:id=>({type:id==='guild'?0:id==='group'?3:1})}}}};
  for(const id of ['dm','group','guild']) eventBridge({type:'MESSAGE_CREATE',message:{channel_id:id,id:'9007199254740993'}},liveWindow,client);
  assert.equal(sent.length,2,'DM and group messages refresh lists, guild messages do not');
  eventBridge({type:'MESSAGE_CREATE',message:{channel_id:'dm',id:'9007199254740992'}},liveWindow,client);
  assert.equal(sent.length,2,'late/duplicate messages cannot demote activity');
  for(const file of ['DMBrowser','TextChat','DiscordExpanded']) {
    const frontend=fs.readFileSync(`src/components/${file}.tsx`,'utf8');
    assert.match(frontend,/useDmChannels/);
    assert.match(frontend,/DmPinButton/);
    assert.doesNotMatch(frontend,/sort\(\(a, b\) => \(b.active_call/);
  }
  console.log('DM refresh, retained lists, cleanup, bridge metadata and all three shared views: OK');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
