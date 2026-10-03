import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker.js';

for (const path of ['/api/dev-reports/v1', '/api/analytics/v1/events', '/api/analytics/v1/loved-games']) {
  test(`${path} cancels an oversized unknown-length stream before reading its failing tail`, async () => {
    let pulls = 0, cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        if (++pulls === 1) controller.enqueue(new Uint8Array(129 * 1024));
        else controller.error(new Error('Must not buffer tail'));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const request = new Request('https://icedmatchalabs.com' + path, {
      method: 'POST', headers: {'content-type':'application/json', 'content-length':'1'}, body, duplex:'half',
    });
    const response = await worker.fetch(request, {});
    assert.equal(response.status, 413);
    assert.equal(cancelled, true);
    assert.equal(pulls, 1);
  });
}

import { readFile } from 'node:fs/promises';
import { SQLiteD1 } from './support/sqlite-d1.mjs';
import { admitIntake, readBoundedJSON, intakePolicy, expireIntake } from '../functions/api/intake.js';
import { onRequestPost as reports } from '../functions/api/dev-reports/v1/reports.js';
import { onRequestPost as analytics } from '../functions/api/analytics/v1/events.js';
import { onRequestPost as contributions } from '../functions/api/analytics/v1/loved-games.js';
import { ensureAnalyticsSchema } from '../functions/api/analytics/v1/schema.js';
import { automaticTitle, automaticDescription, sha256 } from '../functions/api/dev-reports/v1/reliability.js';
const packageFixture = JSON.parse(await readFile(new URL('./fixtures/featured-community-packages-v1.json', import.meta.url)))[0];
const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const now = Math.floor(Date.now()/60000)*60000 + 1000;
const makeRequest = (body, ip='192.0.2.1') => new Request('https://icedmatchalabs.com/api/dev-reports/v1', {
  method:'POST', headers:{'content-type':'application/json','cf-connecting-ip':ip}, body:JSON.stringify(body),
});
async function bodyFor(route,n) {
  if (route === 'analytics') return { schemaVersion:1, entries:[{entry_id:uuid(n),day:new Date().toISOString().slice(0,10),
    category:'product',event:'mode_selected',app_version:'3.4.2',release_channel:'testflight',mode:'classic',game_source:'solo',count:1}] };
  if (route === 'contributions') return {schemaVersion:2,submissionID:uuid(n),package:structuredClone(packageFixture)};
  const body = {schemaVersion:1,id:uuid(n),kind:'bug',title:'A support report',description:'A useful description',diagnostics:'',appVersion:'3.4.2',buildNumber:'41'};
  if (route === 'automatic') {
    const m = {version:1,incidentID:uuid(n+100000),fingerprint:'',operation:'share.prepare',signal:'stalled',event:'initial',outcome:'pending',phase:'resolving',reason:'none',elapsedMilliseconds:15000,thresholdMilliseconds:15000,occurrences:1,network:'online',commit:'a'.repeat(40),channel:'testflight',environment:'production',os:'26.5',device:'iPhone',context:[],truncated:false};
    m.fingerprint=await sha256(['1','3.4.2','41',m.commit,m.channel,m.environment,m.operation,m.signal,m.reason].join('|'));
    body.automatic=m;body.title=automaticTitle(m);body.description=automaticDescription(m);
  }
  return body;
}
const handlers = {manual:reports,automatic:reports,analytics,contributions};
for (const [route, limit] of [['manual',30],['automatic',60],['analytics',120],['contributions',20]]) {
  test(`${route}: per-source quota, other source, duplicate at quota, minute recovery and private ledger`, async t => {
    const db=new SQLiteD1();t.after(()=>db.close());
    const env={ANALYTICS_REPORT_TOKEN:'private-server-key',ANALYTICS_DB:db,COMMUNITY_DB:db};
    const send=async(n,ip='192.0.2.1',at=now)=>handlers[route]({request:makeRequest(await bodyFor(route,n),ip),env,nowMilliseconds:at});
    for(let n=1;n<=limit;n++) assert.equal((await send(n)).status,route==='manual'||route==='automatic'?201:200,`${route} admission ${n}`);
    const rejected=await send(limit+1);assert.equal(rejected.status,429);assert.equal(rejected.headers.get('retry-after'),'60');
    assert.equal((await send(1)).status,200,'durable replay stays acknowledged at quota');
    assert.equal((await send(limit+2,'198.51.100.2')).status,route==='manual'||route==='automatic'?201:200);
    const ledger=db.sqlite.prepare('SELECT * FROM intake_admissions').all();
    assert.equal(ledger.length,limit+1);assert.doesNotMatch(JSON.stringify(ledger),/192\.0\.2|198\.51|private-server-key|support report/);
    for(const row of ledger){assert.match(row.subject,/^[a-f0-9]{64}$/);assert.match(row.receipt,/^[a-f0-9]{64}$/);}
    assert.equal((await send(limit+1,'192.0.2.1',now+60000)).status,route==='manual'||route==='automatic'?201:200);
    await expireIntake(db,now+120000);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM intake_admissions WHERE bucket = ?').get(Math.floor(now/60000)).n,0);
  });
}

