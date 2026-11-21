const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../defaults/game_overlay/voice.html'),'utf8');
const scaleCode=html.slice(html.indexOf('  const displayScale ='),html.indexOf('  const liveEvents ='));
const layoutCode=html.slice(html.indexOf('  const relayoutPov ='),html.indexOf('  window.addEventListener?.("resize"'));
test('WebKit uses the same screen scale as Cairo, including 4K and invalid preferences',()=>{
 for(const [width,height,expected] of [[1280,800,1],[1280,720,1],[1920,1080,1.35],[3840,2160,2.7]]){
  const scale=vm.runInNewContext(scaleCode+'\ndisplayScale',{window:{innerWidth:width,innerHeight:height}});
  assert.equal(scale(100),expected);assert.equal(scale(400),expected*4);assert.equal(scale(NaN),expected);
 }
});
test('all WebKit video positions fit four tiles within a 4K viewport at maximum size',()=>{
 for(const layout of ['right','left','top','bottom','corners','top-left','top-right','bottom-left','bottom-right']){
  let factor;
  const sources=new Map(Array.from({length:4},(_,i)=>[String(i),{tile:{}}]));
  const context={window:{innerWidth:3840,innerHeight:2160},sources,povOrder:[],povEnabled:true,
   povSettings:{layout,scale:400},povBox:{style:{setProperty:(key,value)=>factor=Number(value)},appendChild(){}}};
  vm.runInNewContext(scaleCode+layoutCode+'\nrelayoutPov();',context);
  const horizontal=['top','bottom'].includes(layout),corners=layout==='corners';
  const cols=horizontal?4:corners?2:1,rows=horizontal?1:corners?2:4;
  const tileWidth=(corners?280:300)*factor;
  assert.ok(tileWidth*cols+(cols-1)*8<=3840-32+.001,layout);
  assert.ok(tileWidth*9/16*rows+(rows-1)*8<=2160-32+.001,layout);
 }
});
