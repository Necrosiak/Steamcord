const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), ts = require('typescript'), vm = require('node:vm');
function load() {
 const ctx = {exports:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname,'../src/loginCompletion.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,ctx);
 return ctx.exports;
}
test('account-add captcha stays open until a different account is connected',()=>{
 const {loginCompleted}=load();
 assert.equal(loginCompleted({logged_in:true,me:{id:'old'}},{kind:'account-add',fromUserId:'old'}),false);
 assert.equal(loginCompleted({logged_in:true,me:{id:'new'}},{kind:'account-add',fromUserId:'old'}),true);
 assert.equal(loginCompleted({logged_in:false,me:{id:'new'}},{kind:'account-add',fromUserId:'old'}),false);
 assert.equal(loginCompleted({logged_in:true,me:{id:'new'}},{kind:'account-add',fromUserId:''}),false);
 assert.equal(loginCompleted({logged_in:true}),true);
});
