import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import readline from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {UploadStore,asyncQuestions,pendingAsyncQuestions,questionReplies,questionReplyText,desktopSteerParams,desktopSettings,readProjects} from './mobile-core.mjs';
import {OfficialUsage,officialQuotaEligible} from './usage-core.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const CODEX=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
const configFile=path.join(ROOT,'config.json');
const CONFIG=JSON.parse(fs.readFileSync(fs.existsSync(configFile)?configFile:path.join(ROOT,'config.example.json'),'utf8'));
const CLI=CONFIG.cli_path||process.env.CODEX_CLI_PATH||[
 '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
 '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
].find(file=>fs.existsSync(file))||'codex';
const streams=new Set(), mobile=new Map(), loading=new Map(), own=new Set();
let catalog=[], config={}, shutting=false,configurationVersion=0;
fs.mkdirSync(path.join(ROOT,'private'),{recursive:true,mode:0o700});
const secretPath=path.join(ROOT,'private','pair.secret');
if(!fs.existsSync(secretPath))fs.writeFileSync(secretPath,crypto.randomBytes(32).toString('base64url'),{mode:0o600});
const secret=fs.readFileSync(secretPath,'utf8').trim();
const uploads=new UploadStore(path.join(ROOT,'private','uploads'));
const answeredRequests=new Map(),answeringRequests=new Set();
async function saveUpload(p){
  // iPhone photo libraries can supply HEIC/HEIF. Convert locally before model input.
  if(p.kind==='image'&&typeof p.data==='string'){
    const bytes=Buffer.from(p.data,'base64'),header=bytes.subarray(0,40).toString('ascii');
    if(bytes.subarray(4,8).toString()==='ftyp'&&/heic|heix|hevc|hevx|mif1|msf1|avif/.test(header)){
      if(bytes.length>16*1024*1024)throw Error('单个附件限 16 MB');
      const dir=fs.mkdtempSync(path.join(uploads.root,'.convert-')),source=path.join(dir,'photo'),dest=path.join(dir,'photo.jpg');
      try{fs.writeFileSync(source,bytes,{mode:0o600});await promisify(execFile)('/usr/bin/sips',['-s','format','jpeg',source,'--out',dest],{timeout:30000,maxBuffer:8192});return uploads.save({...p,name:String(p.name??'照片').replace(/\.[^.]+$/,'')+'.jpg',data:fs.readFileSync(dest).toString('base64')});}
      catch{throw Error('这张照片无法转换，请在相册导出为 JPG 后重试');}
      finally{fs.rmSync(dir,{recursive:true,force:true});}
    }
  }
  return uploads.save(p);
}
const id=()=>crypto.randomUUID();
const safeError=e=>String(e?.message??e).replace(/(Bearer\s+|(?:sk-|sess-))[A-Za-z0-9_\-.]+/gi,'[已隐藏]').slice(0,1200);
const event=(type,threadId)=>{const data=`data: ${JSON.stringify({type,threadId})}\n\n`;for(const s of streams){if(s.writableLength>1024*1024){s.end();streams.delete(s);}else s.write(data);}};
const changed=new Map();
function notify(t){if(changed.has(t))return;changed.set(t,setTimeout(()=>{changed.delete(t);event('thread',t);},100));}
function frame(v){const b=Buffer.from(JSON.stringify(v)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b]);}
function readFrames(socket,onMessage,max=64*1024*1024){let buffer=Buffer.alloc(0);socket.on('data',c=>{buffer=Buffer.concat([buffer,c]);try{while(buffer.length>=4){const n=buffer.readUInt32LE(0);if(!n||n>max)throw Error('Invalid frame');if(buffer.length<n+4)return;const m=JSON.parse(buffer.subarray(4,n+4).toString());buffer=buffer.subarray(n+4);onMessage(m);}}catch{socket.destroy();}});}

