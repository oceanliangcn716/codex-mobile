// 验证发布副本启动与配对隔离；不连接真实 Codex 目录，不调用模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('isolated startup serves the page and rejects unpaired access', {timeout:15000}, async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-mobile-release-'));
 const socket=net.createServer();
 await new Promise(r=>socket.listen(0,'127.0.0.1',r));
 const port=socket.address().port;
 await new Promise(r=>socket.close(r));
 for(const file of ['server.mjs','mobile-core.mjs','usage-core.mjs','web'])fs.cpSync(path.join(root,file),path.join(dir,file),{recursive:true});
 fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({type:'module'}));
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({bind_host:'127.0.0.1',port}));
 const child=spawn(process.execPath,[path.join(dir,'server.mjs')],{env:{HOME:dir,CODEX_HOME:path.join(dir,'.codex'),PATH:process.env.PATH},stdio:'ignore'});
 t.after(async()=>{
  if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}
  fs.rmSync(dir,{recursive:true,force:true});
 });
 const base=`http://127.0.0.1:${port}`;
 let ready=false;
 for(let i=0;i<70;i++){try{ready=(await fetch(base+'/')).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(ready,true);
 assert.equal((await fetch(base+'/api/threads')).status,401);
 const secret=fs.readFileSync(path.join(dir,'private/pair.secret'),'utf8').trim();
 const pair=await fetch(base+'/api/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:secret})});
 assert.equal(pair.status,200);
 assert.match(pair.headers.get('set-cookie'),/HttpOnly/);
 assert.match(pair.headers.get('set-cookie'),/SameSite=Strict/);
});
