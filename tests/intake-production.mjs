import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { intakePolicy } from '../functions/api/intake.js';

export async function verifyIntakeProduction(fetcher=fetch, base='https://icedmatchalabs.com') {
  const policyURL=base+'/api/intake/v1/policy';
  const response=await fetcher(policyURL, {headers:{'user-agent':'JottlyIntakeContract/1.0'},signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,200,`${policyURL} HTTP ${response.status}`);
  assert.match(response.headers.get('content-type')??'',/application\/json/);
  assert.deepEqual(await response.json(),intakePolicy,'Production intake policy differs from reviewed source');
  const observed=[];
  // Three bounded, deliberately invalid requests cannot create reports, analytics, or contributions.
  // Do not flood Production to prove exhaustion; concurrency/quotas are verified against real local SQL.
  for(const path of ['/api/dev-reports/v1','/api/analytics/v1/events','/api/analytics/v1/loved-games']) {
    const r=await fetcher(base+path,{method:'POST',headers:{'content-type':'application/json','user-agent':'JottlyIntakeContract/1.0'},
      body:'x'.repeat(129*1024),signal:AbortSignal.timeout(20000)});
    assert.equal(r.status,413,`${path} HTTP ${r.status}`);
    assert.deepEqual(await r.json(),{error:'Payload too large'},`${path} wrong body-limit contract`);
    observed.push({path,status:r.status});
  }
  return {policyURL,policy:intakePolicy,oversizedRequests:observed,limitation:'Production quotas not exhausted; Cloudflare account-level WAF not inspected.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await verifyIntakeProduction(),null,2));
}