const versions={'thread-owner-discovery':1,'thread-stream-following-changed':1,'thread-stream-state-changed':11,'thread-stream-following-status-requested':1,'thread-follower-start-turn':2,'thread-follower-steer-turn':1,'thread-follower-interrupt-turn':4,'thread-follower-load-complete-history':1,'thread-follower-read-model-settings':1,'thread-follower-update-thread-settings':2,'thread-follower-command-approval-decision':1,'thread-follower-file-approval-decision':1,'thread-follower-submit-user-input':1,'thread-follower-submit-mcp-server-elicitation-response':1,'thread-follower-permissions-request-approval-response':1};
class DesktopIPC {
  socket=null;clientId=null;pending=new Map();states=new Map();following=new Set();lastFollow=new Map();followers=new Map();snapshotWaiters=new Map();
  connect(){if(shutting)return;const s=net.createConnection(path.join(CODEX,'ipc','ipc.sock'));this.socket=s;
    s.on('connect',async()=>{try{const r=await this.request('initialize',{clientType:'codex-mobile-local'},undefined,3000);this.clientId=r.result.clientId;for(const t of this.following)this.follow(t);event('connection');}catch{s.destroy();}});
    readFrames(s,m=>this.message(m));s.on('error',()=>{});s.on('close',()=>{if(this.socket!==s)return;this.clientId=null;this.states.clear();for(const [key,p]of this.pending){clearTimeout(p.timer);p.reject(Error('电脑连接已断开'));}this.pending.clear();event('connection');if(!shutting)setTimeout(()=>this.connect(),4000).unref();});
  }
  send(v){if(!this.socket||this.socket.destroyed)throw Error('请先打开 Mac 上的 Codex');this.socket.write(frame(v));}
  request(method,params,targetClientId,timeout=8000){const requestId=id();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(requestId);reject(Error('电脑暂时没有回应，请稍后重试'));},timeout);this.pending.set(requestId,{resolve,reject,timer});try{this.send({type:'request',requestId,sourceClientId:this.clientId??'initializing-client',method,params,version:versions[method]??0,targetClientId,timeoutMs:timeout});}catch(e){clearTimeout(timer);this.pending.delete(requestId);reject(e);}});}
  broadcast(method,params,targetClientIds){if(!this.clientId)return;this.send({type:'broadcast',method,params,version:versions[method]??0,sourceClientId:this.clientId,targetClientIds});}
  follow(t,following=true){this.lastFollow.set(t,Date.now());following?this.following.add(t):this.following.delete(t);this.broadcast('thread-stream-following-changed',{conversationId:t,hostId:'local',following});}
  waitSnapshot(t,timeout=1200){if(this.states.has(t))return Promise.resolve();return new Promise(resolve=>{const done=()=>{clearTimeout(timer);this.snapshotWaiters.get(t)?.delete(done);resolve();};const timer=setTimeout(done,timeout);const waiters=this.snapshotWaiters.get(t)??new Set();waiters.add(done);this.snapshotWaiters.set(t,waiters);});}
  async owner(t){if(!this.clientId)return null;try{const r=await this.request('thread-owner-discovery',{conversationId:t,hostId:'local'},undefined,1700);return r.resultType==='success'?r.handledByClientId:null;}catch{return null;}}
  async call(t,method,params){const owner=await this.owner(t);if(!owner)throw Error('电脑上的对话尚未就绪，请重新打开对话');const r=await this.request(method,{conversationId:t,...params},owner,30000);if(r.resultType!=='success')throw Error(r.error??'电脑未能完成操作');return r.result;}
  message(m){if(m.type==='response'){const p=this.pending.get(m.requestId);if(p){clearTimeout(p.timer);this.pending.delete(m.requestId);p.resolve(m);}return;}
    if(m.type==='client-discovery-request'){const r=m.request;this.send({type:'client-discovery-response',requestId:m.requestId,response:{canHandle:this.canHandle(r)}});return;}
    if(m.type==='request'){this.handleRequest(m).catch(()=>{});return;}
    if(m.type!=='broadcast'||m.sourceClientId===this.clientId)return;
    if(m.method==='thread-stream-following-status-requested'&&m.params?.hostId==='local'){
      const t=m.params.conversationId;if(this.following.has(t))this.broadcast('thread-stream-following-changed',{conversationId:t,hostId:'local',following:true},[m.sourceClientId]);return;
    }
    if(m.method==='ipc-connection-reset'){this.states.clear();this.followers.clear();for(const t of this.following)this.follow(t);event('connection');return;}
    if(m.method==='client-status-changed'&&m.params?.status==='disconnected'){for(const[t,state]of this.states)if(state.owner===m.params.clientId){this.states.delete(t);notify(t);}}
    if(m.method==='thread-stream-following-changed'&&m.params?.hostId==='local'&&own.has(m.params.conversationId)){
      const t=m.params.conversationId;const clients=this.followers.get(t)??new Set();m.params.following?clients.add(m.sourceClientId):clients.delete(m.sourceClientId);this.followers.set(t,clients);if(m.params.following)this.publish(t,[m.sourceClientId]);return;
    }
    if(m.method!=='thread-stream-state-changed'||m.params?.hostId!=='local'||m.version!==11)return;
    const t=m.params.conversationId;if(!this.following.has(t))return;const c=m.params.change;
    if(c?.type==='snapshot'){this.states.set(t,{state:c.conversationState,revision:c.revision,owner:m.sourceClientId});for(const resolve of this.snapshotWaiters.get(t)??[])resolve();this.snapshotWaiters.delete(t);notify(t);return;}
    const prior=this.states.get(t);if(c?.type!=='patches'||!prior||prior.owner!==m.sourceClientId||prior.revision!==c.baseRevision){if(c?.type==='patches')this.follow(t);return;}
    try{applyPatches(prior.state,c.patches??[]);applyText(prior.state,c.acceptedTextChanges??[]);prior.revision=c.revision;notify(t);}catch{this.states.delete(t);this.follow(t);}
  }
  canHandle(r){const t=r?.params?.conversationId;return own.has(t)&&(r.method==='thread-owner-discovery'||r.method.startsWith('thread-follower-'));}
  async handleRequest(r){try{if(!this.canHandle(r))throw Error('no-handler-for-request');const t=r.params.conversationId,p=r.params;let result={};
    switch(r.method){
      case 'thread-owner-discovery':result={supportsUntrustedAppInput:false};break;
      case 'thread-follower-start-turn':result={result:await ownTurn(t,p.turnStart.request)};break;
      case 'thread-follower-steer-turn':result={result:await ownSteer(t,p.input,p)};break;
      case 'thread-follower-interrupt-turn':await stopThread(t);break;
      case 'thread-follower-read-model-settings':{const v=mobile.get(t);result={settings:{model:v?.model,reasoningEffort:v?.effort,modelProvider:v?.provider,mode:'default',resumeState:'resumed'}};break;}
      case 'thread-follower-load-complete-history':result={revision:this.publish(t)};break;
      case 'thread-follower-update-thread-settings':await updateSettings(t,p.threadSettings);result={applied:true};break;
      case 'thread-follower-command-approval-decision':case 'thread-follower-file-approval-decision':await answerRequest(t,p.requestId,{decision:p.decision});break;
      case 'thread-follower-submit-user-input':case 'thread-follower-submit-mcp-server-elicitation-response':case 'thread-follower-permissions-request-approval-response':await answerRequest(t,p.requestId,p.response);break;
      default:throw Error('此客户端暂不支持这项操作');
    }
    this.send({type:'response',requestId:r.requestId,method:r.method,resultType:'success',handledByClientId:this.clientId,result});
    }catch(e){this.send({type:'response',requestId:r.requestId,resultType:'error',error:safeError(e)});}}
  publish(t,targets){const v=mobile.get(t);if(!v)return 0;const revision=(v.revision??0)+1;v.revision=revision;const clients=targets??[...(this.followers.get(t)??[])];if(clients.length)this.broadcast('thread-stream-state-changed',{conversationId:t,hostId:'local',change:{type:'snapshot',revision,conversationState:desktopState(v)}},clients);return revision;}
}
function applyPatches(state,patches){for(const p of patches){if(!p.path?.length)throw Error('Root patch');let obj=state;for(const k of p.path.slice(0,-1)){if(['__proto__','constructor','prototype'].includes(String(k)))throw Error('Unsafe patch');obj=obj[k];}const key=p.path.at(-1);if(['__proto__','constructor','prototype'].includes(String(key)))throw Error('Unsafe patch');if(p.op==='remove'){Array.isArray(obj)?obj.splice(Number(key),1):delete obj[key];}else if(p.op==='add'&&Array.isArray(obj))obj.splice(Number(key),0,p.value);else obj[key]=p.value;}}
function turnsOf(c){const h=c.turnHistory?.history;if(c.turnHistory?.kind==='canonical'&&h){return (h.islands??[]).flatMap(island=>(island.entries??[]).map(e=>h.entitiesByKey[e.value]).filter(Boolean));}return c.turns??[];}
function applyText(state,changes){for(const c of changes){if(c.type!=='text')continue;let turn=state.turnHistory?.history?.entitiesByKey?.[c.key?.entityKey];if(!turn)turn=turnsOf(state).find(t=>(t.items??[]).some(i=>i.id===c.key?.itemId));const item=turn?.items?.find(i=>i.id===c.key?.itemId);if(!item)continue;const field=c.target?.field;if(field!=='text')continue;let s=item[field]??'';for(const e of c.edits??[])s=s.slice(0,e.at)+e.insert+s.slice(e.at+e.deleteCount);item[field]=s;}}

