const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(process.argv[2] || require('node:path').join(__dirname, '../src/steamMenu.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }}).outputText;
function setup(ready = true, gamepadFocus = false) {
  const intervals = new Map(); let seq = 0;
  const item = () => null;
  const items = ['Home', 'Library', 'Store', 'Settings'].map(label => ({type:item, key:label, props:{label, route:'/'+label, onFocus(){}, icon:'old'}}));
  if (gamepadFocus) for (const item of items) { item.props.onGamepadFocus = item.props.onFocus; delete item.props.onFocus; }
  const inner = () => items;
  const element = {type:inner};
  const original = () => ({props:{children:{props:{children:[element]}}}});
  const parent = {type:original, alternate:{type:original}};
  const node = {memoizedProps:{navID:'MainNavMenuContainer'},return:parent};
  let available = ready;
  const find = (value, pred, seen = new Set()) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value); if(pred(value)) return value;
    for (const child of Object.values(value)) { const found = find(child,pred,seen); if(found) return found; }
  };
  const context = {window:{}, document:{getElementById:()=>available?{}:null},localStorage:{getItem:()=>null}, console,
    setInterval:fn=>{intervals.set(++seq,fn);return seq},clearInterval:id=>intervals.delete(id),
    require:name=>name==='react'?{createElement:(type,p)=>({type, key:p.key,props:p})}:{findInReactTree:find,getReactRoot:()=>node}};
  vm.createContext(context);
  function load(code = compiled) {context.exports={};vm.runInContext("(function(){"+code+"})()",context);return context.exports.registerSteamMenu;}
  const render = () => { parent.type(); return element.type(); };
  const labels = () => Array.from(render(), x=>x.props.label);
  return {load,labels,render,items,parent,original,element,inner,intervals,ready:()=>{available=true;for(const tick of intervals.values())tick()}};
}
function entry(id,order){return {id,label:id,route:'/'+id,icon:id,order}}
let checks=0;
function check(name, fn) {fn();checks++;console.log('PASS',name)}
check('three bundles share one patch and sort entries independently of load order',()=>{
 const s=setup();const a=s.load(),b=s.load(),c=s.load();
 const offB=b(entry('bonecast',30));const wrapper=s.parent.type;
 const offS=a(entry('steamcord',10));const offK=c(entry('skullkey',20));
 assert.equal(s.parent.type,wrapper);
 assert.deepEqual(s.labels(),['Home','Library','steamcord','skullkey','bonecast','Store','Settings']);
 assert.deepEqual(s.labels(),s.labels());
 offS();assert.deepEqual(s.labels(),['Home','Library','skullkey','bonecast','Store','Settings']);
 offB();assert.deepEqual(s.labels(),['Home','Library','skullkey','Store','Settings']);
 offK();assert.equal(s.parent.type,s.original);assert.equal(s.element.type,s.inner);
 assert.equal(s.intervals.size,0);
 assert.deepEqual(s.labels(),["Home","Library","Store","Settings"]);
});
check('old instance cleanup does not remove replacement',()=>{
 const s=setup();const register=s.load();const old=register(entry('skullkey',20));
 const replacement=register(entry('skullkey',20));old();
 assert.equal(s.labels().filter(x=>x==='skullkey').length,1);replacement();assert.equal(s.parent.type,s.original);
});
check('retry cancelled when last owner unloads before menu exists',()=>{
 const s=setup(false);const off=s.load()(entry('bonecast',30));assert.equal(s.intervals.size,1);off();assert.equal(s.intervals.size,0);s.ready();assert.equal(s.parent.type,s.original);
});
check('late menu and repeated unload/load do not accumulate wrappers',()=>{
 const s=setup(false);const register=s.load();let off=register(entry('bonecast',30));s.ready();
 assert.equal(s.labels().filter(x=>x==='bonecast').length,1);off();
 for(let i=0;i<5;i++){off=register(entry('bonecast',30));assert.equal(s.labels().filter(x=>x==='bonecast').length,1);off();}
 assert.equal(s.parent.type,s.original);
});
check('current Steam onGamepadFocus contract is supported',()=>{ const s=setup(true,true);const off=s.load()(entry('skullkey',20));assert.equal(s.labels().filter(x=>x==='skullkey').length,1);const added=s.render().find(x=>x.key==='necro-menu:skullkey');assert.equal(typeof added.props.onGamepadFocus,'function');off();});
check('updating the shared owner keeps sibling entries and replaces stale code',()=>{
 const s=setup();const old=s.load(compiled.replace('const REVISION = 3;', 'const REVISION = 1;'));
 const offOld=old(entry('steamcord',10));const before=s.parent.type;
 const offNew=s.load()(entry('bonecast',30));assert.notEqual(s.parent.type,before);
 assert.deepEqual(s.labels(),['Home','Library','steamcord','bonecast','Store','Settings']);
 offOld();assert.equal(s.labels().includes('bonecast'),true);offNew();assert.equal(s.parent.type,s.original);
});
check('legacy Steamcord entries are removed without touching unrelated menu items',()=>{
 const s=setup();
 for(let i=0;i<12;i++)s.items.splice(1,0,{type:()=>null,key:'steamcord',props:{label:'Discord',route:'/discord',onFocus(){}}});
 s.items.push({type:()=>null,key:'other-plugin',props:{label:'Other Discord plugin',route:'/other-discord',onFocus(){}}});
 const off=s.load()(entry('steamcord',10));
 assert.equal(s.labels().filter(x=>x==='Discord').length,0);
 assert.equal(s.labels().filter(x=>x==='steamcord').length,1);
 assert.equal(s.labels().filter(x=>x==='Other Discord plugin').length,1);
 off();
});
console.log(checks+' menu lifecycle checks passed');
