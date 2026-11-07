const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../defaults/steamcord_client.js'),'utf8');
const start=source.indexOf('    window.rpcCloudName ='),end=source.indexOf('    const scReactClick =',start);
const context={window:{}};vm.runInNewContext(source.slice(start,end),context);
const pick=context.window.rpcCloudName;
test('cloud title only replaces the GeForce NOW launcher and manual title wins',()=>{
 assert.equal(pick({game:'NVIDIA GeForce NOW',cloud_game:'Portal 2'}),'Portal 2');
 for(const data of [{game:'Half-Life 2',cloud_game:'Portal 2'}, {game:'GeForce NOW',cloud_game:'Portal 2',detect:false},
  {game:'GeForce NOW',cloud_game:'Portal 2',override:'Manual'}, {game:null,cloud_game:'Portal 2'},
  {game:'GeForce NOW',cloud_game:'\nsecret'}, {game:'GeForce NOW',cloud_game:'x'.repeat(201)}])assert.equal(pick(data),null);
});

function dispatcher({offline=false}={}) {
 const updates=[], errors=[];
 let now=1000;
 const ctx={window:{},Date:{now:()=>now},console:{log(){},error:(...args)=>errors.push(args)},
   FluxDispatcher:{dispatch:value=>updates.push(value)},
   Vencord:{Webpack:{Common:{RestAPI:{get:async()=>{
     if(offline)throw Error('offline');
     return {ok:true,body:[{id:'101',name:'Portal 2',executables:[{name:'portal2.exe'}]},
       {id:'102',name:'Half-Life 2',executables:[{name:'hl2.exe'}]},
       {id:'103',name:"Baldur's Gate 3",executables:[]}]};
   }}}}}};
 vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('window.rpcNormName ='),source.indexOf('// ── Mapping message')),ctx);
 vm.runInContext(source.slice(start,end),ctx);
 const a=source.indexOf('case "$rpc": {'), b=source.indexOf('case "$get_dm_channels": {',a);
 vm.runInContext('dispatch=async(data)=>{switch(data.type){'+source.slice(a,b)+'}}',ctx);
 return {send:async data=>{await ctx.dispatch({type:'$rpc',started_at:123,...data});now+=1000;},updates,errors};
}

test('actual RPC dispatcher resolves artwork, changes cloud games and clears presence',async()=>{
 const f=dispatcher();
 await f.send({game:'GeForce NOW',cloud_game:'Portal 2',procs:['hl2.exe']});
 assert.equal(f.updates.at(-1).activity.name,'Portal 2');
 assert.equal(f.updates.at(-1).activity.application_id,'101');
 const began=f.updates.at(-1).activity.timestamps.start;
 await f.send({game:'GeForce NOW',cloud_game:'Portal 2'});
 assert.equal(f.updates.length,1,'same cloud game is not redispatched');
 await f.send({game:'GeForce NOW',cloud_game:'Half-Life 2'});
 assert.equal(f.updates.at(-1).activity.application_id,'102');
 assert.ok(f.updates.at(-1).activity.timestamps.start>began);
 await f.send({game:'GeForce NOW',cloud_game:null,procs:[]});
 assert.equal(f.updates.at(-1).activity.name,'GeForce NOW');
 await f.send({game:null,cloud_game:'Portal 2'});
 assert.equal(f.updates.at(-1).activity,null);
 assert.equal(f.errors.length,0);
});

test('manual title wins even if the Discord application database is unavailable',async()=>{
 const f=dispatcher({offline:true});
 await f.send({game:'GeForce NOW',cloud_game:'Portal 2',override:'My chosen game'});
 assert.equal(f.updates.at(-1).activity.name,'My chosen game');
});

test('offline cloud title still works, unknown titles do not borrow a local game artwork',async()=>{
 const offline=dispatcher({offline:true});
 await offline.send({game:'GeForce NOW',cloud_game:'Portal 2'});
 assert.equal(offline.updates.at(-1).activity.name,'Portal 2');
 assert.equal(offline.updates.at(-1).activity.application_id,'0');
 const f=dispatcher();
 await f.send({game:'GeForce NOW',cloud_game:'Unlisted cloud game',procs:['hl2.exe']});
 assert.equal(f.updates.at(-1).activity.name,'Unlisted cloud game');
 assert.equal(f.updates.at(-1).activity.application_id,'0');
 await f.send({game:'Half-Life 2',cloud_game:'Portal 2'});
 assert.equal(f.updates.at(-1).activity.name,'Half-Life 2');
 assert.equal(f.updates.at(-1).activity.application_id,'102');
});

test('cloud title normalization resolves typographic apostrophes without changing the name',async()=>{
 const f=dispatcher();
 await f.send({game:'GeForce NOW',cloud_game:'Baldur’s Gate 3'});
 assert.equal(f.updates.at(-1).activity.application_id,'103');
 assert.equal(f.updates.at(-1).activity.name,'Baldur’s Gate 3');
});
