const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../defaults/tab_utils/steam_view.py'),'utf8');
const code=source.split('_VIEW_SCRIPT = """')[1].split('"""')[0];
function run(tab,visible){return vm.runInNewContext(code.replace('__VISIBLE__',String(visible)),{window:{DISCORD_TAB:tab}});}
test('voice render preserves the unocclusion sequence and hide restores valid bounds',()=>{
 const calls=[],tab={WIDTH:1280,HEIGHT:800,m_browserView:{SetBounds:(...args)=>calls.push(['bounds',...args]),SetVisible:value=>calls.push(['visible',value])}};
 assert.equal(run(tab,true),true);assert.deepEqual(calls,[['bounds',0,0,1,1],['visible',true]]);
 calls.length=0;assert.equal(run(tab,false),true);assert.deepEqual(calls,[['visible',false],['bounds',0,0,1280,800]]);
});
test('unsupported or changed Steam APIs do not cause side effects',()=>{
 assert.equal(run(undefined,true),false);assert.equal(run({m_browserView:{}},true),false);
 const calls=[],tab={WIDTH:NaN,HEIGHT:800,m_browserView:{SetBounds:()=>calls.push(1),SetVisible:()=>calls.push(2)}};
 assert.equal(run(tab,false),false);assert.equal(calls.length,0);
 assert.equal(run({m_browserView:{SetBounds(){throw Error('missing')},SetVisible(){}}},true),false);
});