class Engine {
  proc=null;pending=new Map();next=0;ready=null;restartPending=false;
  async start(){if(this.ready)return this.ready;this.ready=this.boot().catch(e=>{this.ready=null;throw e;});return this.ready;}
  async boot(){const routeVersion=configurationVersion,p=spawn(CLI,['app-server','--listen','stdio://'],{cwd:ROOT,stdio:['pipe','pipe','pipe'],env:{...process.env,RUST_LOG:'off'}});this.proc=p;
    readline.createInterface({input:p.stdout}).on('line',line=>{try{this.message(JSON.parse(line));}catch{}});
    // Keep raw engine logs out of the gateway: provider errors may contain URLs or headers.
    p.stderr.on('data',()=>{});p.on('error',()=>{});p.on('exit',()=>{if(this.proc!==p)return;this.ready=null;this.proc=null;for(const [,r]of this.pending){clearTimeout(r.timer);r.reject(Error('Codex 引擎已退出，请重试'));}this.pending.clear();config={...config,officialQuotaEligible:false};usage.invalidate();for(const t of own){const v=mobile.get(t);if(v?.active){v.active=false;v.error='本机 Codex 引擎已退出';notify(t);}}own.clear();event('connection');});
    await this.raw('initialize',{clientInfo:{name:'codex_mobile_local',title:'Codex Mobile Local',version:'1.0.0'},capabilities:{experimentalApi:true}},15000);this.write({method:'initialized',params:{}});
    const r=await this.raw('model/list',{includeHidden:false,limit:100},15000).catch(()=>({data:[]}));catalog=r.data??[];
    const c=await this.raw('config/read',{includeLayers:false},10000).catch(()=>({config:null}));
    if(this.proc!==p||routeVersion!==configurationVersion)return;
    config={model:c.config?.model,effort:c.config?.model_reasoning_effort??c.config?.modelReasoningEffort,provider:c.config?.model_provider??c.config?.modelProvider??'openai',officialQuotaEligible:!!c.config&&officialQuotaEligible(c.config,process.env)};event('state');event('connection');
  }
  write(v){if(!this.proc?.stdin.writable)throw Error('Codex 引擎未启动');this.proc.stdin.write(JSON.stringify(v)+'\n');}
  raw(method,params,timeout=30000){const n=++this.next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(n);reject(Error('Codex 引擎响应超时'));},timeout);this.pending.set(n,{resolve,reject,timer});try{this.write({id:n,method,params});}catch(e){clearTimeout(timer);this.pending.delete(n);reject(e);}});}
  async call(method,params,timeout){await this.start();return this.raw(method,params,timeout);}
  message(m){if('id'in m&&('result'in m||'error'in m)){const r=this.pending.get(m.id);if(r){clearTimeout(r.timer);this.pending.delete(m.id);m.error?r.reject(Error(safeError(m.error))):r.resolve(m.result);}return;}
    if(m.method==='account/rateLimits/updated'){usage.update(m.params?.rateLimits);return;}
    if(m.method==='account/updated'){usage.invalidate();return;}
    if('id'in m&&m.method){const t=m.params?.threadId,v=mobile.get(t);if(v){v.requests.set(String(m.id),{id:m.id,method:m.method,params:m.params});notify(t);ipc.publish(t);}return;}
    const p=m.params??{},t=p.threadId,v=mobile.get(t);if(!v)return;
    if(m.method==='turn/started'){const turn=p.turn;v.active=true;v.turnId=turn.id;let found=v.turns.find(x=>x.id===turn.id);if(!found){found={...turn,items:turn.items??[]};v.turns.push(found);}v.error=null;}
    else if(m.method==='turn/completed'){v.active=false;const turn=v.turns.find(x=>x.id===p.turn.id);if(turn){turn.status=p.turn.status;turn.error=p.turn.error;}v.error=p.turn.error?.message??null;if(this.restartPending&&!hasActiveOwn())this.restart();}
    else if(m.method==='item/started'||m.method==='item/completed'){let turn=v.turns.find(x=>x.id===p.turnId);if(!turn){turn={id:p.turnId,status:'inProgress',items:[]};v.turns.push(turn);}const ix=turn.items.findIndex(x=>x.id===p.item.id);if(ix<0)turn.items.push(p.item);else turn.items[ix]=p.item;}
    else if(m.method==='item/agentMessage/delta'||m.method==='item/plan/delta'){const item=findItem(v,p.turnId,p.itemId);if(item)item.text=(item.text??'')+p.delta;}
    else if(m.method==='item/commandExecution/outputDelta'){const item=findItem(v,p.turnId,p.itemId);if(item)item.aggregatedOutput=(item.aggregatedOutput??'')+p.delta;}
    else if(m.method==='serverRequest/resolved')v.requests.delete(String(p.requestId));
    else if(m.method==='thread/status/changed'){v.active=p.status?.type==='active';}
    else if(m.method==='error')v.error=p.error?.message??'任务发生错误';
    else return;notify(t);ipc.publish(t);
  }
  restart(){this.restartPending=false;if(hasActiveOwn()){this.restartPending=true;return;}for(const t of own)mobile.delete(t);own.clear();this.proc?.kill('SIGTERM');}
}
function findItem(v,turnId,itemId){return v.turns.find(t=>t.id===turnId)?.items?.find(i=>i.id===itemId);}
function hasActiveOwn(){return [...own].some(t=>mobile.get(t)?.active);}
const engine=new Engine(),ipc=new DesktopIPC();
const usage=new OfficialUsage({call:(method,params)=>engine.call(method,params,10000),eligible:()=>config.officialQuotaEligible===true,onChange:()=>event('usage')});
function stateDb(){return new DatabaseSync((CONFIG.state_db_path||path.join(CODEX,'state_5.sqlite')),{readOnly:true});}
function listThreads(cursor=0,project=''){let db;try{db=stateDb();const all=db.prepare("SELECT id,COALESCE(NULLIF(name,''),NULLIF(title,''),'新对话') title,cwd,model,model_provider provider,updated_at updatedAt,is_pinned pinned FROM threads WHERE archived=0 AND source NOT LIKE '%subAgent%' AND source NOT LIKE '%subagent%' ORDER BY is_pinned DESC,COALESCE(recency_at,updated_at) DESC").all();const registry=readProjects(CODEX,all),offset=Math.max(0,Number(cursor)||0);const rows=all.filter(t=>!project||(project==='__none'?!registry.locate(t):registry.locate(t)?.id===project)).slice(offset,offset+61);return{threads:rows.slice(0,60).map(t=>({...t,projectId:registry.locate(t)?.id??null,projectLabel:registry.locate(t)?.label??null,active:ipc.states.get(t.id)?.state.threadRuntimeStatus?.type==='active'||mobile.get(t.id)?.active||false})),cursor:rows.length>60?String(offset+60):null};}finally{db?.close();}}
function projects(){let db;try{db=stateDb();const rows=db.prepare("SELECT id,cwd FROM threads WHERE archived=0 AND cwd IS NOT NULL AND cwd<>'' AND source NOT LIKE '%subAgent%' AND source NOT LIKE '%subagent%' GROUP BY cwd").all();const registry=readProjects(CODEX,rows);const projects=registry.projects.filter(p=>p.path&&fs.existsSync(p.path));for(const row of rows){if(!fs.existsSync(row.cwd)||projects.some(p=>p.roots.some(r=>row.cwd===r||row.cwd.startsWith(r+'/'))))continue;projects.push({id:'directory:'+row.cwd,path:row.cwd,label:path.basename(row.cwd)==='mobile-workspace'?'手机工作区':'目录 · '+path.basename(row.cwd),roots:[row.cwd],kind:'directory'});}return projects;}finally{db?.close();}}
function threadMeta(t){let db;try{db=stateDb();return db.prepare('SELECT id,COALESCE(NULLIF(name,\'\'),title) title,cwd,model,model_provider provider,reasoning_effort effort FROM threads WHERE id=?').get(t);}finally{db?.close();}}
function validateId(t){if(typeof t!=='string'||!/^[\w-]{1,128}$/.test(t))throw Error('无效的对话');return t;}
async function loadStored(t,cursor){const meta=threadMeta(t);if(!meta)throw Error('找不到这条对话');const response=await engine.call('thread/turns/list',{threadId:t,limit:15,sortDirection:'desc',itemsView:'full',...(cursor?{cursor}: {})});const turns=(response.data??[]).reverse();let v=mobile.get(t);if(!v){v={...meta,turns,requests:new Map(),active:false,source:'mobile',olderCursor:response.nextCursor};mobile.set(t,v);}else if(cursor){v.turns=[...turns.filter(x=>!v.turns.some(y=>x.id===y.id)),...v.turns];v.olderCursor=response.nextCursor;}else{const fresh=new Map(turns.map(turn=>[turn.id,turn]));v.turns=[...v.turns.filter(turn=>!fresh.has(turn.id)),...turns];Object.assign(v,meta);}return v;}
async function getThread(t,cursor){validateId(t);if(own.has(t)){return normalizeMobile(mobile.get(t));}
  if(!ipc.following.has(t)||(!ipc.states.has(t)&&Date.now()-(ipc.lastFollow.get(t)??0)>2000)||Date.now()-(ipc.lastFollow.get(t)??0)>30000){ipc.follow(t);await ipc.waitSnapshot(t);}
  const live=ipc.states.get(t);if(live){const modelSettings=await ipc.call(t,'thread-follower-read-model-settings',{}).catch(()=>null);return normalizeDesktop(live.state,modelSettings?.settings);}
  {const key=t+':'+(cursor??'');if(!loading.has(key))loading.set(key,loadStored(t,cursor).finally(()=>loading.delete(key)));await loading.get(key);}
  return normalizeMobile(mobile.get(t));
}
function contentText(c){if(typeof c==='string')return c;const replies=questionReplies(c);if(replies.length)return replies.map(r=>r.question+'\n'+r.answer).join('\n\n');return(c??[]).map(x=>{const text=x.text??x.content;if(typeof text==='string'&&text.startsWith('# Files mentioned by the user:')&&text.includes(uploads.root+'/'))return text.split('## My request:\n\n').slice(1).join('## My request:\n\n');return text??(x.type==='image'||x.type==='localImage'?'[图片]':'');}).join('\n');}
function itemAttachments(content){const ids=new Set();for(const x of content??[]){if(x.type==='localImage'&&typeof x.path==='string'){const rel=path.relative(uploads.root,x.path).split(path.sep);if(rel.length===2)ids.add(rel[0]);}if(typeof x.text==='string'){const escaped=uploads.root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');for(const match of x.text.matchAll(new RegExp(escaped+'/([a-f0-9-]{36})/file-','g')))ids.add(match[1]);}}return[...ids].flatMap(id=>{try{const f=uploads.get(id);return[{id:f.id,name:f.name,size:f.size,kind:f.kind,url:'/api/attachment/'+f.id}];}catch{return[];}});}

function normalizeItems(turns){const out=[],settled=asyncQuestions(turns).filter(q=>q.submitted);for(const turn of turns){for(const item of turn.items??[]){const i={id:item.id??id()};switch(item.type){
    case 'userMessage':out.push({...i,kind:'user',text:contentText(item.content),attachments:itemAttachments(item.content)});break;
    case 'steeringUserMessage':out.push({...i,kind:'user',text:contentText(item.input),attachments:itemAttachments(item.input)});break;
    case 'agentMessage':case 'plan':if(item.text)out.push({...i,kind:'agent',text:item.text,phase:item.phase});break;
    case 'commandExecution':out.push({...i,kind:'tool',title:item.status==='inProgress'?'正在执行命令':'执行命令',text:[item.command,item.aggregatedOutput].filter(Boolean).join('\n\n')});break;
    case 'fileChange':out.push({...i,kind:'tool',title:'修改文件',text:(item.changes??[]).map(c=>c.path+'\n'+(c.diff??'')).join('\n\n')});break;
    case 'mcpToolCall':out.push({...i,kind:'tool',title:item.tool??'使用工具',text:item.error?JSON.stringify(item.error):contentText(item.result?.content??[])});break;
    case 'userInputResponse':if(item.completed)out.push({...i,kind:'question',request:{id:item.requestId,submitted:true,params:{questions:item.questions??[]},answer:Object.values(item.answers??{}).flat().join('、')||'已处理'}});break;
    case 'webSearch':out.push({...i,kind:'tool',title:'搜索资料',text:item.query??''});break;
  }if(item.type==='agentMessage')for(const q of settled.filter(q=>q.sourceItemId===item.id))out.push({id:q.id,kind:'question',request:q});}if(turn.error?.message)out.push({id:turn.id+'-error',kind:'error',text:turn.error.message});}return out.slice(-1200);}
function requestsDesktop(c){return [...new Map([...(c.requests??[]).filter(r=>!r.completedAtMs&&!r.completed).map(r=>({id:r.requestId??r.id,method:r.method??r.type,params:r.params??r})),...pendingAsyncQuestions(turnsOf(c))].map(r=>[String(r.id),r])).values()].filter(r=>!answeredRequests.has(c.id+':'+r.id));}
function normalizeDesktop(c,settings){const turns=turnsOf(c),active=turns.findLast(t=>t.status==='inProgress');const registry=readProjects(CODEX,[c]);return{id:c.id,title:c.title??'Codex',cwd:c.cwd,projectId:registry.locate(c)?.id??null,...desktopSettings({...c,turns},settings),provider:settings?.modelProvider??c.modelProvider,active:!!active||c.threadRuntimeStatus?.type==='active',turnId:active?.turnId??active?.id,source:'desktop',items:normalizeItems(turns),requests:requestsDesktop(c),olderCursor:null};}
function normalizeMobile(v){const registry=readProjects(CODEX,[v]);return{id:v.id,title:v.title??'新对话',cwd:v.cwd,projectId:registry.locate(v)?.id??null,model:v.model,effort:v.effort,activeModel:v.activeModel??v.model,activeEffort:v.activeEffort??v.effort,provider:v.provider,active:!!v.active,turnId:v.turnId,source:'mobile',items:normalizeItems(v.turns),requests:[...v.requests.values(),...pendingAsyncQuestions(v.turns)].filter(r=>!answeredRequests.has(v.id+':'+r.id)),olderCursor:v.olderCursor??null};}
function desktopState(v){const turns=v.turns.map(t=>({...t,turnId:t.id,params:{threadId:v.id,cwd:v.cwd,input:[],model:t.status==='inProgress'?v.activeModel??v.model:v.model,effort:t.status==='inProgress'?v.activeEffort??v.effort:v.effort},completedItemIds:{},turnStartedAtMs:Date.now(),durationMs:t.status==='inProgress'?null:0}));return{id:v.id,hostId:'local',turns,requests:[...v.requests.values()],title:v.title,createdAt:v.createdAt??Date.now(),updatedAt:Date.now(),recencyAt:Date.now(),source:'appServer',originator:'codex_mobile_local',threadSource:'cli',historyMode:'legacy',mode:'default',threadStartKind:'default',modelProvider:v.provider??config.provider,latestModel:v.model,latestReasoningEffort:v.effort??null,latestCollaborationMode:{mode:'default',settings:{model:v.model,reasoning_effort:v.effort??null,developer_instructions:null}},hasUnreadTurn:false,threadRuntimeStatus:{type:v.active?'active':'idle',activeFlags:[]},resumeState:'resumed',workspaceKind:'project',cwd:v.cwd,environments:[],turnsPagination:{olderCursor:null,isLoadingOlder:false,hasLoadedOldest:true},sessionId:v.id,currentPermissions:v.permissions,latestThreadSettings:{cwd:v.cwd,model:v.model,effort:v.effort},boundedCloudHistory:false};}
async function ensureOwn(t){if(own.has(t))return mobile.get(t);const v=mobile.get(t)??await loadStored(t);const r=await engine.call('thread/resume',{threadId:t,excludeTurns:true});v.model=r.model??v.model;v.effort=r.reasoningEffort??v.effort;v.permissions=r.sandbox??r.sandboxPolicy;own.add(t);return v;}
async function ownTurn(t,request){const v=await ensureOwn(t);const r=await engine.call('turn/start',{...request,threadId:t});v.turnId=r.turn.id;v.activeModel=request.model??v.model;v.activeEffort=request.effort??v.effort;if(!v.turns.some(turn=>turn.id===r.turn.id))v.turns.push({...r.turn,items:r.turn.items??[]});v.active=true;notify(t);return r;}
async function ownSteer(t,text,extra={}){const v=mobile.get(t);if(!v?.turnId)throw Error('当前没有运行中的任务');return engine.call('turn/steer',{threadId:t,expectedTurnId:v.turnId,input:extra.input??[{type:'text',text}],...(extra.clientUserMessageId?{clientUserMessageId:extra.clientUserMessageId}:{}),...(extra.additionalContext?{additionalContext:extra.additionalContext}:{})});}
async function sendMessage(p){const text=typeof p.text==='string'?p.text.trim():'';if(text.length>100000||(!text&&!p.attachments?.length))throw Error('请输入消息或添加附件（文字最多十万字）');const content=uploads.input(text,p.attachments??[]);let t=p.id;
  if(!t){const cwd=p.cwd||projects()[0]?.path||ROOT;if(!path.isAbsolute(cwd)||!fs.statSync(cwd).isDirectory())throw Error('请选择有效的项目位置');const r=await engine.call('thread/start',{cwd,...(p.model?{model:p.model}:{}),...(p.effort?{config:{model_reasoning_effort:p.effort}}:{}),experimentalRawEvents:false});t=r.thread.id;const v={id:t,title:(text||content.files.map(f=>f.name).join('、')).slice(0,36),cwd,model:r.model??p.model??config.model,effort:p.effort??r.reasoningEffort??config.effort,provider:r.modelProvider??config.provider,createdAt:Date.now(),turns:[],active:false,requests:new Map(),source:'mobile',permissions:r.sandbox};mobile.set(t,v);own.add(t);await engine.call('thread/name/set',{threadId:t,name:v.title}).catch(()=>{});}
  validateId(t);if(!own.has(t)&&!ipc.clientId)throw Error('电脑连接正在恢复，请稍后重试');const owner=await ipc.owner(t);if(!owner&&ipc.states.has(t))throw Error('正在确认电脑会话状态，请稍后重试');
  if(owner&&owner!==ipc.clientId){ipc.follow(t);await ipc.waitSnapshot(t);const state=ipc.states.get(t)?.state;if(!state)throw Error('正在重新同步电脑对话，请稍后重试');const active=normalizeDesktop(state).active;
    if(active)await ipc.call(t,'thread-follower-steer-turn',desktopSteerParams(state,content,id()));
    else await ipc.call(t,'thread-follower-start-turn',{turnStart:{request:{threadId:t,clientUserMessageId:id(),input:content.input,...(p.model?{model:p.model}:{}),...(p.effort?{effort:p.effort}:{})},context:{attachments:content.attachments}}});
  }else{const v=await ensureOwn(t);if(v.active)await ownSteer(t,content.text,{input:content.input});else await ownTurn(t,{input:content.input,model:p.model??v.model,effort:p.effort??v.effort});}
  notify(t);event('state');return{id:t};
}
async function stopThread(t){validateId(t);if(own.has(t)){const v=mobile.get(t);if(v?.turnId)await engine.call('turn/interrupt',{threadId:t,turnId:v.turnId});return;}const state=ipc.states.get(t)?.state;await ipc.call(t,'thread-follower-interrupt-turn',{expectedTurnId:state?normalizeDesktop(state).turnId:null});}
async function updateSettings(t,p){validateId(t);const owner=own.has(t)?ipc.clientId:await ipc.owner(t);if(!owner||owner===ipc.clientId){const v=await ensureOwn(t);const settings={...(p.model?{model:p.model}:{}),...('effort'in p?{effort:p.effort||null}:{})};await engine.call('thread/settings/update',{threadId:t,...settings});if(p.model)v.model=p.model;if('effort'in p)v.effort=p.effort||null;notify(t);ipc.publish(t);return;}const result=await ipc.call(t,'thread-follower-update-thread-settings',{threadSettings:{...(p.model?{model:p.model}:{}),...('effort'in p?{effort:p.effort||null}:{})}});if(result.applied!==true)throw Error('电脑没有应用这组设置，请刷新后再试');}
async function answerRequest(t,requestId,response){validateId(t);const key=t+':'+requestId;if(answeringRequests.has(key)||answeredRequests.has(key))throw Error('这项请求已经提交，请等待同步');answeringRequests.add(key);
  try{const c=ipc.states.get(t)?.state,v=mobile.get(t);const r=own.has(t)?normalizeMobile(v).requests.find(r=>String(r.id)===String(requestId)):requestsDesktop(c??{}).find(r=>String(r.id)===String(requestId));if(!r)throw Error('这项请求已经处理，请刷新');
    if(r.method==='async-user-input')await sendMessage({id:t,text:questionReplyText(r,response.answers)});
    else if(own.has(t)){engine.write({id:r.id,result:response});v.requests.delete(String(requestId));ipc.publish(t);}
    else{let method;if(/command/i.test(r.method))method='thread-follower-command-approval-decision';else if(/file/i.test(r.method))method='thread-follower-file-approval-decision';else if(/input/i.test(r.method))method='thread-follower-submit-user-input';else if(/elicitation/i.test(r.method))method='thread-follower-submit-mcp-server-elicitation-response';else throw Error('请在电脑上处理这类权限请求');await ipc.call(t,method,{requestId:r.id,...(response.decision?{decision:response.decision}:{response})});}
    answeredRequests.set(key,Date.now());setTimeout(()=>answeredRequests.delete(key),600000).unref();notify(t);
  }finally{answeringRequests.delete(key);}
}


function authenticated(req){const m=/(?:^|;\s*)codex_mobile=([^;]+)/.exec(req.headers.cookie??'');if(!m)return false;const parts=m[1].split('.');if(parts.length!==3||Number(parts[1])<Date.now())return false;const sig=crypto.createHmac('sha256',secret).update(parts[0]+'.'+parts[1]).digest('base64url');return safeEqual(sig,parts[2]);}
function safeEqual(a,b){const x=Buffer.from(a??''),y=Buffer.from(b??'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function cookie(){const payload=crypto.randomBytes(16).toString('base64url')+'.'+(Date.now()+30*86400000);return payload+'.'+crypto.createHmac('sha256',secret).update(payload).digest('base64url');}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function body(req,limit=250000){let bytes=0,b='';for await(const c of req){bytes+=c.length;if(bytes>limit)throw Error('请求太大');b+=c;}return JSON.parse(b||'{}');}
const failures=new Map();
const staticFiles={'/':['index.html','text/html; charset=utf-8'],'/app.css':['app.css','text/css; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/icon.svg':['icon.svg','image/svg+xml'],'/apple-touch-icon.png':['apple-touch-icon.png','image/png']};
const server=http.createServer(async(req,res)=>{try{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  const host=req.headers.host??'';const hostname=host.replace(/:\d+$/,'');if(![bindAddress,'127.0.0.1','localhost'].includes(hostname))return json(res,403,{error:'无效的访问地址'});
  if(req.headers.origin&&req.headers.origin!=='http://'+host)return json(res,403,{error:'访问来源不匹配'});
  const url=new URL(req.url,'http://'+host),route=url.pathname;
  if(route==='/api/pair'&&req.method==='POST'){const ip=req.socket.remoteAddress,prior=failures.get(ip);if(prior?.count>=10&&Date.now()-prior.time<600000)return json(res,429,{error:'尝试次数太多，请稍后再试'});const p=await body(req);if(!safeEqual(p.token,secret)){failures.set(ip,{count:(prior?.count??0)+1,time:Date.now()});return json(res,401,{error:'配对链接不正确，请重新复制 Mac 上的专属链接'});}failures.delete(ip);res.setHeader('Set-Cookie','codex_mobile='+cookie()+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000');return json(res,200,{ok:true});}
  if(staticFiles[route]&&req.method==='GET'){const[file,type]=staticFiles[route];res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});return fs.createReadStream(path.join(ROOT,'web',file)).pipe(res);}
  if(!authenticated(req))return json(res,401,{error:'请先使用 Mac 上的专属链接配对'});
  if(route==='/api/events'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write('data: {"type":"connection"}\n\n');try{for(const t of listThreads().threads)res.write('data: '+JSON.stringify({type:'thread',threadId:t.id})+'\n\n');}catch{}streams.add(res);const keep=setInterval(()=>res.write(': keepalive\n\n'),25000);req.on('close',()=>{clearInterval(keep);streams.delete(res);});return;}
  if(route==='/api/state'&&req.method==='GET'){engine.start().catch(()=>{});return json(res,200,{...listThreads(0,url.searchParams.get('project')??''),projects:projects(),models:catalog.map(m=>({model:m.model,displayName:m.displayName,supportedReasoningEfforts:m.supportedReasoningEfforts,defaultReasoningEffort:m.defaultReasoningEffort,inputModalities:m.inputModalities})),config,connected:{desktop:!!ipc.clientId,engine:!!engine.proc},activeMobileTasks:[...own].filter(t=>mobile.get(t)?.active).length});}
  if(route==='/api/usage'&&req.method==='GET'){await engine.start().catch(()=>{});return json(res,200,await usage.read({force:url.searchParams.get('refresh')==='1'}));}
  if(route==='/api/threads'&&req.method==='GET')return json(res,200,listThreads(url.searchParams.get('cursor'),url.searchParams.get('project')??''));
  if(route==='/api/thread'&&req.method==='GET')return json(res,200,await getThread(url.searchParams.get('id'),url.searchParams.get('cursor')));
  if(route.startsWith('/api/attachment/')&&req.method==='GET'){const f=uploads.get(route.slice('/api/attachment/'.length));res.writeHead(200,{'Content-Type':f.mime,'Content-Length':f.size,'Cache-Control':'private, no-store','Content-Disposition':(f.kind==='image'?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(f.name)});return fs.createReadStream(f.path).pipe(res);}
  if(route==='/api/upload'&&req.method==='POST')return json(res,200,await saveUpload(await body(req,23*1024*1024)));
  if(req.method==='POST'){
    const p=await body(req);
    if(route==='/api/send')return json(res,200,await sendMessage(p));
    if(route==='/api/stop'){await stopThread(p.id);return json(res,200,{ok:true});}
    if(route==='/api/settings'){await updateSettings(p.id,p);return json(res,200,await getThread(p.id));}
    if(route==='/api/approval'){if(!['accept','decline','cancel'].includes(p.decision)&&!p.answers)throw Error('无效的审批答复');await answerRequest(p.id,p.requestId,p.answers?{answers:p.answers}:{decision:p.decision});return json(res,200,{ok:true});}
  }
  json(res,404,{error:'页面不存在'});
  }catch(e){if(!res.headersSent)json(res,400,{error:safeError(e)});else res.end();}});
function lanAddress(){const values=Object.entries(os.networkInterfaces()).flatMap(([name,rows])=>rows.filter(r=>r.family==='IPv4'&&!r.internal&&/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(r.address)&&!/utun|tailscale|bridge|vbox|vmnet/.test(name)).map(r=>({name,address:r.address})));return(values.find(v=>v.name==='en0')??values[0])?.address;}
const bindAddress=CONFIG.bind_host==='auto'?lanAddress():CONFIG.bind_host;
if(!bindAddress)throw Error('没有可用的局域网地址');
server.on('error',e=>{console.error('Codex Mobile could not listen:',e.code??'error');process.exitCode=1;});
server.listen(CONFIG.port,bindAddress,()=>{console.log('Codex Mobile ready on LAN port '+CONFIG.port);ipc.connect();});
try{const watcher=fs.watch(CODEX,(event,name)=>{if(name==='config.toml'){configurationVersion++;config={};usage.invalidate();if(engine.proc){engine.restartPending=true;if(!hasActiveOwn())engine.restart();}config={};catalog=[];eventNotify();}});watcher.unref();}catch{}
let configTimer;function eventNotify(){clearTimeout(configTimer);configTimer=setTimeout(()=>event('state'),300);}
async function shutdown(){if(shutting)return;shutting=true;for(const s of streams)s.end();for(const t of ipc.following)ipc.follow(t,false);ipc.socket?.destroy();engine.proc?.kill('SIGTERM');server.close();setTimeout(()=>process.exit(0),1000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
