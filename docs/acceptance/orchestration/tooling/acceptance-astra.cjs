'use strict';
const assert = require('node:assert/strict');
const { WebSocket } = require('/root/github_projects/TruckDeck/node_modules/ws');
const port = Number(process.argv[2] || 4000);
const host = `127.0.0.1:${port}`;
const ws = new WebSocket(`ws://${host}/ws`, {origin:`http://${host}`});
const inbox=[];
let received=0;
ws.on('message', raw => { const m=JSON.parse(raw);inbox.push(m); if(m.type==='telemetry')received++; });
function waitFor(pred, timeout=3000) {
 return new Promise((resolve,reject)=>{
  const start=Date.now();
  const timer=setInterval(()=>{const i=inbox.findIndex(pred);if(i>=0){clearInterval(timer);resolve(inbox.splice(i,1)[0]);}else if(Date.now()-start>timeout){clearInterval(timer);reject(Error('Timed out waiting for WS response'));}},10);
 });
}
async function send(m){ws.send(JSON.stringify(m));}
(async()=>{
 const health=await (await fetch(`http://${host}/health`)).json();assert.deepEqual(health,{ok:true,mock:true});
 await new Promise((resolve,reject)=>{if(ws.readyState===1)return resolve();ws.once('open',resolve);ws.once('error',reject);});
 await send({type:'hello',role:'web',version:'1'});
 const hello=await waitFor(m=>m.type==='hello');assert.equal(hello.ok,true);assert.equal(hello.mock,true);
 await waitFor(m=>m.type==='telemetry');
 received=0;const t0=Date.now();await new Promise(r=>setTimeout(r,1200));const hz=received/((Date.now()-t0)/1000);assert.ok(hz>=5);
 const cases=[];
 for(const name of ['parking','beamLow','beamHigh','blinkerLeft','blinkerRight','hazard']){
  for(const value of [true,false])cases.push({action:`lights.${name}`,value,pred:d=>d.lights[name]===value});
 }
 for(const value of ['auto','1','2','3','off'])cases.push({action:'wipers.set',value,pred:d=>d.wipers===value});
 for(const [action,field] of [['handbrake.toggle','handbrake'],['diffLock.toggle','diffLock'],['liftAxle.toggle','liftAxle'],['cruise.toggle','cruise'],['engine.toggle','engineOn']]){
  cases.push({action,field});
 }
 let n=0;
 for(const c of cases){
  inbox.length=0;
  const baseline=(await waitFor(m=>m.type==='telemetry')).data;
  inbox.length=0;
  const id=`accept-${++n}`;
  const command={type:'command',action:c.action,id};if('value'in c)command.value=c.value;
  await send(command);
  const ack=await waitFor(m=>m.id===id);assert.equal(ack.type,'command_ack',JSON.stringify(ack));
  const pred=c.pred|| (d=>d[c.field]===!baseline[c.field]);
  await waitFor(m=>m.type==='telemetry'&&pred(m.data));
 }
 ws.close();
 console.log(JSON.stringify({ok:true,port,health,telemetryHz:Number(hz.toFixed(2)),commandsVerified:n,actions:12},null,2));
})().catch(e=>{console.error(e);ws.terminate();process.exitCode=1;});
