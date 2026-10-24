import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
function ipcFixture() {
  const events = [];
  const context = vm.createContext({Map, Set, Date, own:new Set(), notify:()=>{}, event:t=>events.push(t)});
  vm.runInContext(source.slice(source.indexOf('class DesktopIPC'), source.indexOf('\nfunction applyPatches'))+'\nthis.client = new DesktopIPC();', context);
  const client = context.client, broadcasts = [];
  client.clientId = 'phone';
  client.broadcast = (...args)=>broadcasts.push(args);
  return {client, broadcasts, events};
}

test('desktop reopening a followed chat receives the follow acknowledgement', ()=>{
  const {client,broadcasts}=ipcFixture();
  client.following.add('chat');
  client.message({type:'broadcast',sourceClientId:'desktop',method:'thread-stream-following-status-requested',params:{conversationId:'chat',hostId:'local'}});
  assert.equal(broadcasts[0][0],'thread-stream-following-changed');
  assert.equal(broadcasts[0][1].following,true);
  assert.equal(broadcasts[0][2][0],'desktop');
});

test('IPC reset invalidates snapshots and re-subscribes to chats', ()=>{
  const {client,broadcasts,events}=ipcFixture();
  client.following.add('chat');client.states.set('chat',{state:{}});
  client.message({type:'broadcast',sourceClientId:'desktop',method:'ipc-connection-reset'});
  assert.equal(client.states.size,0);
  assert.equal(broadcasts[0][1].conversationId,'chat');
  assert.deepEqual(events,['connection']);
});

test('fallback history refresh replaces cached turns with new disk contents', async()=>{
  const context=vm.createContext({Map, mobile:new Map(), threadMeta:()=>({id:'chat'}), engine:{call:async()=>({data:[{id:'turn',items:['new']}],nextCursor:null})}});
  vm.runInContext(source.slice(source.indexOf('async function loadStored'),source.indexOf('\nasync function getThread'))+'\nthis.load = loadStored;',context);
  context.mobile.set('chat',{turns:[{id:'turn',items:['old']}],requests:new Map()});
  const actual=await context.load('chat');
  assert.equal(actual.turns.length,1);
  assert.equal(actual.turns[0].items[0],'new');
});

test('a lost desktop connection cannot silently start a second writer',async()=>{
  let started=false;
  const context=vm.createContext({own:new Set(),ipc:{clientId:null},validateId:()=>{},uploads:{input:()=>({input:[]})},engine:{call:()=>{started=true;}}});
  vm.runInContext(source.slice(source.indexOf('async function sendMessage'),source.indexOf('\nasync function stopThread'))+'\nthis.send = sendMessage;',context);
  await assert.rejects(context.send({id:'chat',text:'hello'}),/连接正在恢复/);
  assert.equal(started,false);
});
