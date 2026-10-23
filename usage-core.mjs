// Account quotas are separate from relay/API-key balances.
function officialUrl(value,hosts) {
  if(value==null||value==='')return true;
  try {const u=new URL(value);return u.protocol==='https:'&&hosts.includes(u.hostname)&&!u.username&&!u.password&&(!u.port||u.port==='443');}
  catch{return false;}
}

export function officialQuotaEligible(c={},env={}) {
  const provider=c.model_provider??c.modelProvider??'openai';
  const definition=(c.model_providers??c.modelProviders??{})[provider]??{};
  const requires=definition.requires_openai_auth??definition.requiresOpenaiAuth;
  // Provider IDs are labels; CC Switch can name an official OAuth route "custom".
  if(requires===false||(provider!=='openai'&&requires!==true))return false;
  const apiHosts=['api.openai.com'];
  const chatHosts=['chatgpt.com','chat.openai.com'];
  return [definition.base_url,definition.baseUrl,c.openai_base_url,c.openaiBaseUrl,env.OPENAI_BASE_URL]
    .every(url=>officialUrl(url,apiHosts))&&
    [c.chatgpt_base_url,c.chatgptBaseUrl,env.CHATGPT_BASE_URL].every(url=>officialUrl(url,chatHosts));
}

export function codexBucket(response) {
  const byId=response?.rateLimitsByLimitId;
  const bucket=byId?.codex??(response?.rateLimits?.limitId==='codex'?response.rateLimits:null);
  if(!bucket||(bucket.limitId!=null&&bucket.limitId!=='codex'))return null;
  // Keep only non-identifying, display-relevant fields in the cache.
  return {limitId:'codex',primary:bucket.primary??null,secondary:bucket.secondary??null};
}

export function usageWindows(bucket) {
  const windows=[bucket?.primary,bucket?.secondary];
  function select(minutes) {
    const value=windows.find(w=>w?.windowDurationMins===minutes);
    if(typeof value?.usedPercent!=='number'||!Number.isFinite(value.usedPercent))return null;
    return {remainingPercent:Math.min(100,Math.max(0,100-value.usedPercent)),
      resetsAt:typeof value.resetsAt==='number'&&Number.isFinite(value.resetsAt)&&value.resetsAt>0?value.resetsAt:null};
  }
  return {fiveHour:select(300),weekly:select(10080)};
}

export function mergeCodexBucket(previous,delta) {
  if(delta?.limitId!=='codex')return previous;
  const next={...(previous??{limitId:'codex'})};
  for(const key of ['primary','secondary']){
    if(!Object.hasOwn(delta,key))continue;
    next[key]=delta[key]==null?null:{...previous?.[key],...delta[key]};
  }
  return next;
}

export class OfficialUsage {
  constructor({call,eligible,onChange=()=>{},now=Date.now}) {
    this.call=call;this.eligible=eligible;this.onChange=onChange;this.now=now;
    this.generation=0;this.cache=null;this.snapshot=null;this.pending=null;this.lastAttempt=0;this.chatgpt=false;
  }
  hidden(reason='relay'){return {visible:false,reason};}
  view(){return this.eligible()?this.cache??this.hidden('unavailable'):this.hidden('relay');}
  invalidate(){this.generation++;this.cache=null;this.snapshot=null;this.chatgpt=false;this.lastAttempt=0;this.onChange();}
  commit(value,generation){if(generation!==this.generation||!this.eligible())return this.view();this.cache=value;this.onChange();return this.view();}
  async read({force=false}={}) {
    if(!this.eligible())return this.hidden('relay');
    const generation=this.generation;
    if(this.pending?.generation===generation)return this.pending.promise;
    if(this.cache&&this.now()-this.lastAttempt<(force?5000:60000))return this.view();
    this.lastAttempt=this.now();
    const notifications=[];
    const promise=(async()=>{
      try{
        const response=await this.call('account/read',{refreshToken:false});
        if(generation!==this.generation||!this.eligible())return this.view();
        if(response?.account?.type!=='chatgpt'){this.chatgpt=false;this.snapshot=null;return this.commit(this.hidden(response?.account?.type==='apiKey'?'api-key':'not-signed-in'),generation);}
        this.chatgpt=true;
        const limits=await this.call('account/rateLimits/read',{excludeResetCreditDetails:true});
        if(generation!==this.generation||!this.eligible())return this.view();
        this.snapshot=codexBucket(limits);
        // Notifications received during this read are newer than its snapshot.
        for(const delta of notifications)this.snapshot=mergeCodexBucket(this.snapshot,delta);
        const windows=usageWindows(this.snapshot);
        return this.commit({visible:true,status:windows.fiveHour||windows.weekly?'ready':'unavailable',updatedAt:this.now(),windows},generation);
      }catch{
        if(generation!==this.generation||!this.eligible())return this.view();
        if(notifications.length&&this.cache)return this.view();
        return this.commit(this.chatgpt?{visible:true,status:'unavailable',updatedAt:null,windows:{fiveHour:null,weekly:null}}:this.hidden('unavailable'),generation);
      }
    })();
    this.pending={generation,promise,notifications};
    try{return await promise;}finally{if(this.pending?.promise===promise)this.pending=null;}
  }
  update(delta) {
    if(!this.eligible()||!this.chatgpt||delta?.limitId!=='codex')return;
    this.pending?.notifications.push(delta);
    this.snapshot=mergeCodexBucket(this.snapshot,delta);
    const windows=usageWindows(this.snapshot);
    this.cache={visible:true,status:windows.fiveHour||windows.weekly?'ready':'unavailable',updatedAt:this.now(),windows};
    this.lastAttempt=this.now();
    this.onChange();
  }
}
