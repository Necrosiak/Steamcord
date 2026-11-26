const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
module.exports=function(window) {
 const patcher={exports:{},console:{debug(){}}};
 const source=fs.readFileSync(require.resolve('@decky/ui').replace(/index\.js$/,'utils/patcher.js'),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{allowJs:true,module:ts.ModuleKind.CommonJS}}).outputText,patcher);
 const context={window,exports:{},require:()=>patcher.exports};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../../src/steamCompat.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
 return context.exports;
};
