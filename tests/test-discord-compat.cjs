const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../defaults/steamcord_client.js'),'utf8');
function factory(){const window={};vm.runInNewContext(src.slice(src.indexOf('// BEGIN DISCORD COMPATIBILITY REGISTRY'),src.indexOf('// END DISCORD COMPATIBILITY REGISTRY')),{window});return window.__scCreateCompat;}
test('missing Discord modules report unavailable and can recover later',()=>{
 let wp;const make=factory(), c=make(()=>wp,()=>null);
 assert.equal(c.store('UserStore'),null);
 assert.equal(c.action('account_add'),null);
 wp={findStore:()=>{throw Error('missing');},findByProps:()=>null};
 const d=c.diagnostics();assert.equal(d.stores.UserStore,false);assert.equal(d.actions.account_add,false);
 const store={privateToken:'not in diagnostic'};
 wp={findStore:()=>store,findByProps:()=>({})};
 assert.equal(c.store('UserStore'),store);
 assert.equal(c.diagnostics().stores.UserStore,true);
 assert.equal(JSON.stringify(c.diagnostics()).includes('privateToken'),false);
});
test('only successful lookups are cached, and a new webpack runtime invalidates them',()=>{
 let calls=0,ready=false;let wp={findStore:()=>{calls++;return ready?{ok:true}:null;}};
 const c=factory()(()=>wp,()=>null);
 assert.equal(c.store('ChannelStore'),null);ready=true;const a=c.store('ChannelStore');
 assert.equal(c.store('ChannelStore'),a);assert.equal(calls,2);
 wp={findStore:()=>({new:true})};assert.equal(c.store('ChannelStore').new,true);
});
test('minified account function predicates are isolated behind named actions',()=>{
 const c=factory()(()=>null,()=>predicate=>predicate('isMultiAccount:!0 LOGIN_RESET onBackPressed')?function add(){}:null);
 assert.equal(typeof c.action('account_add'),'function');assert.equal(c.action('unknown'),null);
});

test('broken Vencord Flux finder recovers stores without modifying shared Webpack state',()=>{
 const user={getName:()=> 'UserStore'}, guild={getName:()=> 'GuildStore',getGuilds:()=>({})};
 class Base { static getAll(){return [user,guild];} }
 class User extends Base {}
 Object.setPrototypeOf(user,User.prototype);
 const map=new Map();const wp={Common:{UserStore:user},fluxStores:map,findStore:()=>{throw TypeError('Reflect.get called on non-object');}};
 const c=factory()(()=>wp,()=>null);
 assert.equal(c.store('GuildStore'),guild);assert.equal(c.store('UserStore'),user);assert.equal(map.size,0);
 assert.equal(c.store('VoiceStateStore'),null);
 const voice={getName:()=> 'VoiceStateStore'};Base.getAll=()=>[user,guild,voice];
 assert.equal(c.store('VoiceStateStore'),voice);
});
test('Common store fallback works even if prototype registry is unavailable',()=>{
 const media={};const wp={Common:{MediaEngineStore:media},findStore:()=>{throw Error('Flux unavailable');}};
 const c=factory()(()=>wp,()=>null);assert.equal(c.store('MediaEngineStore'),media);
});
