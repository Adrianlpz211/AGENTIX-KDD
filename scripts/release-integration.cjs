'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert/strict');
const {spawn}=require('child_process'),readline=require('readline');
const {herramienta,nodo}=require('../src/run-safe'),{extractTarGz}=require('../src/tar-extract'),{update,rollback}=require('../src/update');
const ROOT=path.resolve(__dirname,'..');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
async function rpc(root){
 const p=spawn(process.execPath,[path.join(root,'.agentic/grafo/mcp-server.cjs')],{cwd:root,env:{...process.env,PROJECT_ROOT:root,NODE_PATH:path.join(ROOT,'node_modules')},windowsHide:true,stdio:['pipe','pipe','pipe']});
 let id=0,err='';p.stderr.on('data',b=>{err=(err+b).slice(-6000);});
 const pending=new Map();readline.createInterface({input:p.stdout}).on('line',line=>{try{const r=JSON.parse(line),a=pending.get(r.id);if(a){pending.delete(r.id);clearTimeout(a.timer);r.error?a.reject(Error(JSON.stringify(r.error))):a.resolve(r.result);}}catch{}});
 const call=(method,params)=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(Error('MCP_TIMEOUT '+method+' '+err));},30000);pending.set(n,{resolve,reject,timer});p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});
 const tool=async(name,args)=>{const r=await call('tools/call',{name,arguments:args});assert.notEqual(r.isError,true,JSON.stringify(r));const c=r.content?.find(c=>c.type==='text');return c?JSON.parse(c.text):r;};
 try{
 const initialized=await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'agentix-release-check',version:'1'}});
 assert.equal(initialized.serverInfo.version,require('../package.json').version);
 const tools=await call('tools/list',{});for(const n of ['recall','remember','effort_decide','teams','restore'])assert.ok(tools.tools.some(t=>t.name===n),'MCP tool '+n);
 const saved=await tool('remember',{entry:'Release 320 sentinel: conservar memoria y verificar el paquete publicado',tipo:'patron',area:'release',confianza:'ALTA'});
 assert.ok(saved.ok,JSON.stringify(saved));
 const recalled=await tool('recall',{query:'Release 320 sentinel',top_k:5,budget_tokens:1000});
 assert.ok(JSON.stringify(recalled).includes('sentinel'),JSON.stringify(recalled));
 return{tools:tools.tools.length,initialize:true,remember:true,recall:true};
 }finally{p.stdin.end();p.kill();for(const a of pending.values())clearTimeout(a.timer);}
}
async function check(tgz,lab,baselineArchive){
 const bundle=path.join(lab,'package');fs.mkdirSync(bundle,{recursive:true});extractTarGz(tgz,bundle);
 assert.equal(require(path.join(bundle,'package.json')).version,'3.20.0');
 const installRoot=path.join(lab,'clean-install');
 herramienta('npm',['install','--prefix',installRoot,tgz,'--omit=dev','--omit=optional','--ignore-scripts','--no-audit','--no-fund'],{encoding:'utf8',timeout:240000});
 const installedBin=path.join(installRoot,'node_modules','agentic-kdd','bin','akdd.js');
 assert.equal(nodo(installedBin,['--version'],{encoding:'utf8'}).trim(),'3.20.0');
 const old=path.join(lab,'baseline');fs.mkdirSync(old);extractTarGz(baselineArchive,old);assert.equal(require(path.join(old,'package.json')).version,'3.19.0');
 const project=path.join(lab,'consumer');fs.mkdirSync(project);fs.cpSync(path.join(old,'.agentic'),path.join(project,'.agentic'),{recursive:true});
 const write=(rel,s)=>{const f=path.join(project,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);return f;};
 write('.agentic/config.md','VERSION: 3.19.0\nCONFIGURADO: SI\nNombre: Consumidor privado\n## Comandos\ntest: node --test\n');
 const privateFiles=['.agentic/memoria/patrones.md','.agentic/PLAN.md','src/business.cjs'];
 privateFiles.forEach((f,i)=>write(f,'USER_PRIVATE_'+i));
 const dbPath=path.join(project,'.agentic/memoria.db'),dba=require('../.agentic/grafo/db-adapter.cjs');
 // Base SQLite real con el esquema del paquete 3.19 publicado.
 dba.initialize(dbPath,fs.readFileSync(path.join(old,'.agentic/grafo/schema.sql'),'utf8'));
 let db=dba.openWrite(dbPath);
 try{for(let i=0;i<50;i++)db.run('INSERT INTO nodos(tipo,titulo,contenido,area,confianza) VALUES(?,?,?,?,?)',['patron','PRIVATE_'+i,'Memoria original '+i,'release','ALTA']);db.exec('CREATE TABLE release_private(id INTEGER PRIMARY KEY,value TEXT);');for(let i=0;i<500;i++)db.run('INSERT INTO release_private VALUES(?,?)',[i,'PRESERVE_'+i]);}finally{db.close();}
 const untouched=[dbPath,...privateFiles.map(f=>path.join(project,f))],before=untouched.map(hash);
 nodo(installedBin,['update'],{cwd:project,encoding:'utf8',timeout:180000}); let r={ok:true};
 assert.equal(JSON.parse(fs.readFileSync(path.join(project,'.agentic/grafo/framework.json'))).version,'3.20.0');
 assert.deepEqual(untouched.map(hash),before,'update debe conservar bytes de DB, memoria y negocio');
 r=await update({projectPath:project,bundleRoot:bundle,salir:false});assert.ok(r.ok);assert.deepEqual(untouched.map(hash),before,'update idempotente');
 const rolled=rollback({projectPath:project});assert.ok(rolled.ok);assert.deepEqual(untouched.map(hash),before,'rollback conserva memoria');
 // Reaplicar después del rollback y comprobar lectura con motor 3.20.
 r=await update({projectPath:project,bundleRoot:bundle,salir:false});assert.ok(r.ok);
 db=dba.openReadOnly(dbPath);try{assert.equal(db.get('PRAGMA integrity_check').integrity_check,'ok');assert.equal(db.get('SELECT count(*) AS n FROM nodos').n,50);assert.equal(db.get('SELECT count(*) AS n FROM release_private').n,500);}finally{db.close();}
 // Migración sólo en esta copia de laboratorio: nunca toca una base de usuario.
 nodo(path.join(project,'.agentic/grafo/grafo.cjs'),['migrate'],{cwd:project,env:{...process.env,NODE_PATH:path.join(ROOT,'node_modules')},encoding:'utf8',timeout:60000});
 db=dba.openReadOnly(dbPath);try{assert.equal(db.get('PRAGMA integrity_check').integrity_check,'ok');assert.equal(db.get('SELECT count(*) AS n FROM nodos').n,50);assert.equal(db.get('SELECT count(*) AS n FROM release_private').n,500);}finally{db.close();}
 const attacks=require('../sandbox/probes.cjs').run(bundle,512,211),native=require('../sandbox/native-probes.cjs').run(bundle);assert.equal(attacks.failures.length,0,JSON.stringify(attacks.failures));assert.equal(native.failures.length,0,JSON.stringify(native.failures));fs.writeFileSync(path.join(lab,'adversarial-results.json'),JSON.stringify({attacks,native},null,2));
 return{adversarial:{cases:attacks.results.length+native.results.length,failures:0,seed:211},clean_npm_install_core:true,published_baseline:'3.19.0',target:'3.20.0',sqlite_integrity:'ok',original_nodes_preserved:50,private_rows_preserved:500,db_bytes_preserved_on_update:true,idempotent:true,rollback:true,migration_preserves_rows:true,mcp:await rpc(project)};
}
module.exports={check,rpc};
