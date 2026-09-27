import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from '../worker.js';
import { automaticTitle, automaticDescription, sha256, expireAutomaticDiagnostics } from '../functions/api/dev-reports/v1/reliability.js';
const endpoint='https://icedmatchalabs.com/api/dev-reports/v1';
const id=()=>crypto.randomUUID();
const environment=()=>{
 const sqlite=new DatabaseSync(':memory:');
 class Prepared {
  constructor(sql,args=[]){this.sql=sql;this.args=args;}
  bind(...args){return new Prepared(this.sql,args);}
  async run(){const before=sqlite.prepare("SELECT total_changes() AS n").get().n;sqlite.prepare(this.sql).run(...this.args);return {meta:{changes:sqlite.prepare("SELECT total_changes() AS n").get().n-before}};}
  first(){return sqlite.prepare(this.sql).get(...this.args)??null;}
  all(){return {results:sqlite.prepare(this.sql).all(...this.args)};}
 }
 return {sqlite,ANALYTICS_REPORT_TOKEN:'test',COMMUNITY_DB:{prepare:sql=>new Prepared(sql)}};
};
const req=(method,body,path=endpoint)=>new Request(path,{method,headers:{'content-type':'application/json','authorization':'Bearer test'},body:body===undefined?undefined:JSON.stringify(body)});
async function payload(changes={}){
 const automatic={version:1,incidentID:id(),fingerprint:'',operation:'share.prepare',signal:'stalled',event:'initial',outcome:'pending',phase:'resolving',reason:'none',elapsedMilliseconds:15000,thresholdMilliseconds:15000,occurrences:1,network:'online',commit:'a'.repeat(40),channel:'testflight',environment:'production',os:'26.5',device:'iPhone',context:[],truncated:false,...changes};
 automatic.fingerprint=await sha256(['1','3.4.2','41',automatic.commit,automatic.channel,automatic.environment,automatic.operation,automatic.signal,automatic.reason].join('|'));
 return {schemaVersion:1,id:id(),kind:'bug',title:automaticTitle(automatic),description:automaticDescription(automatic),diagnostics:'',appVersion:'3.4.2',buildNumber:'41',automatic};
}
async function post(env,p){return worker.fetch(req('POST',p),env);}
async function detail(env,group){const r=await worker.fetch(req('GET',undefined,`${endpoint}/${group}`),env);assert.equal(r.status,200);return r.json();}

test('unfinished action and recovery create one grouped issue and immutable receipt',async()=>{
 const env=environment(), initial=await payload();
 const result=await post(env,initial);assert.equal(result.status,201);const receipt=await result.json();
 assert.equal(receipt.id,initial.id);
 const retries=await Promise.all(Array.from({length:10},()=>post(env,initial)));assert.deepEqual(retries.map(x=>x.status),Array(10).fill(200));
 const terminal=await payload({incidentID:initial.automatic.incidentID,event:'terminal',outcome:'succeeded',occurrences:0,elapsedMilliseconds:20000});
 assert.equal((await post(env,terminal)).status,201);
 const report=await detail(env,receipt.groupID);
 assert.equal(report.automatic.occurrenceCount,1);assert.equal(report.automatic.lastOutcome,'succeeded');
 assert.equal((await post(env,{...initial,description:'changed'})).status,400);
 const different=await payload({elapsedMilliseconds:16000});different.id=initial.id;
 assert.equal((await post(env,different)).status,409);
 assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM dev_reports').get().n,1);
});

test('terminal before initial and repeated incident identities do not double count',async()=>{
 const env=environment(), incidentID=id();
 const terminal=await payload({incidentID,event:'terminal',outcome:'failed',occurrences:0});
 const receipt=await(await post(env,terminal)).json();
 assert.equal((await detail(env,receipt.groupID)).automatic.occurrenceCount,0);
 const first=await payload({incidentID});await post(env,first);await post(env,{...first,id:id()});
 const report=await detail(env,receipt.groupID);
 assert.equal(report.automatic.occurrenceCount,1);assert.equal(report.automatic.lastOutcome,'failed');
 const summary=await payload({event:'aggregate',occurrences:100});await post(env,summary);await post(env,summary);
 assert.equal((await detail(env,receipt.groupID)).automatic.occurrenceCount,101);
});

