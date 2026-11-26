const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),ts=require('typescript');
const source=fs.readFileSync(path.join(__dirname,'../src/videoVisibility.tsx'),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React,jsxFactory:'h'}}).outputText;
function fixture(env='gamescope') {
 const calls=[],timeouts=new Map(),intervals=new Map();let tick=0,doc,cleanups=[];
 const context={exports:{},h:()=>null,Promise,
  require:name=>name==='react'?{useRef:()=>({current:{ownerDocument:doc}}),useEffect:fn=>cleanups.push(fn())}:{call:async(name,...args)=>{calls.push([name,...args]);return name==='get_share_env'?{env}:true;}},
  setTimeout:fn=>{timeouts.set(++tick,fn);return tick;},clearTimeout:id=>timeouts.delete(id),
  setInterval:fn=>{intervals.set(++tick,fn);return tick;},clearInterval:id=>intervals.delete(id)};
 vm.createContext(context);vm.runInContext(code,context);
 const flush=async()=>{for(const fn of timeouts.values())fn();timeouts.clear();await new Promise(resolve=>setImmediate(resolve));};
 function mount(users,inFront=false){const handlers=new Set();doc={hidden:false,addEventListener:(_,fn)=>handlers.add(fn),removeEventListener:(_,fn)=>handlers.delete(fn)};const owned=doc;context.exports.VideoVisibility({users,inFront});const dispose=cleanups.pop();return {hide(){owned.hidden=true;handlers.forEach(fn=>fn());},show(){owned.hidden=false;handlers.forEach(fn=>fn());},dispose};}
 const messages=()=>calls.filter(c=>c[0]==='set_video_visibility').map(c=>JSON.parse(JSON.stringify(c.slice(1))));
 const foreground=()=>calls.filter(c=>c[0]==='set_video_foreground').map(c=>c[1]);
 return {api:context.exports,mount,flush,messages,foreground,intervals};
}
test('QAM hide does not mute a separate fullscreen surface',async()=>{
 const f=fixture();f.api.startVideoVisibility();await f.flush();
 const q=f.mount(['123']),full=f.mount(['456']);await f.flush();assert.deepEqual(f.messages().at(-1),[['123','456'],true]);
 q.hide();await f.flush();assert.deepEqual(f.messages().at(-1),[['456'],true]);
 full.dispose();await f.flush();assert.deepEqual(f.messages().at(-1),[[],true]);
 q.show();await f.flush();assert.deepEqual(f.messages().at(-1),[['123'],true]);
 q.dispose();f.api.stopVideoVisibility();await f.flush();assert.deepEqual(f.messages().at(-1),[[],false]);assert.equal(f.intervals.size,0);
});
test('desktop leaves native Discord audio outside UI policy',async()=>{
 const f=fixture('desktop');f.api.startVideoVisibility();f.mount(['123']);await f.flush();assert.deepEqual(f.messages().at(-1),[['123'],false]);f.api.stopVideoVisibility();
});

test('foreground lease lasts until the final visible video view closes',async()=>{
 const f=fixture();f.api.startVideoVisibility();await f.flush();
 const q=f.mount(['123'],true),full=f.mount(['456'],true);await f.flush();
 assert.equal(f.foreground().at(-1),true);
 q.hide();await f.flush();assert.equal(f.foreground().at(-1),true);
 full.dispose();await f.flush();assert.equal(f.foreground().at(-1),false);
 q.show();await f.flush();assert.equal(f.foreground().at(-1),true);
 f.api.stopVideoVisibility();await f.flush();assert.equal(f.foreground().at(-1),false);
});
