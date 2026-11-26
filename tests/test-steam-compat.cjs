const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm'),path=require('node:path');
const fixture=require('./helpers/steam-compat.cjs');

test('missing or changed Steam navigation fails closed without breaking the panel',()=>{
 const c=fixture({FocusNavController:{m_ActiveContext:{m_rgGamepadNavigationTrees:{}}}});
 assert.equal(c.getMainMenuWindow(),null);assert.equal(c.readSteamPersona(),null);
 assert.equal(c.resizeDiscordView(1280,800),false);
 assert.equal(Object.values(c.steamIntegrationStatus()).some(Boolean),false);
});
test('supported integrations are reported as booleans and bounds remain validated',()=>{
 const target={},calls=[];const window={friendStore:{m_FriendsUIFriendStore:{m_eUserPersonaState:1}},
 FocusNavController:{m_ActiveContext:{m_rgGamepadNavigationTrees:[{m_ID:'MainNavMenuContainer',Root:{Element:{ownerDocument:{defaultView:target}}}}]}},
 DISCORD_TAB:{m_browserView:{SetBounds:(...args)=>calls.push(args)}}};
 const c=fixture(window);assert.equal(c.getMainMenuWindow(),target);assert.equal(c.readSteamPersona(),1);
 assert.equal(c.resizeDiscordView(-1,800),false);assert.equal(c.resizeDiscordView(1280,800),true);
 assert.deepEqual(calls,[[0,0,1280,800]]);assert.equal(c.steamIntegrationStatus().browser_view,true);
});
test('notification sound guard preserves an existing foreign wrapper and cleans up',()=>{
 const calls=[];class Store{PlayNotificationSound(n){calls.push(['base',n]);}}
 const store=new Store(),base=store.PlayNotificationSound;
 const foreign=function(n){calls.push(['foreign',n]);return base.call(this,n);};
 store.PlayNotificationSound=foreign;
 const c=fixture({NotificationStore:store});
 assert.equal(c.guardNotificationSound(n=>n==='ours'),true);
 store.PlayNotificationSound('ours');assert.equal(calls.length,0);
 store.PlayNotificationSound('other');assert.deepEqual(calls,[['foreign','other'],['base','other']]);
 c.disposeNotificationSoundGuard();assert.equal(store.PlayNotificationSound,foreign);
});
test('unloading under an untracked foreign wrapper never overwrites it',()=>{
 const calls=[];const store={PlayNotificationSound:n=>calls.push(n)};
 const c=fixture({NotificationStore:store});c.guardNotificationSound(()=>true);
 const ours=store.PlayNotificationSound;
 const foreign=function(n){return ours.call(this,n);};store.PlayNotificationSound=foreign;
 c.disposeNotificationSoundGuard();assert.equal(store.PlayNotificationSound,foreign);
 store.PlayNotificationSound('other');assert.deepEqual(calls,['other']);
});
test('synthetic persona writes tolerate unavailable or read-only Steam fields',()=>{
 const c=fixture({});assert.equal(c.setSyntheticPersona('fake',1,'name'),false);
 const persona=Object.freeze({m_strPlayerName:'old'});
 const d=fixture({friendStore:{GetFriendState:()=>({m_persona:persona})}});
 assert.equal(d.setSyntheticPersona('fake',1,'new','avatar'),true);
 assert.equal(persona.m_strPlayerName,'old');
});
