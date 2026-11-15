import assert from 'node:assert/strict';
import { test } from 'node:test';
import {app,repo,notify,ddns,environment,request,setup,credentials,load,fs,path,root,runtime,ts} from './helpers.mjs';
import { pathToFileURL } from 'node:url';
const shift=await load('shift');const aliyun=await load('aliyun');const dns=await load('dns');const {ControlPlane}=await load('control-plane');
const payload=label=>({label,region_id:'cn-hangzhou',access_key_id:'fake-'+label,access_key_secret:'fake-secret',instance_id:'i-'+label});
const account={access_key_id:'fake',access_key_secret:'fake',region_id:'cn-hangzhou',instance_id:'i-test',site:'china'};
async function pairFixture(t, initial={A:'Running',B:'Stopped'}){
 const env=environment(t);await repo.setSettings(env,{notify_on_shift:'0',notify_on_error:'0',notify_on_failover:'0',daily_report_enabled:'0',billing_enabled:'0'});
 const ids={A:await repo.upsertServer(env,payload('A')),B:await repo.upsertServer(env,payload('B'))};
 const gid=await repo.upsertGroup(env,{name:'test',members:[{server_id:ids.A,hours:12},{server_id:ids.B,hours:12}]});
 const state={...initial};const traffic={A:0,B:0};const ops=[];const controls={badRead:'',startError:''};
 globalThis.fetch=async input=>{
  const p=new URL(input).searchParams;const action=p.get('Action');const label=(p.get('AccessKeyId')||'').slice(-1);
  if(action==='ListCdtInternetTraffic')return Response.json({TrafficDetails:[{Traffic:traffic[label]*1024**3}]});
  if(action==='DescribeInstances'){
   if(controls.badRead===label)throw new Error('network timeout');
   return Response.json({Instances:{Instance:[{Status:state[label],StoppedMode:state[label]==='Stopped'?'KeepCharging':'',RegionId:'cn-hangzhou',EipAddress:{IpAddress:'8.8.8.8'}}]}});
  }
  if(action==='StartInstances'||action==='StopInstances'){
   const code=action==='StartInstances'&&label==='A'&&controls.startError?controls.startError:'200';
   ops.push({action,label,code});if(code==='200')state[label]=action==='StartInstances'?'Running':'Stopped';
   return Response.json({InstanceResponses:{InstanceResponse:[{InstanceId:'i-'+label,Code:code,Message:code==='200'?'OK':code}]}});
  }
  throw new Error('Unexpected action '+action);
 };
 const round=async()=>shift.reconcileGroup(env,await repo.getGroup(env,gid),await repo.getSettings(env),Math.floor(Date.now()/1000));
 const run=async()=> (await repo.recentRuns(env,20)).find(r=>r.group_id===gid);
 return {env,ids,gid,state,traffic,ops,controls,round,run};
}

