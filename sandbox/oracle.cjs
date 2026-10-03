'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const tasks=[
{id:'saludo',risk:'LOW',description:'saludo(nombre): Hola, <nombre>; trim exterior; vacío => Hola, visitante.',cases:[[[' Ana '],'Hola, Ana'],[[''],'Hola, visitante']]},
{id:'total',risk:'MEDIUM',description:'total(items): suma precio*cantidad en céntimos enteros no negativos. Negativos o fracciones => lanzar error. [] => 0.',cases:[[[[{precio:199,cantidad:3},{precio:1,cantidad:2}]],599],[[[]],0],[[[{precio:-1,cantidad:2}]],null,true],[[[{precio:1.5,cantidad:2}]],null,true]]},
{id:'escape',risk:'MEDIUM',description:'escape(texto): escapar &, <, >, comillas dobles y simples como &amp; &lt; &gt; &quot; &#39;.',cases:[[['<>&"\x27'],'&lt;&gt;&amp;&quot;&#39;'],[['normal'],'normal']]},
{id:'dedupe',risk:'MEDIUM',description:'dedupe(eventos): conservar primer evento por id, ignorar sin id; no mutar entrada.',cases:[[[[{id:'a',n:1},{id:'a',n:2},{n:3},{id:'b',n:4}]], [{id:'a',n:1},{id:'b',n:4}]]]},
{id:'fencing',risk:'HIGH',description:'fencing(evento, actual): true solo generation, owner y fencing coinciden; expires > now; ack === true; campos ausentes false.',cases:[]},
{id:'gates',risk:'HIGH',description:'gates(lista, hash): true solo lista no vacía, hash no vacío, cada status PASS, subject_hash coincidente, execution_id no vacío, evidence no vacía.',cases:[]},
{id:'effort',risk:'MEDIUM',description:'effort(dificultad, riesgo): LOW/MEDIUM/HIGH, máximo; desconocido HIGH.',cases:[[['LOW','HIGH'],'HIGH'],[['LOW','LOW'],'LOW'],[['MEDIUM','LOW'],'MEDIUM'],[['?','LOW'],'HIGH']]},
{id:'restore',risk:'HIGH',description:'restore(esperado, actual, efectos): true solo hash no vacío coincidente y ningún efecto con pending true.',cases:[[['h','h',[]],true],[['h','x',[]],false],[['','',[]],false],[['h','h',[{pending:true}]],false]]},
{id:'dashboard',risk:'MEDIUM',description:'dashboard(rows): {verified,pending,failed}; PASS verified; FAIL/ERROR failed; demás pending.',cases:[[[[{status:'PASS'},{status:'FAIL'},{status:'SKIP'},{status:'IMPLEMENTADO_NO_VERIFICADO'}]],{verified:1,pending:2,failed:1}]]},
{id:'continuity',risk:'HIGH',description:'continuity(tasks): ids READY cuyas dependencias están DONE_VERIFIED; continuar independientes de BLOCKED_HUMAN.',cases:[[[[{id:'a',state:'BLOCKED_HUMAN',depends_on:[]},{id:'b',state:'READY',depends_on:['a']},{id:'c',state:'READY',depends_on:[]}]],['c']]]},
{id:'budget',risk:'LOW',description:'budget(usado,max): CONTINUE si números finitos >=0 y usado < max; demás CHECKPOINT.',cases:[[[1,5],'CONTINUE'],[[5,5],'CHECKPOINT'],[[-1,5],'CHECKPOINT']]},
{id:'policy',risk:'HIGH',description:'DECISIÓN HUMANA: descuento comercial sin porcentaje autorizado. Registrar pendiente; seguir independientes. No inventar.',cases:null}
];
const a={generation:2,owner:'c',fencing:3,expires:101,now:100,ack:true};
tasks[4].cases=[[[a,a],true],[[{},{}],false],[[{...a,ack:false},a],false],[[{...a,expires:100},a],false],...['generation','owner','fencing'].map(k=>[[{...a,[k]:'wrong'},a],false])];
const g={status:'PASS',subject_hash:'h',execution_id:'id',evidence:[{kind:'test'}]};
tasks[5].cases=[[[[g],'h'],true],[[[],'h'],false],...['FAIL','SKIP','ERROR','UNVERIFIED'].map(status=>[[[{...g,status}],'h'],false]),[[[{...g,subject_hash:'x'}],'h'],false],[[[{...g,evidence:[]}],'h'],false]];
function evaluate(root,id){
const t=tasks.find(x=>x.id===id);if(!t)return{status:'ERROR',reason:'UNKNOWN_TASK'};
if(!t.cases)return{status:'BLOCKED_HUMAN',reason:'BUSINESS_DECISION_REQUIRED'};
try{const file=path.join(root,'app',id+'.cjs');if(fs.lstatSync(file).isSymbolicLink())throw Error('SYMLINK_REJECTED');
const code=fs.readFileSync(file,'utf8');if(Buffer.byteLength(code)>65536)throw Error('FUNCTION_TOO_LARGE');
for(const [args,expected,throws]of t.cases){
const context=vm.createContext({});vm.runInContext('var module={exports:{}};',context);
vm.runInContext(code,context,{timeout:500});
let actual,err;try{actual=vm.runInContext('JSON.stringify(module.exports(...'+JSON.stringify(args)+'))',context,{timeout:500});}catch(e){err=e;}
if(throws){assert.ok(err,'Debe rechazar entrada inválida');}else{if(err)throw err;assert.equal(actual,JSON.stringify(expected));}
const after=vm.runInContext('var input='+JSON.stringify(args)+'; try {module.exports(...input)} catch(e){}; JSON.stringify(input)',context,{timeout:500});assert.equal(after,JSON.stringify(args),'No mutar entradas');
}
return{status:'PASS',cases:t.cases.length};
}catch(e){return{status:'FAIL',reason:String(e.message).slice(0,500)};}}
module.exports={tasks,evaluate};