test('atomic admission cannot overshoot under concurrent clients; replay, window and route isolation survive',async t=>{
  const db=new SQLiteD1();t.after(()=>db.close());const env={ANALYTICS_REPORT_TOKEN:'server-key'};
  const take=(i,route='manual',at=now)=>admitIntake({request:makeRequest({},`source-${i}`),env,db,route,receipt:`receipt-${i}`,now:at});
  // Establish schema before testing the production conditional insertion under contention.
  await expireIntake(db,now);
  const results=await Promise.all(Array.from({length:340},(_,i)=>take(i)));
  assert.equal(results.filter(x=>x===null).length,300);
  assert.equal(results.filter(x=>x?.status===429).length,40);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM intake_admissions WHERE route='manual'").get().n,300);
  assert.equal(await take(0),null);
  assert.equal(await take(0,'contributions'),null);
  assert.equal(await take(400,'manual',now+60000),null);
});

test('same-source concurrent requests consume exactly its quota; duplicate requests do not double-charge',async t=>{
  const db=new SQLiteD1();t.after(()=>db.close());const env={ANALYTICS_REPORT_TOKEN:'server-key'};
  const take=i=>admitIntake({request:makeRequest({}),env,db,route:'manual',receipt:`r${i}`,now});
  await expireIntake(db,now);
  const results=await Promise.all(Array.from({length:45},(_,i)=>take(i)));
  assert.equal(results.filter(x=>x===null).length,30);
  assert.equal(results.filter(x=>x?.status===429).length,15);
  assert.ok((await Promise.all(Array.from({length:8},()=>take(0)))).every(x=>x===null));
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM intake_admissions').get().n,30);
});

test('storage failure, absent key and interrupted insertion fail explicitly and recover without false acceptance',async t=>{
  const actual=new SQLiteD1();t.after(()=>actual.close());let fail=true;
  const db={prepare(sql){if(fail&&sql.includes('intake_admissions'))return {run:async()=>{throw Error('private storage detail');}};return actual.prepare(sql);}};
  const input={request:makeRequest({}),env:{ANALYTICS_REPORT_TOKEN:'key'},db,route:'manual',receipt:'r',now};
  assert.equal((await admitIntake(input)).status,503);
  fail=false;assert.equal(await admitIntake(input),null);
  assert.equal((await admitIntake({...input,env:{}})).status,503);
  assert.equal((await admitIntake({...input,now:NaN})).status,503);
  assert.equal((await admitIntake({...input,units:0})).status,503);
  assert.equal(await admitIntake(input),null);
});

test('contribution daily limit is atomic across source clients and duplicates work at the limit',async t=>{
  const db=new SQLiteD1();t.after(()=>db.close());await ensureAnalyticsSchema(db);
  const seed=db.sqlite.prepare('INSERT INTO loved_game_candidates(submission_id,definition_digest,contract_json) VALUES (?, ?, ?)');
  for(let i=0;i<999;i++)seed.run(`seed-${i}`,'seed','{}');
  const env={ANALYTICS_REPORT_TOKEN:'key',ANALYTICS_DB:db};
  const send=async i=>contributions({request:makeRequest(await bodyFor('contributions',i),`client-${i}`),env,nowMilliseconds:now});
  const replies=await Promise.all([send(5000),send(5001),send(5002)]);
  assert.equal(replies.filter(x=>x.status===200).length,1);assert.equal(replies.filter(x=>x.status===429).length,2);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM loved_game_candidates').get().n,1000);
  const winner=replies.findIndex(x=>x.status===200)+5000;
  assert.equal((await send(winner)).status,200);
  db.sqlite.prepare("UPDATE loved_game_candidates SET received_at='2020-01-01'").run();
  assert.equal((await send(6000)).status,200);
});