test('slow anonymous login does not occupy the mutation queue or skip cron',async t=>{
 const env=environment(t);const auth=credentials(await setup(env));await repo.setSettings(env,{daily_report_enabled:'0',billing_enabled:'0'});const plane=new ControlPlane({},env);
 let controller;const body=new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode('{"username":"nobody","password":"wrong"'))}});
 const slow=plane.fetch(new Request('https://local.invalid/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body,duplex:'half'}));
 let done=false;const saved=plane.fetch(new Request('https://local.invalid/api/v1/settings',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:'{}'})).then(r=>{done=true;return r});
 await new Promise(r=>setTimeout(r,100));const completedWhileBodyOpen=done;
 controller.enqueue(new TextEncoder().encode('}'));controller.close();await slow;assert.equal((await saved).status,200);
 assert.equal(completedWhileBodyOpen,true);
 assert.equal((await plane.fetch(new Request('https://control.internal/__scheduled',{method:'POST'}))).status,200);
});
test('two password changes in one second revoke the previous session',async t=>{
 const realNow=Date.now;Date.now=()=>1794690000000;t.after(()=>Date.now=realNow);
 const env=environment(t);const initial=credentials(await setup(env));
 const first=await request(env,'/api/v1/settings',{new_password:'first-password-123'},initial);assert.equal(first.status,200);
 const old=credentials(first);const second=await request(env,'/api/v1/settings',{new_password:'second-password-456'},old);assert.equal(second.status,200);
 const stillValid=await request(env,'/api/v1/auth/me',undefined,old);assert.equal(stillValid.status,401);
 return {oldSessionAfterSecondChange:stillValid.status,epoch:await repo.getSetting(env,'session_epoch')};
});
test('billing sums all pages',async t=>{
 const calls=[];globalThis.fetch=async input=>{const p=new URL(input).searchParams;calls.push(p.get('NextToken'));return Response.json({Code:'Success',Data:{Items:[{PretaxAmount:p.get('NextToken')?'20':'10'}],NextToken:p.get('NextToken')?'':'page2'}})};
 const bill=await aliyun.getInstanceBill({},account,'2026-11');assert.equal(bill.total,30);assert.equal(calls.length,2);
 return {expectedTotal:30,actualTotal:bill.total,requests:calls.length};
});
test('overnight keepalive can be saved and excludes noon',async t=>{
 const env=environment(t);const auth=credentials(await setup(env));const sid=await repo.upsertServer(env,payload('A'));
 const response=await request(env,'/api/v1/keepalives',{server_id:sid,start_time:'20:00',end_time:'06:00'},auth);
 assert.equal(response.status,200);
 const noon=shift.keepaliveWindow({start_time:'20:00',end_time:'06:00'},new Date('2026-11-15T04:00:00Z'),'Asia/Shanghai');assert.equal(noon,false);
 return {saveStatus:response.status,apiMessage:(await response.json()).message,helperAllowsNoonIfSuchRowExists:noon};
});
test('settled shift read blip does not create another completion',async t=>{
 const f=await pairFixture(t);for(let i=0;i<3;i++)await f.round();assert.equal((await f.run()).phase,'settled');
 const before=(await repo.listEvents(f.env,100,'','')).filter(e=>e.kind==='shift_done').length;
 f.controls.badRead='B';await f.round();const during=(await f.run()).phase;
 f.controls.badRead='';for(let i=0;i<3;i++)await f.round();
 const after=(await repo.listEvents(f.env,100,'','')).filter(e=>e.kind==='shift_done').length;
 assert.equal(after,before);assert.equal(f.ops.length,0);
 return {before,after,phaseDuringReadFailure:during,cloudPowerOperations:f.ops.length};
});
test('throttled starts do not cause failover',async t=>{
 const f=await pairFixture(t, {A:'Stopped',B:'Stopped'});f.controls.startError='Throttling';
 for(let i=0;i<4;i++)await f.round();
 const run=await f.run();assert.equal(run.failover,0);assert.equal(run.duty_server_id,f.ids.A);
 return {failover:run.failover,reason:run.failover_reason,operations:f.ops};
});
test('DDNS config changes invalidate successful cached records, no-op saves do not',async t=>{
 const env=environment(t);const auth=credentials(await setup(env));
 await repo.setSettings(env,{ddns_ttl:'60',ddns_proxied:'0'});
 env.DB.db.exec("INSERT INTO dns_records(record,last_ip,last_status,last_at) VALUES('node.example.com','8.8.8.8','✅ 已同步',123)");
 assert.equal((await request(env,'/api/v1/settings',{ddns:{ttl:60,proxied:false}},auth)).status,200);
 assert.equal(env.DB.db.prepare('SELECT last_at FROM dns_records').get().last_at,123);
 assert.equal((await request(env,'/api/v1/settings',{ddns:{ttl:300,proxied:true}},auth)).status,200);
 const row=env.DB.db.prepare('SELECT * FROM dns_records').get();assert.equal(row.last_status,'');assert.equal(row.last_at,0);
});
test('Positive control: handover starts successor before stopping current member',async t=>{
 const f=await pairFixture(t, {A:'Stopped',B:'Running'});await f.round();assert.equal(f.state.B,'Running');
 await f.round();await f.round();assert.equal(f.state.A,'Running');assert.equal(f.state.B,'Stopped');assert.equal((await f.run()).phase,'settled');
 assert.deepEqual(f.ops.map(o=>o.action+':'+o.label),['StartInstances:A','StopInstances:B']);return {operations:f.ops,phase:(await f.run()).phase};
});
test('keepalive finishes its event and sends recovery exactly once',async t=>{
 const f=await pairFixture(t, {A:'Stopped',B:'Stopped'});await repo.deleteGroup(f.env,f.gid);await repo.addKeepalive(f.env,f.ids.A,true);
 await repo.setSettings(f.env,{notify_on_keepalive:'1',notify_wh_enabled:'1',notify_wh_url:'https://notify.example.invalid/hook'});
 const cloud=globalThis.fetch;let notifications=0;globalThis.fetch=async(input,options)=>{if(String(input).startsWith('https://notify.example.invalid/')){notifications++;return new Response('ok')}return cloud(input,options)};
 for(let i=0;i<4;i++)await shift.reconcileAll(f.env);
 const pending=await repo.pendingEvent(f.env,f.ids.A,'keepalive');
 assert.equal(f.state.A,'Running');assert.equal(pending,null);assert.equal(notifications,1);
 return {instanceStatus:f.state.A,eventStatus:pending?.status,pendingKind:pending?.pending_kind,recoveryNotifications:notifications,rounds:4};
});
test('Positive control: all members over traffic threshold are stopped',async t=>{
 const f=await pairFixture(t, {A:'Running',B:'Running'});f.traffic.A=210;f.traffic.B=210;await f.round();
 assert.equal(f.state.A,'Stopped');assert.equal(f.state.B,'Stopped');return {states:f.state,operations:f.ops};
});
test('Positive control: normal daily keepalive and month scheduling boundary',async t=>{
 const timed={start_time:'08:00',end_time:'20:00',start_day:1,end_day:31};
 assert.equal(shift.keepaliveWindow(timed,new Date('2026-11-15T04:00:00Z'),'Asia/Shanghai'),true);
 assert.equal(shift.keepaliveWindow(timed,new Date('2026-11-15T14:00:00Z'),'Asia/Shanghai'),false);
 const group={id:1,cycle:'month',enabled:1,members:[{server_id:1,enabled:1,days:16,hours:0},{server_id:2,enabled:1,days:15,hours:0}]};
 const early=shift.dutyAt(group,Date.parse('2026-11-16T15:59:00Z')/1000,'Asia/Shanghai');
 const late=shift.dutyAt(group,Date.parse('2026-11-16T16:00:00Z')/1000,'Asia/Shanghai');
 assert.equal(early[0].server_id,1);assert.equal(late[0].server_id,2);return {normalTimeWindow:true,monthDay17Switch:true};
});
test('Positive control: every protected route requires login and write routes require CSRF',async t=>{
 const env=environment(t);const auth=credentials(await setup(env));const publicPaths=new Set(['/api/health','/api/v1/system/init-status','/api/v1/setup','/api/v1/auth/login']);
 const routes=app.routes.filter(r=>!publicPaths.has(r.path));let writes=0;
 for(const route of routes){
  const url='https://local.invalid'+route.path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g,'1');
  const init={method:route.method,headers:{'Content-Type':'application/json'},...(route.method==='GET'?{}:{body:'{}'})};
  assert.equal((await app.request(url,init,env)).status,401,route.method+' '+route.path);
  if(route.method!=='GET'){writes++;assert.equal((await app.request(url,{...init,headers:{...init.headers,Cookie:auth.Cookie}},env)).status,403,route.path)}
 }
 return {protectedRoutes:routes.length,csrfProtectedWrites:writes};
});

