'use strict';
const fs=require('fs'),path=require('path');
function run(root,rounds=128,seed=211){
const e=require(path.join(root,'.agentic/grafo/escenarios.cjs')),g=require(path.join(root,'.agentic/grafo/gate-result.cjs'));
const expected={gate:'preservacion',cycle_id:'lab-cycle',subject_hash:'exact-subject',expected:['test/a.cjs']};
const base={schema_version:1,execution_id:'lab-artifact-000',provenance:'mecanica',gate:'preservacion',cycle_id:'lab-cycle',subject_hash:'exact-subject',policy_id:'preservacion/1',exit_code:0,runner_status:'PASS',expected:['test/a.cjs'],executed:['test/a.cjs'],escenarios:{'test/a.cjs':{status:'PASS',descubrimiento:'runner',tests:1}}};
const mutations=[
['runner-fail',a=>a.runner_status='FAIL'],['exit-error',a=>a.exit_code=7],
['subject-stale',a=>a.subject_hash='otro'],['cycle-stale',a=>a.cycle_id='otro'],
['no-internal-id',a=>delete a.execution_id],
['no-real-execution',a=>{a.executed=[];a.escenarios['test/a.cjs']={status:'PASS'};}],
['runner-unverified',a=>a.runner_status='UNVERIFIED'],
['na-disguises-failure',a=>{a.status='NO_APLICA';a.expected=[];a.executed=[];a.escenarios={};a.exit_code=1;a.runner_status='FAIL';}],
['timeout',a=>a.timeout=true],['missing-evidence',a=>{a.executed=[];a.escenarios={};}]];
const results=[],dir=path.join(root,'.agentic/_executions');fs.mkdirSync(dir,{recursive:true});
function check(name,a,accept){const id='lab-artifact-'+String(results.length).padStart(5,'0');if(Object.hasOwn(a,'execution_id'))a.execution_id=id;fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify(a));const r=e.validarArtefacto(root,id,expected);results.push({name,expected:accept?'ACCEPT':'REJECT',actual:r.ok?'ACCEPT':'REJECT',status:r.ok===accept?'PASS':'FAIL',reason:r.reason_code||null});}
check('positive-control',structuredClone(base),true);
for(const [n,m]of mutations){const a=structuredClone(base);m(a);check(n,a,false);}
let state=seed>>>0;const random=()=>state=(Math.imul(1664525,state)+1013904223)>>>0;
for(let i=0;i<rounds;i++){const a=structuredClone(base),n=random()%mutations.length;mutations[n][1](a);if(random()%2)mutations[random()%mutations.length][1](a);check('seed-'+seed+'-'+i+'-'+mutations[n][0],a,false);}
const forged=g.createGateResult({gate:'security',status:'PASS',subject_hash:'exact-subject',execution_id:'inventado',evidence:[{kind:'inventado',subject_hash:'exact-subject'}]});
const ok=g.allowsVerifiedClose(forged);results.push({name:'fabricated-gate-evidence',expected:'REJECT',actual:ok?'ACCEPT':'REJECT',status:ok?'FAIL':'PASS',reason:'El DTO por sí solo no acredita un artefacto ejecutado; revisar consumidores.'});
return{seed,rounds,results,failures:results.filter(r=>r.status==='FAIL')};}
module.exports={run};