test('stream byte bounds cover split Unicode, exact length, missing length, bad UTF8, interrupted body and content type',async()=>{
  const request=(bytes,headers={})=>new Request('https://example.test',{method:'POST',headers:{'content-type':'application/json',...headers},body:bytes});
  const raw=new TextEncoder().encode(JSON.stringify({text:'é'}));
  assert.deepEqual(await readBoundedJSON(request(raw),raw.length),{text:'é'});
  assert.equal((await readBoundedJSON(request(raw),raw.length-1)).status,413);
  assert.equal((await readBoundedJSON(request(new Uint8Array([0xff])),10)).status,400);
  assert.equal((await readBoundedJSON(request('{}',{'content-length':'-1'}),10)).status,400);
  assert.equal((await readBoundedJSON(request('{}',{'content-type':'text/plain'}),10)).status,415);
  const stream=new ReadableStream({start(c){c.enqueue(raw.slice(0,10));c.enqueue(raw.slice(10));c.close();}});
  assert.deepEqual(await readBoundedJSON(new Request('https://example.test',{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'}),raw.length),{text:'é'});
  const interrupted=new ReadableStream({start(c){c.error(Error('private peer failure'));}});
  assert.equal((await readBoundedJSON(new Request('https://example.test',{method:'POST',headers:{'content-type':'application/json'},body:interrupted,duplex:'half'}),100)).status,400);
});

test('Worker exposes the actual admission policy as a versioned public contract with no credentials',async()=>{
  const response=await worker.fetch(new Request('https://icedmatchalabs.com/api/intake/v1/policy'),{});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),intakePolicy);
  assert.equal((await worker.fetch(new Request('https://icedmatchalabs.com/api/intake/v1/policy',{method:'POST'}),{})).status,405);
});

import { verifyIntakeProduction } from './intake-production.mjs';
test('Production verification rejects stale policy, wrong statuses and wrong body behavior before claiming delivery',async()=>{
  const good=async(url,options)=>new Response(JSON.stringify(options?.method==='POST'?{error:'Payload too large'}:intakePolicy),{status:options?.method==='POST'?413:200,headers:{'content-type':'application/json'}});
  assert.equal((await verifyIntakeProduction(good)).oversizedRequests.length,3);
  for(const status of [301,403,404,500,503])await assert.rejects(()=>verifyIntakeProduction(async()=>({status,json(){throw Error('must not parse');},headers:new Headers()})),/HTTP/);
  await assert.rejects(()=>verifyIntakeProduction(async()=>new Response(JSON.stringify({...intakePolicy,version:0}),{headers:{'content-type':'application/json'}})),/differs/);
  await assert.rejects(()=>verifyIntakeProduction(async(url,options)=>options?.method==='POST'?new Response('{}',{status:200}):good(url,options)),/HTTP 200/);
  await assert.rejects(()=>verifyIntakeProduction(async(url,options)=>options?.method==='POST'?new Response('{}',{status:413}):good(url,options)),/wrong body-limit/);
});

test('tiny and empty chunks cannot amplify buffered memory or lose Unicode at the byte boundary',async()=>{
  const bytes=new TextEncoder().encode('{"value":"é"}');let index=0,empty=true;
  const stream=new ReadableStream({pull(c){
    if(empty){empty=false;c.enqueue(new Uint8Array());return;}
    if(index===bytes.length){c.close();return;}
    c.enqueue(bytes.subarray(index,index+1));index++;empty=true;
  }},{highWaterMark:0});
  const request=new Request('https://example.test',{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'});
  assert.deepEqual(await readBoundedJSON(request,bytes.length),{value:'é'});
});

test('missing trusted edge identity remains limited and forwarding headers do not change the source bucket',async t=>{
  const db=new SQLiteD1();t.after(()=>db.close());const env={ANALYTICS_REPORT_TOKEN:'key'};
  for(let i=0;i<31;i++){
    const request=new Request('https://example.test',{headers:{'x-forwarded-for':`spoofed-${i}`}});
    const result=await admitIntake({request,env,db,route:'manual',receipt:`missing-${i}`,now});
    assert.equal(result?.status??200,i<30?200:429);
  }
});

for(const [route,table] of [['manual','dev_reports'],['automatic','automatic_report_receipts'],['analytics','anonymous_analytics_events_v6'],['contributions','loved_game_candidates']]) {
  test(`${route}: failure after admission stays unacknowledged and the identical retry recovers`,async t=>{
    const db=new SQLiteD1();t.after(()=>db.close());const env={ANALYTICS_REPORT_TOKEN:'key',ANALYTICS_DB:db,COMMUNITY_DB:db};
    const send=async n=>handlers[route]({request:makeRequest(await bodyFor(route,n)),env,nowMilliseconds:now});
    assert.equal((await send(1)).status,route==='manual'||route==='automatic'?201:200);
    db.sqlite.exec(`CREATE TRIGGER fail_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected private details'); END;`);
    const failure=await send(2);assert.equal(failure.status,503);assert.doesNotMatch(await failure.text(),/injected private/);
    assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,1);
    db.sqlite.exec('DROP TRIGGER fail_write');
    assert.equal((await send(2)).status,route==='manual'||route==='automatic'?201:200);
    assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,2);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM intake_admissions').get().n,2,'retry does not charge twice');
  });
}

test('malformed analytics write acknowledgement cannot become successful upload',async t=>{
  const db=new SQLiteD1();t.after(()=>db.close());await ensureAnalyticsSchema(db);const batch=db.batch.bind(db);
  db.batch=async()=>[];
  const env={ANALYTICS_REPORT_TOKEN:'key',ANALYTICS_DB:db};
  assert.equal((await analytics({request:makeRequest(await bodyFor('analytics',1)),env,nowMilliseconds:now})).status,503);
  db.batch=batch;
  assert.equal((await analytics({request:makeRequest(await bodyFor('analytics',1)),env,nowMilliseconds:now})).status,200);
});