test('runtime refresh writes one row and samples retain status transitions',async t=>{
 const env=environment(t);const id=await repo.upsertServer(env,payload('A'));
 const before=env.DB.db.prepare('SELECT total_changes() n').get().n;
 await repo.updateServerRuntime(env,id,{traffic:2,status:'Running',publicIp:'8.8.8.8',regionId:'cn-hangzhou'});
 assert.equal(env.DB.db.prepare('SELECT total_changes() n').get().n-before,1);
 await repo.addSample(env,id,2,'Running');await repo.addSample(env,id,2,'Running');await repo.addSample(env,id,2,'Stopped');
 assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM traffic_samples').get().n,2);
});
test('new and existing settings use the economy schedule',async t=>{
 const env=environment(t);const config=await repo.getSettings(env);
 assert.equal(config.reconcile_interval,'300');assert.equal(config.billing_interval,'21600');
});
test('unsupported schedule and Telegram proxy values are refused rather than silently ignored',async t=>{
 const env=environment(t);const auth=credentials(await setup(env));
 assert.equal((await request(env,'/api/v1/settings',{reconcile_interval:60},auth)).status,400);
 assert.equal((await request(env,'/api/v1/settings',{telegram:{proxy:'http://127.0.0.1:7890'}},auth)).status,400);
});
test('oversize bodies are rejected before entering the queue',async t=>{
 const env=environment(t);const plane=new ControlPlane({},env);
 assert.equal((await plane.fetch(new Request('https://local.invalid/api/v1/auth/login',{method:'POST',body:'x'.repeat(65537)}))).status,413);
});

