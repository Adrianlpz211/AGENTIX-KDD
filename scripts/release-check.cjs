#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),crypto=require('crypto');
const {spawnSync}=require('child_process'),{herramienta}=require('../src/run-safe');
const ROOT=path.resolve(__dirname,'..'),pkg=require('../package.json'),out=path.join(ROOT,'_output','release-'+pkg.version);
const report={version:pkg.version,status:'RUNNING',started_at:new Date().toISOString(),runtime:process.version,platform:process.platform,checks:[],limits:['No certifica una sesión real de Cursor/Claude ni autonomía de un modelo.','WhatsApp requiere sesión y contacto autorizados. No se envían mensajes.','El piloto certifica consumidores construidos con los motores publicados 3.19.0 y 3.20.0, no todos los sistemas consumidores.','Verificado en la plataforma y el Node del reporte (runtime/platform); no se infiere de otras.']};
const digest=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const memory=path.join(ROOT,'.agentic/memoria.db'),memoryBefore=fs.existsSync(memory)?digest(memory):null;
const lab=fs.mkdtempSync(path.join(os.tmpdir(),'agentix-release-'));
function run(script){const r=spawnSync(process.execPath,[path.join(ROOT,script)],{cwd:ROOT,encoding:'utf8',timeout:1200000,maxBuffer:128*1024*1024,windowsHide:true});fs.writeFileSync(path.join(out,path.basename(script)+'.log'),(r.stdout||'')+(r.stderr||''));if(r.status!==0)throw Error(script+' FAILED: revisar log en '+out);return r.stdout||'';}
async function main(){
fs.mkdirSync(out,{recursive:true});report.lab=lab;
try {
assert.equal(require('../package-lock.json').version,pkg.version);assert.equal(require('../.agentic/grafo/framework.json').version,pkg.version);
console.log('1/4 Suite completa');const suite=run('scripts/run-tests.cjs');const passes=[...suite.matchAll(/ℹ pass (\d+)/g)],totals=[...suite.matchAll(/ℹ tests (\d+)/g)];assert.ok(passes.length&&totals.length);const total=Number(totals.at(-1)[1]),pass=Number(passes.at(-1)[1]);const omitidas=suite.split(/\r?\n/).filter(l=>l.startsWith('﹣ '));const noEjecutadas=omitidas.filter(l=>/# HOST_REAL_NO_EJECUTADO:/.test(l)).map(l=>l.replace(/ \(\d[\d.]*ms\).*$/,'').replace(/^﹣ /,''));assert.equal(omitidas.length,noEjecutadas.length,'No se permiten tests omitidos salvo los declarados HOST_REAL_NO_EJECUTADO: '+omitidas.join(' | '));assert.equal(pass+noEjecutadas.length,total,'Hay tests omitidos sin declarar');report.checks.push({name:'full-suite',status:'PASS',total,pass,host_real_not_executed:noEjecutadas});
console.log('2/4 Paquete npm y privacidad');const packed=JSON.parse(herramienta('npm',['pack','--ignore-scripts','--json','--pack-destination',out],{cwd:ROOT,encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024}))[0];
assert.equal(packed.version,pkg.version);assert.ok(packed.files.length>100);
const bad=packed.files.filter(f=>/\.(?:db|db-wal|db-shm)$|(^|\/)_(?:cache|executions|teams|update|hooks|tarea|evidence|context|effort)|^\.agentic\/(?:memoria|telemetria|checkpoint|config|specs)|^sandbox\/|^test\/|\.env(?:\.|$)|\.log$/.test(f.path));assert.deepEqual(bad,[],'Datos privados en paquete');
for(const file of ['bin/akdd.js','.agentic/grafo/framework.json','.agentic/grafo/mcp-server.cjs','.agentic/grafo/vendor/d3.min.js','.agentic/grafo/memory-core.cjs','.agentic/grafo/memory-privacy.cjs','.agentic/grafo/memory-queue.cjs','.agentic/grafo/memory-layers.cjs','.agentic/grafo/memory-cli.cjs','.agentic/grafo/evidence-store.cjs','.agentic/grafo/context-compressor.cjs','.agentic/grafo/context-usage.cjs','.agentic/grafo/context-reuse.cjs','.agentic/grafo/context-metrics.cjs','.agentic/grafo/effort-budget.cjs','.agentic/grafo/teams-packets.cjs','.agentic/grafo/memoria-salud.cjs','.agentic/grafo/memoria-panel.cjs','.agentic/grafo/contexto-panel.cjs','.agentic/grafo/memoria-pagina.cjs','.agentic/grafo/mcp-memory-tools.cjs','.agentic/grafo/mcp-contexto-tools.cjs','.agentic/grafo/benchmark-contexto.cjs'])assert.ok(packed.files.some(f=>f.path===file),'Falta '+file);
const tgz=path.join(out,packed.filename);report.package={file:packed.filename,sha256:digest(tgz),integrity:packed.integrity,files:packed.files.length};
console.log('3/4 Piloto: el tarball actualiza consumidores REALES 3.19.0 y 3.20.0 (check, update, idempotencia, MCP, rollback)');
report.integration=await require('./release-integration.cjs').check(tgz,lab);report.checks.push({name:'published-upgrade-and-mcp',status:'PASS'});
console.log('4/4 Conservación local');assert.equal(fs.existsSync(memory)?digest(memory):null,memoryBefore,'La base original cambió');report.checks.push({name:'original-memory-unchanged',status:'PASS'});
report.status='PASS';console.log('PASS '+pkg.version+' '+pass+'/'+total+' memoria conservada');
}catch(e){report.status='FAIL';report.error=e.message;console.error(e.stack);process.exitCode=1;}
finally{report.finished_at=new Date().toISOString();fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify(report,null,2));console.log('Reporte: '+path.join(out,'verification.json'));}
} main();