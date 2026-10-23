import test from 'node:test';
import assert from 'node:assert/strict';
import {OfficialUsage,officialQuotaEligible,codexBucket,usageWindows,mergeCodexBucket} from '../usage-core.mjs';
const bucket={limitId:'codex',primary:{usedPercent:76,windowDurationMins:300,resetsAt:2000000000},secondary:{usedPercent:43,windowDurationMins:10080,resetsAt:2000500000}};
const response={rateLimits:bucket,rateLimitsByLimitId:{codex:bucket}};

test('official OAuth route differs from a relay, including an openai-named override',()=>{
  assert.equal(officialQuotaEligible({}),true);
  assert.equal(officialQuotaEligible({model_provider:'custom'}),false);
  assert.equal(officialQuotaEligible({model_providers:{openai:{base_url:'https://relay.example/v1'}}}),false);
  assert.equal(officialQuotaEligible({},{OPENAI_BASE_URL:'http://127.0.0.1:9000/v1'}),false);
  assert.equal(officialQuotaEligible({chatgpt_base_url:'https://relay.example'}),false);
  assert.equal(officialQuotaEligible({model_providers:{openai:{base_url:'https://api.openai.com/v1'}}}),true);
  assert.equal(officialQuotaEligible({model_providers:{openai:{requires_openai_auth:false}}}),false);
});

test('a custom provider name can use official OAuth without being a relay',()=>{
  const config={model_provider:'custom',chatgpt_base_url:'https://chatgpt.com/backend-api',model_providers:{custom:{requires_openai_auth:true}}};
  assert.equal(officialQuotaEligible(config),true);
  assert.equal(officialQuotaEligible({...config,modelProviders:undefined,model_providers:{custom:{requires_openai_auth:true,base_url:'https://api.openai.com/v1'}}}),true);
  assert.equal(officialQuotaEligible({...config,chatgpt_base_url:'https://relay.example/backend-api'}),false);
  assert.equal(officialQuotaEligible({...config,model_providers:{custom:{requires_openai_auth:true,base_url:'https://relay.example/v1'}}}),false);
  assert.equal(officialQuotaEligible({...config,model_providers:{custom:{requires_openai_auth:false}}}),false);
  assert.equal(officialQuotaEligible({...config,model_providers:{custom:{}}}),false);
});

test('select codex bucket and identify windows by duration, not order',()=>{
  const selected=codexBucket({...response,rateLimits:{...bucket,primary:{usedPercent:99,windowDurationMins:300}}});
  assert.equal(usageWindows(selected).fiveHour.remainingPercent,24);
  assert.equal(usageWindows({primary:bucket.secondary,secondary:bucket.primary}).weekly.remainingPercent,57);
  assert.deepEqual(usageWindows({primary:{usedPercent:25}}),{fiveHour:null,weekly:null});
  assert.equal(codexBucket({rateLimits:{limitId:'other',primary:bucket.primary}}),null);
  assert.equal(usageWindows({primary:{usedPercent:120,windowDurationMins:300}}).fiveHour.remainingPercent,0);
  assert.equal(usageWindows({primary:{usedPercent:null,windowDurationMins:300}}).fiveHour,null);
});

test('sparse notifications preserve the other window, explicit null clears it',()=>{
  const merged=mergeCodexBucket(bucket,{limitId:'codex',primary:{usedPercent:80}});
  assert.equal(usageWindows(merged).fiveHour.remainingPercent,20);
  assert.equal(usageWindows(merged).weekly.remainingPercent,57);
  assert.equal(usageWindows(mergeCodexBucket(merged,{limitId:'codex',secondary:null})).weekly,null);
  assert.equal(mergeCodexBucket(bucket,{limitId:'other',primary:null}),bucket);
});

test('relay never requests account state; API-key login never requests quota',async()=>{
  let calls=0;
  const relay=new OfficialUsage({call:async()=>{calls++;},eligible:()=>false});
  assert.equal((await relay.read()).visible,false);assert.equal(calls,0);
  const api=new OfficialUsage({call:async method=>{calls++;assert.equal(method,'account/read');return {account:{type:'apiKey'}};},eligible:()=>true});
  assert.equal((await api.read()).reason,'api-key');assert.equal(calls,1);
});

test('cache, parallel reads, safe display fields and provider-change invalidation',async()=>{
  let allowed=true,calls=0,finish;
  const gate=new Promise(resolve=>finish=resolve);
  const reader=new OfficialUsage({eligible:()=>allowed,call:async method=>{calls++;if(method==='account/read')return {account:{type:'chatgpt',email:'not-for-the-browser'}};await gate;return {...response,accountId:'not-for-the-browser'};}});
  const first=reader.read(),second=reader.read();finish();
  assert.equal((await first).windows.fiveHour.remainingPercent,24);await second;assert.equal(calls,2);
  await reader.read();assert.equal(calls,2);
  assert.ok(!JSON.stringify(reader.view()).includes('not-for-the-browser'));
  reader.update({limitId:'codex',primary:{usedPercent:81}});assert.equal(reader.view().windows.fiveHour.remainingPercent,19);
  allowed=false;reader.invalidate();assert.equal(reader.view().visible,false);
});

test('in-flight response cannot restore quotas after switching to a relay',async()=>{
  let allowed=true,finish;const gate=new Promise(resolve=>finish=resolve);
  const reader=new OfficialUsage({eligible:()=>allowed,call:async method=>{if(method==='account/read')return {account:{type:'chatgpt'}};await gate;return response;}});
  const pending=reader.read();await Promise.resolve();allowed=false;reader.invalidate();finish();
  assert.equal((await pending).visible,false);assert.equal(reader.view().visible,false);
});

test('notifications can initialize missing quotas and preserve newer fields during a read',async()=>{
  let finish,delayed=false,now=100000;
  const gate=new Promise(resolve=>finish=resolve);
  const reader=new OfficialUsage({now:()=>now,eligible:()=>true,call:async method=>{
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(delayed){await gate;return response;}
    return {};
  }});
  assert.equal((await reader.read()).status,'unavailable');
  reader.update({limitId:'codex',primary:bucket.primary});
  assert.equal(reader.view().windows.fiveHour.remainingPercent,24);
  assert.equal(reader.view().windows.weekly,null);
  now+=60001;delayed=true;
  const read=reader.read();await Promise.resolve();
  reader.update({limitId:'codex',primary:{usedPercent:80},secondary:null});
  finish();
  const result=await read;
  assert.equal(result.windows.fiveHour.remainingPercent,20);
  assert.equal(result.windows.weekly,null);
});