test('scheduled round reads the settings table once',async t=>{
 const env=environment(t);await repo.setSettings(env,{daily_report_enabled:'0',billing_enabled:'0'});
 const prepare=env.DB.prepare.bind(env.DB);let reads=0;
 env.DB.prepare=sql=>{if(sql==='SELECT key, value FROM settings')reads++;return prepare(sql)};
 await (await load('scheduler')).runReconcile(env);assert.equal(reads,1);
});
test('keepalive confirmation reuses this round state and refreshes next round',async t=>{
 const f=await pairFixture(t,{A:'Stopped',B:'Stopped'});await repo.deleteGroup(f.env,f.gid);await repo.addKeepalive(f.env,f.ids.A,true);
 const cloud=globalThis.fetch;let reads=0;
 globalThis.fetch=async(input,opts)=>{if(new URL(input).searchParams.get('Action')==='DescribeInstances')reads++;return cloud(input,opts)};
 await shift.reconcileAll(f.env);assert.equal(reads,2);
 await shift.reconcileAll(f.env);assert.equal(reads,4);
 assert.equal(await repo.pendingEvent(f.env,f.ids.A,'keepalive'),null);
});
test('cleanup keeps running events but trims completed events and samples',async t=>{
 const env=environment(t);const sid=await repo.upsertServer(env,payload('A'));
 const running=await repo.addEvent(env,'start','waiting',{status:'running'});
 const done=await repo.addEvent(env,'system','old');
 env.DB.db.prepare('UPDATE events SET ts=?').run(Math.floor(Date.now()/1000)-8*86400);
 env.DB.db.prepare('INSERT INTO traffic_samples(server_id,ts,used,status) VALUES(?,?,1,?)').run(sid,Math.floor(Date.now()/1000)-4*86400,'Running');
 await repo.pruneEvents(env,7);
 assert.ok(await repo.getEvent(env,running));assert.equal(await repo.getEvent(env,done),null);
 assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM traffic_samples').get().n,0);
});
test('visible polling runs every minute, pauses hidden, resumes immediately, and never overlaps',async t=>{
 const filename=path.join(root,'web/src/polling.ts');let startPolling;
 if(fs.existsSync(filename)){
  const file=path.join(runtime,'web-polling.mjs');fs.writeFileSync(file,ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);
  ({startPolling}=await import(pathToFileURL(file)));
 }
 assert.equal(typeof startPolling,'function');
 t.mock.timers.enable({apis:['setInterval']});
 const doc=new EventTarget();doc.visibilityState='visible';let calls=0;let release;
 const stop=startPolling(doc,()=>{calls++;return new Promise(r=>release=r)});t.after(stop);
 t.mock.timers.tick(59999);assert.equal(calls,0);t.mock.timers.tick(1);assert.equal(calls,1);
 t.mock.timers.tick(120000);assert.equal(calls,1);release();await new Promise(r=>setImmediate(r));
 doc.visibilityState='hidden';doc.dispatchEvent(new Event('visibilitychange'));t.mock.timers.tick(300000);assert.equal(calls,1);
 doc.visibilityState='visible';doc.dispatchEvent(new Event('visibilitychange'));assert.equal(calls,2);release();await new Promise(r=>setImmediate(r));
 stop();t.mock.timers.tick(120000);assert.equal(calls,2);
});
test('DNS verification compares proxy and TTL as well as IP',async()=>{
 const calls=[];globalThis.fetch=async(input,opts)=>{calls.push(opts?.method||'GET');return Response.json(opts?.method==='PUT'?{success:true}:{success:true,result:[{id:'r1',content:'8.8.8.8',ttl:60,proxied:false}]})};
 const result=await ddns.syncFull({},{ddns_enabled:'1',ddns_cf_token:'fake',ddns_zone_id:'z1',ddns_proxied:'1',ddns_ttl:'300'},{record:'node.example.com',ip:'8.8.8.8',verify:true});
 assert.equal(result.changed,true);assert.deepEqual(calls,['GET','PUT']);
});

