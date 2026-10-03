'use strict';
// Recibos sintéticos SOLO para tests de estados/transporte. No certifican un host real.
const fs=require('fs'),path=require('path');
const gr=require('../../.agentic/grafo/gate-result.cjs'),ev=require('../../.agentic/grafo/gate-evidence.cjs');
function fixtureGate(root,input,files){
if(input.status!=='PASS')return gr.createGateResult(input);
if(!files){try{files=require('../../.agentic/grafo/teams-manager.cjs').estado(root).tareas.map(t=>require('../../.agentic/grafo/teams-manager.cjs').leerTarea(root,t.id)).find(t=>t.subject_hash===input.subject_hash).allowed_files;}catch{}}
files=files||['fixture-state.txt'];
for(const f of files)if(!fs.existsSync(path.join(root,f))){fs.mkdirSync(path.dirname(path.join(root,f)),{recursive:true});fs.writeFileSync(path.join(root,f),'synthetic scheduler fixture\n');}
return ev.comprobar(root,input,{paths:files,checker:'test-state-fixture',check:()=>({status:'PASS',assertions:1})});
}
module.exports={fixtureGate};