test('private data unknown fields malformed numbers and forged grouping never enter storage',async()=>{
 const env=environment();
 const mutations=[p=>p.diagnostics='secret',p=>p.title='secret',p=>p.automatic.gameID='secret',p=>p.automatic.reason='secret',
  p=>p.automatic.device='My private phone',p=>p.automatic.occurrences=0,p=>p.automatic.elapsedMilliseconds=-1,
  p=>p.automatic.fingerprint='0'.repeat(64),p=>p.automatic.context=[{event:'gameLaunch.started',millisecondsAgo:0,fields:{gameID:'secret'}}],
  p=>p.automatic.context=[{event:'gameLaunch.started',millisecondsAgo:0,fields:{phase:'secret'}}],
  p=>p.automatic.context=Array(51).fill({event:'network.changed',millisecondsAgo:0,fields:{online:'true'}})];
 for(const mutate of mutations){const p=await payload();mutate(p);assert.equal((await post(env,p)).status,400);}
 for(const p of [null,[],{},1])assert.equal((await post(env,p)).status,400);
 assert.equal(env.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='dev_reports'").get().n,0);
});

test('new occurrences reopen resolved groups but old retries and terminal updates do not restore logs',async()=>{
 const env=environment(),first=await payload();const group=(await(await post(env,first)).json()).groupID;
 env.sqlite.prepare("UPDATE dev_reports SET status='fixed',diagnostics='',resolution='fixed' WHERE id=?").run(group);
 await post(env,first);assert.equal((await detail(env,group)).status,'fixed');
 await post(env,await payload({incidentID:first.automatic.incidentID,event:'terminal',occurrences:0,outcome:'succeeded'}));
 assert.equal(env.sqlite.prepare('SELECT diagnostics FROM dev_reports WHERE id=?').get(group).diagnostics,'');
 await post(env,await payload());const reopened=await detail(env,group);assert.equal(reopened.status,'new');assert.equal(reopened.automatic.occurrenceCount,2);
});

test('retention erases excerpts and incident metadata while preserving retry identity',async()=>{
 const env=environment(),p=await payload();const group=(await(await post(env,p)).json()).groupID;
 await expireAutomaticDiagnostics(env.COMMUNITY_DB,Date.now()+31*86400000);
 assert.equal(env.sqlite.prepare('SELECT diagnostics FROM dev_reports WHERE id=?').get(group).diagnostics,'');
 const row=env.sqlite.prepare('SELECT * FROM automatic_report_receipts').get();assert.equal(row.metadata,null);assert.equal(row.incident_id,null);
 assert.equal((await post(env,p)).status,200);
 assert.equal(env.sqlite.prepare('SELECT diagnostics FROM dev_reports WHERE id=?').get(group).diagnostics,'');
});

test('global admission cap is atomic and allows existing receipt retry',async()=>{
 const env=environment(),p=await payload();await post(env,p);
 for(let i=1;i<300;i++)assert.equal((await post(env,await payload())).status,201);
 const limited=await post(env,await payload());assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');
 assert.equal((await post(env,p)).status,200);
 assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM automatic_report_receipts').get().n,300);
});

test('manual reports and other builds stay independent and deletion erases synthetic incident detail',async()=>{
 const env=environment(),p=await payload();const first=(await(await post(env,p)).json()).groupID;
 const next=await payload({commit:'b'.repeat(40)});const second=(await(await post(env,next)).json()).groupID;
 assert.notEqual(first,second);
 const manual={schemaVersion:1,id:id(),kind:'bug',title:'Manual report',description:'A player request',diagnostics:'Chosen by the player',appVersion:'1',buildNumber:'1'};
 assert.equal((await post(env,manual)).status,201);
 const list=await(await worker.fetch(req('GET',undefined,`${endpoint}?status=all`),env)).json();
 assert.equal(list.reports[0].id,manual.id);assert.equal(list.reports.length,3);
 assert.equal((await worker.fetch(req('DELETE',undefined,`${endpoint}/${first}`),env)).status,204);
 const erased=env.sqlite.prepare('SELECT metadata,incident_id FROM automatic_report_receipts WHERE group_id=?').get(first);
 assert.equal(erased.metadata,null);assert.equal(erased.incident_id,null);
 assert.equal((await post(env,p)).status,200);
 assert.equal((await worker.fetch(req('GET',undefined,`${endpoint}/${first}`),env)).status,404);
});

test('failure during grouped insert rolls back both the receipt and ticket mutation',async()=>{
 const env=environment(),p=await payload();await worker.fetch(req('GET',undefined,`${endpoint}/health`),env);
 env.sqlite.exec("CREATE TRIGGER reject_reliability BEFORE UPDATE ON dev_reports WHEN NEW.automatic_summary IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
 assert.equal((await post(env,p)).status,503);
 assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM automatic_report_receipts').get().n,0);
 assert.equal(env.sqlite.prepare('SELECT count(*) AS n FROM dev_reports').get().n,0);
 env.sqlite.exec('DROP TRIGGER reject_reliability');assert.equal((await post(env,p)).status,201);
});

test('automatic migration matches executable schema including cleanup triggers',async()=>{
 const {readFile}=await import('node:fs/promises');
 const sql=await import('../functions/api/dev-reports/v1/reliability.js');
 const expected='ALTER TABLE dev_reports ADD COLUMN automatic_summary TEXT;\n'+[
  sql.reliabilityTableSQL,sql.reliabilityIndexSQL,sql.reliabilityIncidentIndexSQL,sql.reliabilityTriggerSQL,
  sql.reliabilityDeleteTriggerSQL,sql.reliabilityFixedTriggerSQL].join('\n')+'\n';
 assert.equal(await readFile(new URL('../migrations/0009_automatic_reliability.sql',import.meta.url),'utf8'),expected);
});

// A full historical/manual inbox must not make every automatic incident invisible.
test('bounded inbox gives both manual and automatic groups room under a fault storm',async()=>{
 const env=environment();
 for(let i=0;i<55;i++)await post(env,{schemaVersion:1,id:id(),kind:'bug',title:'Manual report',description:'A player report',diagnostics:'',appVersion:'1',buildNumber:'1'});
 for(let i=0;i<55;i++)await post(env,await payload({commit:i.toString(16).padStart(40,'0')}));
 const response=await worker.fetch(req('GET',undefined,endpoint+'?status=all'),env);assert.equal(response.status,200);
 const {reports}=await response.json();assert.equal(reports.length,50);
 assert.equal(reports.filter(x=>x.automatic).length,25);assert.equal(reports.filter(x=>!x.automatic).length,25);
});
