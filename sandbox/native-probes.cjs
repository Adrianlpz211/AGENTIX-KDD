'use strict';
const fs=require('fs'),path=require('path'),os=require('os');
function run(engine){
const G=path.join(engine,'.agentic/grafo'),tm=require(path.join(G,'teams-manager.cjs')),db=require(path.join(G,'db-adapter.cjs')),g=require(path.join(G,'gate-result.cjs'));
const results=[];
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'akdd-native-attack-'));fs.mkdirSync(path.join(root,'.agentic'));fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'.agentic/config.md'),'CONFIGURADO: SI\n');fs.writeFileSync(path.join(root,'src/a.js'),'module.exports=1;');db.openWrite(path.join(root,'.agentic/memoria.db')).close();tm.init(root,{aprobarMigracion:true});tm.crearPlan(root,{id:'P',objective:'adversarial',sprints:[{id:'S',tasks:[{id:'A',objective:'fix pure backend utility',acceptance:['returns 2'],allowed_files:['src/a.js'],risk:'LOW',change_type:'text',depends_on:[]}]}]});const assignment=tm.asignar(root,{owner_id:'sandbox-builder'}).assignment;return{root,assignment};}
function result(f,extras={}){return tm.entregarResultado(f.root,{event_id:'attack-event',owner_id:'sandbox-builder',task_id:'A',delivery_id:f.assignment.delivery_id,fencing:f.assignment.fencing,subject_hash:'claimed-subject',files:['src/a.js'],...extras});}
function record(name,actual,ok){results.push({name,expected:'REJECT_INVALID_ACTION',status:ok?'PASS':'FAIL',actual});}
let f=fixture();let r=result(f);record('native-result-without-ack',r.status,r.status!=='VERIFICANDO');
f=fixture();tm.ack(f.root,{delivery_id:f.assignment.delivery_id,owner_id:'sandbox-builder'});r=result(f,{fencing:f.assignment.fencing+1});record('native-wrong-fencing',r.status,r.status!=='VERIFICANDO');
f=fixture();tm.ack(f.root,{delivery_id:f.assignment.delivery_id,owner_id:'sandbox-builder'});r=result(f);if(r.status!=='VERIFICANDO')throw Error('ATTACK_PRECONDITION:'+r.status);let t=tm.leerTarea(f.root,'A');
let gates=tm.gatesRequeridos(t).map(name=>g.createGateResult({gate:name,status:'PASS',subject_hash:'different',execution_id:'invented',evidence:[{kind:'invented',subject_hash:'different'}]}));r=tm.verificar(f.root,{task_id:'A',gates});record('native-wrong-gate-subject',r.status,r.status!=='DONE_VERIFIED');
f=fixture();tm.ack(f.root,{delivery_id:f.assignment.delivery_id,owner_id:'sandbox-builder'});r=result(f);if(r.status!=='VERIFICANDO')throw Error('ATTACK_PRECONDITION:'+r.status);t=tm.leerTarea(f.root,'A');
gates=tm.gatesRequeridos(t).map(name=>g.createGateResult({gate:name,status:'PASS',subject_hash:t.subject_hash,execution_id:'invented-no-file-'+name,evidence:[{kind:'invented-no-runner',subject_hash:t.subject_hash}]}));r=tm.verificar(f.root,{task_id:'A',gates});
record('native-fabricated-gates-close-unmodified-code',r.status,r.status!=='DONE_VERIFIED');
return{results,failures:results.filter(r=>r.status==='FAIL')};
}
module.exports={run};
