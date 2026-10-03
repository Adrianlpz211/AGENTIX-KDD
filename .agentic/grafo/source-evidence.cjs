'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const ignored=new Set(['node_modules','.git','.next','.nuxt','.venv','venv','dist','build','coverage','_output','.model_cache','__pycache__','_hooks','_cache']);
function capture(root){
 const files={},base=path.resolve(root);let size=0,complete=true;
 function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
 const abs=path.join(dir,e.name),rel=path.relative(base,abs).split(path.sep).join('/');
 if(!complete)return;
 if(rel.startsWith('.agentic/') && !['.agentic/grafo','.agentic/agentes'].some(p=>rel===p||rel.startsWith(p+'/')) && !['.agentic/nucleo-reglas.md','.agentic/config.md','.agentic/protected_files','.agentic/effort-policy.json'].includes(rel))continue;
 if(e.isDirectory()){if(ignored.has(e.name)||rel.startsWith('.agentic/')&&(/^\.agentic\/_/.test(rel)||['.agentic/memoria','.agentic/telemetria'].some(p=>rel===p)))continue;walk(abs);}
 else if(e.isFile()&&!/^browser-gate-.*\.png$|^visual-diff-.*\.png$/.test(e.name)&&!/\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$|\.bak-\d+$|\.log$/.test(e.name)&&!/^\.agentic\/_(?:.*)/.test(rel)){
 const b=fs.readFileSync(abs);size+=b.length;if(Object.keys(files).length>=20000||size>100*1024*1024){complete=false;return;}files[rel]=crypto.createHash('sha256').update(b).digest('hex');
 }}
 }
 try{walk(base);}catch{complete=false;}
 return{files,complete,hash:crypto.createHash('sha256').update(JSON.stringify(Object.entries(files).sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex')};
}
module.exports={capture};
