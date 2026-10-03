'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),cp=require('child_process');
const source=path.resolve(__dirname,'..');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function json(f,v){fs.mkdirSync(path.dirname(f),{recursive:true});const temp=f+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(v,null,2));fs.renameSync(temp,f);}
function walk(dir,base=dir){let out=[];for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('SYMLINK_SOURCE: '+f);if(e.isDirectory())out=out.concat(walk(f,base));else if(e.isFile())out.push(path.relative(base,f).replace(/\\/g,'/'));}return out;}
function snapshot(dest,{host=false}={}){
fs.mkdirSync(dest,{recursive:true});const files=[];
for(const dir of ['.agentic/grafo','.agentic/agentes','test','src','scripts','bin','templates','assets','.github','.cursor/rules','sandbox'])if((!host||dir!=='sandbox')&&fs.existsSync(path.join(source,dir)))files.push(...walk(path.join(source,dir)).map(f=>dir+'/'+f));
for(const f of fs.readdirSync(source))if(fs.statSync(path.join(source,f)).isFile()&&(/\.(json|cjs|js|md|yml)$/.test(f)||['.gitattributes','.gitignore','.npmignore','.cursorrules','install.sh','install.ps1'].includes(f)))files.push(f);
for(const f of ['.agentic/config.md','.agentic/protected_files','.agentic/nucleo-reglas.md'])if(fs.existsSync(path.join(source,f)))files.push(f);
const manifest={};for(const f of new Set(files)){if(host&&f==='test/sandbox-harness.test.cjs')continue;const b=fs.readFileSync(path.join(source,f));manifest[f]=sha(b);fs.mkdirSync(path.dirname(path.join(dest,f)),{recursive:true});fs.writeFileSync(path.join(dest,f),b);}
fs.mkdirSync(path.join(dest,'.agentic/memoria'),{recursive:true});fs.writeFileSync(path.join(dest,'.agentic/memoria/decisiones.md'),'# Memoria sintética\n\n## Decisión privada de fixture\nNo se debe sembrar en consumidores.\n');json(path.join(dest,'sandbox-source-manifest.json'),manifest);return manifest;
}
function unchanged(manifest){return Object.entries(manifest).filter(([f,h])=>!fs.existsSync(path.join(source,f))||sha(fs.readFileSync(path.join(source,f)))!==h).map(([f])=>f);}
function command(root,args,timeout=240000){
const r=cp.spawnSync(process.execPath,args,{cwd:root,windowsHide:true,encoding:'utf8',timeout,maxBuffer:64*1024*1024,env:{...process.env,NODE_PATH:path.join(source,'node_modules')}});
return{exit:r.status,signal:r.signal,error:r.error&&r.error.message,stdout:r.stdout||'',stderr:r.stderr||''};
}
function tap(output){const n=k=>{const a=[...output.matchAll(new RegExp('^# '+k+' (\\d+)','gm'))];return a.length?Number(a.at(-1)[1]):null;};return{tests:n('tests'),pass:n('pass'),fail:n('fail'),skip:n('skipped'),todo:n('todo')};}
function verdict(r){const counts=tap(r.stdout);return{status:r.error||r.signal?'ERROR':r.exit!==0?'FAIL':!counts.tests||counts.tests!==counts.pass||counts.skip||counts.todo?'UNVERIFIED':'PASS',...counts,exit:r.exit,signal:r.signal,error:r.error||null};}
function render(report,dest){
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lines=['# AGENTIX — reporte adversarial', '', 'Estado: **'+report.status+'**. Perfil: '+report.mode+'. Semilla: '+report.seed+'.', '', 'Mecanismos en fixtures; no certifica hosts reales, tokens reales, móvil ni WhatsApp.', '', '| Prueba | Estado | Evidencia |','|---|---|---|',...report.suites.map(s=>'| '+s.name+' | '+s.status+' | '+s.pass+'/'+s.tests+'; '+s.log+' |'),'', '## Ataques que encontraron huecos','',...report.attacks.failures.map(r=>'- '+r.name+': esperado '+r.expected+', obtuvo '+r.actual), '', '## Pendientes reales','',...report.pending.map(x=>'- '+x),'','Archivos originales alterados durante campaña: '+JSON.stringify(report.original_changed), ''];
fs.writeFileSync(path.join(dest,'REPORTE.md'),lines.join('\n'));
fs.writeFileSync(path.join(dest,'REPORTE.html'),'<!doctype html><meta charset="utf-8"><title>AGENTIX Sandbox</title><style>body{background:#11121a;color:#e8e8f4;font:16px system-ui;max-width:1100px;margin:40px auto;padding:24px}h1{color:#ad8cff}pre{white-space:pre-wrap}a{color:#69caff}</style><h1>AGENTIX · '+esc(report.mode)+'</h1><h2>'+esc(report.status)+'</h2><p>Fixture aislado. No es una certificación universal.</p><pre>'+esc(lines.join('\n'))+'</pre>');
}
function run({mode='teams',seed=211,rounds,output}={}){
if(!['individual','teams'].includes(mode))throw Error('MODE_INVALID');
const dest=output?path.resolve(output):fs.mkdtempSync(path.join(os.tmpdir(),'agentix-'+mode+'-'));
if(dest===source||dest.startsWith(source+path.sep))throw Error('OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
if(fs.existsSync(dest)&&fs.readdirSync(dest).length)throw Error('OUTPUT_MUST_BE_EMPTY');
fs.mkdirSync(dest,{recursive:true});const root=path.join(dest,'engine');const manifest=snapshot(root);
const catalog=require('./catalog.cjs');const groups={...catalog.individual,...(mode==='teams'?catalog.teams:{})};
const selected=new Set(Object.values(groups).flat());const excluded=new Set(mode==='individual'?Object.values(catalog.teams).flat():[]);groups.otros_mecanismos=fs.readdirSync(path.join(root,'test')).filter(f=>f.endsWith('.test.cjs')).map(f=>f.slice(0,-9)).filter(n=>!selected.has(n)&&!excluded.has(n));
const suites=[];for(const [name,names]of Object.entries(groups)){
process.stdout.write('Prueba '+name+'...\n');
const files=names.map(n=>'test/'+n+'.test.cjs');const missing=files.filter(f=>!fs.existsSync(path.join(root,f)));
if(missing.length){suites.push({name,status:'ERROR',missing});continue;}
const r=command(root,['--test','--test-reporter=tap',...files]);const log=name+'.tap.txt';fs.writeFileSync(path.join(dest,log),r.stdout+'\n'+r.stderr);suites.push({name,...verdict(r),log});
}
const attacks=require('./probes.cjs').run(root,rounds??(mode==='teams'?512:64),seed);if(mode==='teams'){const native=require('./native-probes.cjs').run(root);attacks.native=native;attacks.results.push(...native.results);attacks.failures.push(...native.failures);}
json(path.join(dest,'ATAQUES.json'),attacks);
const original_changed=unchanged(manifest);
const pending=['Cursor individual real: abrir workspace preparado y ejecutar campaña de host.','Claude Code + Cursor simultáneos: intercambio nativo, ACK, continuidad y cierre pendiente de ejecutar.','Instalación de hooks dentro de IDE y transporte real no ejecutados por este corredor.','Vigilancia Windows: simulación no prueba tarea instalada.','Dashboard: navegador real/offline/390px pendiente; firmas y APIs son mecanismos.','WhatsApp real excluido; no se envían mensajes.','Tokens reales UNKNOWN: solo el proveedor/host puede acreditarlos.'];
const report={schema_version:1,mode,seed,created_at:new Date().toISOString(),node:process.version,source,source_hash:sha(JSON.stringify(manifest)),status:suites.some(s=>s.status!=='PASS')||attacks.failures.length||original_changed.length?'FAIL':'MECHANISMS_PASS_HOSTS_PENDING',suites,attacks,original_changed,pending};
json(path.join(dest,'REPORTE.json'),report);render(report,dest);console.log('Reporte: '+path.join(dest,'REPORTE.html'));return{dest,report};
}
module.exports={source,sha,json,walk,snapshot,unchanged,command,tap,verdict,render,run};
