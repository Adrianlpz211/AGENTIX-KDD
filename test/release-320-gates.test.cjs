'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const esc=require('../.agentic/grafo/escenarios.cjs'),gate=require('../.agentic/grafo/gate-result.cjs'),evidence=require('../.agentic/grafo/gate-evidence.cjs');
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentix-release-gate-'));fs.writeFileSync(path.join(root,'app.cjs'),'module.exports=4;\n');return root;}
test('3.20: sólo una comprobación positiva con artefacto y sujeto vigente permite cerrar',()=>{const root=fixture();try{const input={gate:'tests',subject_hash:'subject-320',cycle_id:'release-320',status:'PASS'};const dto=gate.createGateResult({...input,evidence:[{subject_hash:input.subject_hash,ref:'inventado'}]});assert.equal(gate.allowsVerifiedClose(dto,{root,paths:['app.cjs']}),false);const real=evidence.comprobar(root,input,{paths:['app.cjs'],checker:'assert-equal',check:()=>{assert.equal(require(path.join(root,'app.cjs')),4);return{status:'PASS',assertions:1};}});assert.equal(gate.allowsVerifiedClose(real,{root,paths:['app.cjs']}),true);fs.writeFileSync(path.join(root,'app.cjs'),'module.exports=5;\n');assert.equal(gate.allowsVerifiedClose(real,{root,paths:['app.cjs']}),false);}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('3.20: un comprobador vacío o que altera el sujeto no certifica PASS',()=>{const root=fixture();try{const input={gate:'tests',subject_hash:'subject-320',cycle_id:'release-320',status:'PASS'};assert.throws(()=>evidence.comprobar(root,input,{paths:['app.cjs'],checker:'empty',check:()=>({status:'PASS',assertions:0})}),/ASSERTIONS/);const r=evidence.comprobar(root,input,{paths:['app.cjs'],checker:'mutating',check:()=>{fs.writeFileSync(path.join(root,'app.cjs'),'changed');return{status:'PASS',assertions:1};}});assert.equal(r.status,'UNVERIFIED');assert.equal(gate.allowsVerifiedClose(r,{root,paths:['app.cjs']}),false);}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('3.20: NO_APLICA no acredita escenarios y ejecución positiva requiere ID interno',()=>{const root=fixture();try{for(const patch of [{execution_id:null},{status:'FAIL'},{status:'ERROR'},{runner_status:'UNVERIFIED'},{status:'NO_APLICA',runner_status:'NO_APLICA'}]){const id='release-case-'+Math.random().toString(36).slice(2);const art={execution_id:id,gate:'tests',subject_hash:'subject-320',provenance:'mecanica',runner_status:'PASS',status:'PASS',exit_code:0,expected:['app.test.cjs'],executed:['app.test.cjs'],escenarios:{'app.test.cjs':{status:'PASS',descubrimiento:'runner'}},...patch};const f=path.join(root,'.agentic','_executions',id+'.json');fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify({schema_version:1,policy_id:esc.POLICY_ID,...art}));assert.equal(esc.validarArtefacto(root,id).ok,false);}}finally{fs.rmSync(root,{recursive:true,force:true});}});

test('3.20: respaldo de migración conserva commits WAL y un error revierte sin perder datos',()=>{
 const root=fixture(),file=path.join(root,'memory.db'),dba=require('../.agentic/grafo/db-adapter.cjs');
 let writer;
 try{writer=dba.openWrite(file);writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE private_memory(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO private_memory VALUES(1,\'WAL_SENTINEL\');');
 const r=dba.migrate(file,{version:1,statements:['ALTER TABLE private_memory ADD COLUMN extra TEXT']});
 const backup=dba.openReadOnly(r.backupPath);try{assert.equal(backup.get('SELECT value FROM private_memory').value,'WAL_SENTINEL');assert.equal(backup.get('PRAGMA integrity_check').integrity_check,'ok');}finally{backup.close();}
 assert.throws(()=>dba.migrate(file,{version:2,statements:["DELETE FROM private_memory","INVALID SQL"]}));
 assert.equal(writer.get('SELECT value FROM private_memory').value,'WAL_SENTINEL');
 assert.equal(dba.userVersion(writer),1);
 }finally{if(writer)writer.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('3.20: configurar MCP conserva JSON roto y otros servidores sin llamar a un host real',async()=>{
 const root=fixture(),safe=require('../src/run-safe'),original=safe.herramienta,mp=require.resolve('../src/mcp-setup'),old=require.cache[mp];
 try{safe.herramienta=()=>{throw Error('HOST_NOT_AVAILABLE_IN_TEST');};delete require.cache[mp];const {mcpSetup}=require('../src/mcp-setup');const server=path.join(root,'.agentic','grafo','mcp-server.cjs');fs.mkdirSync(path.dirname(server),{recursive:true});fs.writeFileSync(server,'// fixture');
 const config=path.join(root,'.cursor','mcp.json');fs.mkdirSync(path.dirname(config));fs.writeFileSync(config,'{ INVALID JSON');await mcpSetup(root);assert.equal(fs.readFileSync(config,'utf8'),'{ INVALID JSON');
 const other={command:'keep',args:['one']};fs.writeFileSync(config,JSON.stringify({mcpServers:{other}}));await mcpSetup(root);const r=JSON.parse(fs.readFileSync(config));assert.deepEqual(r.mcpServers.other,other);assert.equal(r.mcpServers['agentic-kdd'].env.PROJECT_ROOT,path.resolve(root));
 }finally{safe.herramienta=original;delete require.cache[mp];if(old)require.cache[mp]=old;fs.rmSync(root,{recursive:true,force:true});}
});

test('3.20: productor TDD real guarda una evidencia que el cierre de TEAMS acepta e invalida al cambiar código',()=>{
 const root=fixture(),tdd=require('../.agentic/grafo/tdd-gate.cjs');
 try{fs.mkdirSync(path.join(root,'test'));fs.writeFileSync(path.join(root,'test','app.test.cjs'),"const test=require('node:test'),assert=require('node:assert/strict');test('resultado real',()=>assert.equal(require('../app.cjs'),4));");
 const r=tdd.runTests('node --test',root,'test/app.test.cjs',{subject_hash:'subject-320',cycle_id:'release-320'});
 assert.equal(r.status,'PASS',r.output);assert.equal(gate.allowsVerifiedClose(r.gate,{root,paths:['app.cjs']}),true,JSON.stringify(esc.validarArtefacto(root,r.gate.execution_id)));
 fs.writeFileSync(path.join(root,'app.cjs'),'module.exports=5;');
 assert.equal(gate.allowsVerifiedClose(r.gate,{root,paths:['app.cjs']}),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
