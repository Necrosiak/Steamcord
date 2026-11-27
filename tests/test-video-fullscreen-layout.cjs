const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const source=fs.readFileSync(path.join(__dirname,'../src/modalLayout.ts'),'utf8');

test('video dialogs remove height limits and restore borrowed Steam styles on close',()=>{
  const tasks=[];
  const ctx={exports:{},require:()=>({}),setTimeout:fn=>tasks.push(fn)};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,ctx);
  function style(initial={}){
    const props=new Map(Object.entries(initial));
    return {getPropertyValue:k=>props.get(k)||'',getPropertyPriority:()=>'',
      setProperty:(k,v)=>props.set(k,v),removeProperty:k=>props.delete(k)};
  }
  const win={getComputedStyle:()=>({backgroundColor:'rgba(0, 0, 0, 0)',backgroundImage:'none',boxShadow:'none',animationName:'dialog-intro'})};
  const doc={defaultView:win};
  const layer={style:style({'transform':'translate(40vw, 40vh)','will-change':'transform'}),classList:{contains:()=>false},parentElement:null,ownerDocument:doc};
  const outer={style:style({'transform':'translateY(32px)'}),classList:{contains:k=>k==='ModalOverlayContent'},parentElement:layer,ownerDocument:doc};
  const steam={classList:{contains:()=>false},style:style({'max-height':'85vh','padding':'24px','overflow':'hidden','transform':'scale(0.95)','animation':'dialog-intro 300ms forwards'}),parentElement:outer,ownerDocument:doc};
  const frame={classList:{contains:()=>false},parentElement:steam,ownerDocument:doc};
  const marker={isConnected:true,parentElement:frame,ownerDocument:doc};
  ctx.exports.videoFullscreenMarkerRef(marker);
  while(tasks.length)tasks.shift()();
  assert.equal(steam.style.getPropertyValue('max-height'),'none');
  assert.equal(steam.style.getPropertyValue('padding'),'0');
  assert.equal(ctx.exports.VIDEO_FULL_BLEED.height,'100vh');
  assert.equal(ctx.exports.VIDEO_FULL_BLEED.width,'100vw');
  assert.equal(ctx.exports.VIDEO_FULL_BLEED.position,'fixed');
  assert.equal(ctx.exports.VIDEO_FULL_BLEED.left,0);
  assert.equal(ctx.exports.VIDEO_FULL_BLEED.top,0);
  assert.equal(steam.style.getPropertyValue('transform'),'none');
  assert.equal(steam.style.getPropertyValue('animation'),'none');
  assert.equal(outer.style.getPropertyValue('transform'),'none');
  assert.equal(layer.style.getPropertyValue('transform'),'none');
  assert.equal(layer.style.getPropertyValue('will-change'),'auto');
  marker.isConnected=false;ctx.exports.videoFullscreenMarkerRef(null);
  while(tasks.length)tasks.shift()();
  assert.equal(steam.style.getPropertyValue('max-height'),'85vh');
  assert.equal(steam.style.getPropertyValue('padding'),'24px');
  assert.equal(steam.style.getPropertyValue('overflow'),'hidden');
  assert.equal(steam.style.getPropertyValue('max-width'),'');
  assert.equal(steam.style.getPropertyValue('transform'),'scale(0.95)');
  assert.equal(steam.style.getPropertyValue('animation'),'dialog-intro 300ms forwards');
  assert.equal(outer.style.getPropertyValue('transform'),'translateY(32px)');
  assert.equal(layer.style.getPropertyValue('transform'),'translate(40vw, 40vh)');
  assert.equal(layer.style.getPropertyValue('will-change'),'transform');
});
