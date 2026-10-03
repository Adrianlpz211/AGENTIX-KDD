#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),crypto=require('crypto');
const {spawnSync}=require('child_process'),{herramienta}=require('../src/run-safe');
const ROOT=path.resolve(__dirname,'..'),pkg=require('../package.json'),out=path.join(ROOT,'_output','release-'+pkg.version);
const report={version:pkg.version,status:'RUNNING',started_at:new Date().toISOString(),runtime:process.version,platform:process.platform,checks:[],limits:['No certifica una sesión real de Cursor/Claude ni autonomía de un modelo.','WhatsApp requiere sesión y contacto autorizados. No se envían mensajes.','El piloto no certifica todos los sistemas consumidores.']};
const digest=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const memory=path.join(ROOT,'.agentic/memoria.db'),memoryBefore=fs.existsSync(memory)?digest(memory):null;
const lab=fs.mkdtempSync(path.join(os.tmpdir(),'agentix-release-'));
function run(script){const r=spawnSync(process.execPath,[path.join(ROOT,script)],{cwd:ROOT,encoding:'utf8',timeout:1200000,maxBuffer:128*1024*1024,windowsHide:true});fs.writeFileSync(path.join(out,path.basename(script)+'.log'),(r.stdout||'')+(r.stderr||''));if(r.status!==0)throw Error(script+' FAILED: revisar log en '+out);return r.stdout||'';}
async function main(){
fs.mkdirSync(out,{recursive:true});report.lab=lab;
try {
assert.equal(require('../package-lock.json').version,pkg.version);assert.equal(require('../.agentic/grafo/framework.json').version,pkg.version);
console.log('1/4 Suite completa');const suite=run('scripts/run-tests.cjs');const passes=[...suite.matchAll(/ℹ pass (\d+)/g)],totals=[...suite.matchAll(/ℹ tests (\d+)/g)];assert.ok(passes.length&&totals.length);const total=Number(totals.at(-1)[1]),pass=Number(passes.at(-1)[1]);assert.equal(pass,total,'No se permiten tests omitidos');report.checks.push({name:'full-suite',status:'PASS',total,pass});
console.log('2/4 Paquete npm y privacidad');const packed=JSON.parse(herramienta('npm',['pack','--ignore-scripts','--json','--pack-destination',out],{cwd:ROOT,encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024}))[0];
assert.equal(packed.version,pkg.version);assert.ok(packed.files.length>100);
const bad=packed.files.filter(f=>/\.(?:db|db-wal|db-shm)$|(^|\/)_(?:cache|executions|teams|update|hooks|tarea)|^\.agentic\/(?:memoria|telemetria|checkpoint|config|specs)|^sandbox\/|^test\/|\.env(?:\.|$)|\.log$/.test(f.path));assert.deepEqual(bad,[],'Datos privados en paquete');
for(const file of ['bin/akdd.js','.agentic/grafo/framework.json','.agentic/grafo/mcp-server.cjs','.agentic/grafo/vendor/d3.min.js'])assert.ok(packed.files.some(f=>f.path===file),'Falta '+file);
const tgz=path.join(out,packed.filename);report.package={file:packed.filename,sha256:digest(tgz),integrity:packed.integrity,files:packed.files.length};
console.log('3/4 Piloto npm 3.19 a 3.20, SQLite y MCP');let baseline=process.env.AGENTIX_BASELINE_TGZ;if(!baseline){const b=JSON.parse(herramienta('npm',['pack','agentic-kdd@3.19.0','--ignore-scripts','--json','--pack-destination',lab],{cwd:lab,encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024}))[0];baseline=path.join(lab,b.filename);}
report.integration=await require('./release-integration.cjs').check(tgz,lab,baseline);report.checks.push({name:'published-upgrade-and-mcp',status:'PASS'});
console.log('4/4 Conservación local');assert.equal(fs.existsSync(memory)?digest(memory):null,memoryBefore,'La base original cambió');report.checks.push({name:'original-memory-unchanged',status:'PASS'});
report.status='PASS';console.log('PASS '+pkg.version+' '+pass+'/'+total+' memoria conservada');
}catch(e){report.status='FAIL';report.error=e.message;console.error(e.stack);process.exitCode=1;}
finally{report.finished_at=new Date().toISOString();fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify(report,null,2));console.log('Reporte: '+path.join(out,'verification.json'));}
} main();