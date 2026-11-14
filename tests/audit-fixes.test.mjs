import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, repo, notify, ddns, environment, request, setup, credentials, load } from './helpers.mjs';
const aliyun = await load('aliyun');
const workerModule = await load('index');
const account = { access_key_id: 'fake', access_key_secret: 'fake', region_id: 'cn-hangzhou', instance_id: 'i-test' };
function reply(code = '200', id = 'i-test', message = 'OK') {
  return Response.json({ RequestId: 'local', InstanceResponses: { InstanceResponse: [{ InstanceId: id, Code: code, Message: message }] } });
}
function mockFetch(t, fn) { const original = globalThis.fetch; globalThis.fetch = fn; t.after(() => { globalThis.fetch = original; }); }

test('normal stop maps internal Stop to KeepCharging', async t => {
  let mode; mockFetch(t, async url => { mode = new URL(url).searchParams.get('StoppedMode'); return reply(); });
  assert.equal(await aliyun.stopInstance({}, account, 'Stop'), 'Stop');
  assert.equal(mode, 'KeepCharging');
});
test('per-instance startup failure rejects and preserves stock failure diagnosis', async t => {
  mockFetch(t, async () => reply('InsufficientInventory', 'i-test', 'No stock'));
  await assert.rejects(aliyun.startInstance({}, account), /库存不足/);
});
test('per-instance stop failure is not reported as successful', async t => {
  mockFetch(t, async () => reply('OperationDenied', 'i-test', 'Denied'));
  await assert.rejects(aliyun.stopInstance({}, account), /Denied/);
});
test('missing, wrong-instance and ambiguous batch results fail closed', async t => {
  for (const body of [{}, { InstanceResponses: { InstanceResponse: [{ InstanceId: 'other', Code: '200' }] } },
    { InstanceResponses: { InstanceResponse: [{ InstanceId: 'i-test' }] } },
    { InstanceResponses: { InstanceResponse: [{ InstanceId: 'i-test', Code: '200' }, { InstanceId: 'i-test', Code: '200' }] } }]) {
    mockFetch(t, async () => Response.json(body));
    await assert.rejects(aliyun.startInstance({}, account));
  }
});
test('unsupported economy stop fallback uses KeepCharging and checks its result', async t => {
  const modes=[];
  mockFetch(t, async url => { modes.push(new URL(url).searchParams.get('StoppedMode')); return modes.length===1 ? reply('InvalidParameter.StoppedMode','i-test','Unsupported stopped mode') : reply(); });
  assert.equal(await aliyun.stopInstance({}, account, 'StopCharging', true), 'Stop');
  assert.deepEqual(modes,['StopCharging','KeepCharging']);
});
test('permission errors do not trigger a chargeable fallback', async t => {
  let calls=0;mockFetch(t,async()=>{calls++;return reply('Forbidden','i-test','Denied')});
  await assert.rejects(aliyun.stopInstance({},account,'StopCharging',true));assert.equal(calls,1);
});
test('dry-run webhook cannot perform external I/O but live mode still sends', async t => {
  let calls=0;mockFetch(t,async()=>{calls++;return new Response('ok')});
  const config={notify_wh_enabled:'1',notify_wh_url:'https://example.invalid/hook'};
  const message={kind:'test',title:'test',titleHtml:'test',body:'test'};
  await notify.sendAll({CDT_DRY_RUN:'1'},config,message);assert.equal(calls,0);
  await notify.sendAll({},config,message);assert.equal(calls,1);
});
test('DDNS discovers multi-label suffix and delegated subdomain zones', async t => {
  for(const zone of ['example.co.uk','sub.example.co.uk']) {
    const queries=[];let recordZone;
    mockFetch(t,async url=>{const u=new URL(url);if(u.pathname.endsWith('/zones')){const name=u.searchParams.get('name');queries.push(name);return Response.json({success:true,result:name===zone?[{id:'found-zone',name:zone}]:[]})}
      recordZone=u.pathname;return Response.json({success:true,result:[{id:'r',content:'8.8.8.8'}]});});
    const r=await ddns.syncFull({},{ddns_enabled:'1',ddns_cf_token:'fake'},{record:'node.sub.example.co.uk',ip:'8.8.8.8',verify:true});
    assert.equal(r.status,ddns.STATUS_UNCHANGED);assert.match(recordZone,/\/zones\/found-zone\/dns_records/);
    assert.equal(queries.at(-1),zone);assert.ok(!queries.includes('co.uk'));
  }
});
test('DDNS zone permission failure stops discovery immediately', async t=>{
  let calls=0;mockFetch(t,async()=>{calls++;return Response.json({success:false},{status:403})});
  const r=await ddns.syncFull({},{ddns_enabled:'1',ddns_cf_token:'fake'},{record:'node.example.co.uk',ip:'8.8.8.8'});
  assert.equal(r.status,ddns.STATUS_ERROR);assert.equal(calls,1);assert.match(r.detail,/403/);
});
test('login rate limit survives a new API module and expires after the window', async t=>{
  const env=environment(t);await setup(env);
  const headers={'cf-connecting-ip':'192.0.2.31'};
  for(let n=0;n<8;n++)assert.equal((await request(env,'/api/v1/auth/login',{username:'owner',password:'wrong'},headers)).status,401);
  const {pathToFileURL}=await import('node:url');const {runtime,path}=await import('./helpers.mjs');
  const fresh=await import(pathToFileURL(path.join(runtime,'api.mjs')).href+'?new-isolate');
  const response=await fresh.app.request('https://local.invalid/api/v1/auth/login',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({username:'owner',password:'owner-password-123'})},env);
  assert.equal(response.status,429);
  const now=Date.now;Date.now=()=>now()+301000;t.after(()=>Date.now=now);
  assert.equal((await request(env,'/api/v1/auth/login',{username:'owner',password:'owner-password-123'},headers)).status,200);
});
test('concurrent login attempts cannot race through the global limit', async t=>{
  const env=environment(t);await setup(env);
  const responses=await Promise.all(Array.from({length:12},()=>request(env,'/api/v1/auth/login',{username:'owner',password:'wrong'},{'cf-connecting-ip':'192.0.2.32'})));
  assert.equal(responses.filter(r=>r.status===401).length,8);assert.equal(responses.filter(r=>r.status===429).length,4);
});
test('revocation and epoch lookup failures refuse protected access', async t=>{
  const env=environment(t);const auth=credentials(await setup(env));const prepare=env.DB.prepare.bind(env.DB);
  for(const match of ['revoked_sessions','session_epoch']){
    env.DB.prepare=sql=>{const p=prepare(sql);return {bind(...args){if(sql.includes(match)||args.includes(match))throw new Error('Simulated D1 failure');return p.bind(...args)}}};
    assert.equal((await request(env,'/api/v1/auth/me',undefined,auth)).status,503);
  }
  env.DB.prepare=prepare;
});
test('Worker refuses unsafe direct API execution without coordinator binding', async()=>{
  const response=await workerModule.default.fetch(new Request('https://local.invalid/api/health'),{},{});
  assert.equal(response.status,503);
});
test('API and cron enter the same named coordinator; internal cron URL is not public', async()=>{
  const ids=[],paths=[],promises=[];
  const env = {
    CONTROL_PLANE: {
      idFromName(name) { ids.push(name); return name; },
      get() {
        return { async fetch(input) {
          paths.push(new URL(typeof input === 'string' ? input : input.url).pathname);
          return Response.json({ ok: true });
        } };
      },
    },
  };
  assert.equal((await workerModule.default.fetch(new Request('https://local.invalid/api/v1/reconcile',{method:'POST'}),env,{})).status,200);
  await workerModule.default.scheduled({},env,{waitUntil(p){promises.push(p)}});await Promise.all(promises);
  assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);assert.deepEqual(paths,['/api/v1/reconcile','/__scheduled']);
  await workerModule.default.fetch(new Request('https://local.invalid/__scheduled',{method:'POST'}),env,{});
  assert.equal(paths.length,2);
});
test('rate-limit storage failure refuses login without issuing a session', async t=>{
  const env=environment(t);await setup(env);const prepare=env.DB.prepare.bind(env.DB);
  env.DB.prepare=sql=>{if(sql.includes('auth_rate_limits'))throw new Error('Storage down');return prepare(sql)};
  const response=await request(env,'/api/v1/auth/login',{username:'owner',password:'owner-password-123'});
  assert.equal(response.status,503);assert.equal(response.headers.get('set-cookie'),null);
});
test('cron and manual switch serialize and never stop both members', async t=>{
  assert.equal(typeof workerModule.ControlPlane,'function');
  const env=environment(t);const auth=credentials(await setup(env));
  await repo.setSettings(env,{daily_report_enabled:'0',billing_enabled:'0',notify_on_shift:'0',notify_on_error:'0'});
  const ids=[];for(const label of ['A','B'])ids.push(await repo.upsertServer(env,{label,region_id:'cn-hangzhou',access_key_id:'fake-'+label,access_key_secret:'fake',instance_id:'i-'+label}));
  const gid=await repo.upsertGroup(env,{name:'race',members:ids.map(server_id=>({server_id,hours:12}))});
  const plane=new workerModule.ControlPlane({waitUntil(){}},env);const instances={'i-A':'Running','i-B':'Running'};const operations=[];
  let reached,release;const blocked=new Promise(r=>reached=r);const released=new Promise(r=>release=r);let first=true;
  t.after(()=>release());
  mockFetch(t,async input=>{
    const p=new URL(input).searchParams, action=p.get('Action');
    if(action==='ListCdtInternetTraffic')return Response.json({TrafficDetails:[{Traffic:0}]});
    if(action==='DescribeInstances'){const id=JSON.parse(p.get('InstanceIds'))[0];return Response.json({Instances:{Instance:[{Status:instances[id],StoppedMode:instances[id]==='Stopped'?'KeepCharging':'',RegionId:'cn-hangzhou',PublicIpAddress:{IpAddress:['8.8.8.8']}}]}})}
    const id=p.get('InstanceId.1');
    if(action==='StopInstances'){if(first&&id==='i-B'){first=false;reached();await released;}instances[id]='Stopped';operations.push('stop:'+id);assert.ok(Object.values(instances).includes('Running'),'both instances stopped');return reply('200',id)}
    if(action==='StartInstances'){instances[id]='Running';operations.push('start:'+id);return reply('200',id)}
    throw new Error('Unexpected action '+action);
  });
  const cron=plane.fetch(new Request('https://control.internal/__scheduled',{method:'POST'}));
  await Promise.race([blocked,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('No cron stop request')),4000);timer.unref()})]);
  const manual=plane.fetch(new Request('https://local.invalid/api/v1/groups/'+gid+'/switch',{method:'POST',headers:auth}));
  await new Promise(r=>setImmediate(r));assert.deepEqual(operations,[]);
  release();assert.equal((await cron).status,200);assert.equal((await manual).status,200);
  assert.deepEqual(operations,['stop:i-B','start:i-B']);
  assert.equal((await plane.fetch(new Request('https://control.internal/__scheduled',{method:'POST'}))).status,200);
  assert.equal(instances['i-B'],'Running');assert.equal(instances['i-A'],'Stopped');
});