test('DNS config save and cache invalidation roll back together on storage failure',async t=>{
 const env=environment(t);const auth=credentials(await setup(env));await repo.setSettings(env,{ddns_ttl:'60'});
 const prepare=env.DB.prepare.bind(env.DB);
 env.DB.prepare=sql=>{if(sql.startsWith('UPDATE dns_records SET last_status'))throw new Error('invalidation unavailable');return prepare(sql)};
 const response=await request(env,'/api/v1/settings',{ddns:{ttl:300}},auth);
 assert.equal(response.status,500);assert.equal(await repo.getSetting(env,'ddns_ttl'),'60');
});
test('late evening daily report is delivered once after midnight without requerying cloud state',async t=>{
 const f=await pairFixture(t);await repo.deleteGroup(f.env,f.gid);
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-15T15:55:00Z')});
 await repo.setSettings(f.env,{initialized:'1',daily_report_enabled:'1',daily_report_time:'23:58',notify_wh_enabled:'1',notify_wh_url:'https://notify.example.invalid/hook'});
 await repo.setFlag(f.env,'daily_report:2026-11-14');
 const cloud=globalThis.fetch;let messages=0,reads=0;
 globalThis.fetch=async(input,opts)=>{if(String(input).startsWith('https://notify.example.invalid/')){messages++;return new Response('ok')};if(new URL(input).searchParams.get('Action')==='DescribeInstances')reads++;return cloud(input,opts)};
 const scheduler=await load('scheduler');await scheduler.runReconcile(f.env);assert.equal(messages,0);assert.equal(reads,2);
 t.mock.timers.setTime(Date.parse('2026-11-15T16:00:00Z'));await scheduler.runReconcile(f.env);assert.equal(messages,1);assert.equal(reads,4);
 assert.ok(await repo.getFlag(f.env,'daily_report:2026-11-15'));
 t.mock.timers.setTime(Date.parse('2026-11-15T16:05:00Z'));await scheduler.runReconcile(f.env);assert.equal(messages,1);
});
test('login body has an absolute deadline',async t=>{
 const env=environment(t);const plane=new ControlPlane({},env);let cancelled=false;
 t.mock.timers.enable({apis:['setTimeout']});
 const response=plane.fetch(new Request('https://local.invalid/api/v1/auth/login',{method:'POST',duplex:'half',body:new ReadableStream({cancel(){cancelled=true}})}));
 t.mock.timers.tick(5001);assert.equal((await response).status,408);assert.equal(cancelled,true);
});
test('billing honors six hour interval and explicit manual refresh',async t=>{
 const env=environment(t);const id=await repo.upsertServer(env,payload('A'));const billing=await load('billing');
 const now=Math.floor(Date.now()/1000);const cycle=billing.currentCycle(await repo.getSettings(env));
 env.DB.db.prepare('UPDATE servers SET billing_updated_at=?,billing_cycle=? WHERE id=?').run(now-5*3600,cycle,id);
 let bills=0;globalThis.fetch=async input=>{if(new URL(input).searchParams.get('Action')==='DescribeInstanceBill'){bills++;return Response.json({Code:'Success',Data:{Items:[{PretaxAmount:'10'}]}})}return Response.json({Code:'Success',Data:{AvailableAmount:'100',Currency:'CNY'}})};
 assert.equal(await billing.refreshDue(env),0);assert.equal(bills,0);
 env.DB.db.prepare('UPDATE servers SET billing_updated_at=? WHERE id=?').run(now-6*3600,id);
 assert.equal(await billing.refreshDue(env),1);assert.equal(bills,1);
 await billing.refreshServer(env,id,{force:true});assert.equal(bills,2);
});
test('settled marker survives completed event pruning',async t=>{
 const f=await pairFixture(t);for(let i=0;i<3;i++)await f.round();
 f.env.DB.db.exec("DELETE FROM events WHERE status='done'");f.controls.badRead='B';await f.round();f.controls.badRead='';await f.round();
 assert.equal((await repo.listEvents(f.env,100,'','')).filter(e=>e.kind==='shift_done').length,0);assert.equal(f.ops.length,0);
});

test('a password change invalidates an in-flight login using the old password',async t=>{
 const env=environment(t);await setup(env);const prepare=env.DB.prepare.bind(env.DB);
 let reached,release,blocked=false;const ready=new Promise(r=>reached=r);const wait=new Promise(r=>release=r);t.after(()=>release());
 env.DB.prepare=sql=>{const p=prepare(sql);return {bind(...args){const stmt=p.bind(...args);const method=sql.startsWith('SELECT key, value FROM settings')?'all':args.includes('admin_password')?'first':null;
  if(!method||blocked)return stmt;return {...stmt,[method]:async()=>{const result=await stmt[method]();blocked=true;reached();await wait;return result}};
 }}};
 const login=request(env,'/api/v1/auth/login',{username:'owner',password:'owner-password-123'});await ready;
 const security=await load('security');await repo.setSettings(env,{admin_password:await security.hashPassword('new-password-456'),session_epoch:'1'});release();
 const result=await login;if(result.status===200)assert.equal((await request(env,'/api/v1/auth/me',undefined,credentials(result))).status,401);else assert.equal(result.status,401);
});

test('overnight and full-day windows honor exact boundaries and calendar dates',()=>{
 const overnight={start_time:'20:00',end_time:'06:00',start_day:15,end_day:16};
 for(const [time,expected] of [['2026-11-15T11:59:00Z',false],['2026-11-15T12:00:00Z',true],['2026-11-15T22:00:00Z',false],['2026-11-16T15:59:00Z',true],['2026-11-16T16:00:00Z',false]]){
  assert.equal(shift.keepaliveWindow(overnight,new Date(time),'Asia/Shanghai'),expected,time);
 }
 for(const time of ['00:00','08:00'])assert.equal(shift.keepaliveWindow({start_time:time,end_time:time},new Date('2026-11-15T04:00:00Z'),'Asia/Shanghai'),true);
});
test('billing refuses a repeated pagination token instead of reporting a partial total',async()=>{
 globalThis.fetch=async()=>Response.json({Code:'Success',Data:{Items:[{PretaxAmount:'10'}],NextToken:'repeat'}});
 await assert.rejects(aliyun.getInstanceBill({},account,'2026-11'),/分页标记重复/);
});
test('manual completion requires a fresh successful read and can finish after a delayed cron',async t=>{
 const f=await pairFixture(t);await repo.deleteGroup(f.env,f.gid);await repo.updateServerRuntime(f.env,f.ids.A,{status:'Running'});
 const event=await repo.addEvent(f.env,'manual','start',{status:'running',serverId:f.ids.A});
 await repo.retargetEvent(f.env,event,'Running','manual');f.controls.badRead='A';await shift.reconcileAll(f.env);
 assert.equal((await repo.getEvent(f.env,event)).status,'running');
 f.env.DB.db.prepare('UPDATE events SET pending_ts=? WHERE id=?').run(Math.floor(Date.now()/1000)-900,event);
 f.controls.badRead='';await shift.reconcileAll(f.env);assert.equal((await repo.getEvent(f.env,event)).status,'done');
});
