'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const esc=require('./escenarios.cjs'),gr=require('./gate-result.cjs'),cache=require('./evidence-cache.cjs');
/** El controlador ejecuta su comprobador; un DTO suministrado por el builder no produce evidencia. */
function comprobar(root,input,{paths=[],check,checker}={}){
if(typeof check!=='function'||!checker||!Array.isArray(paths)||!paths.length)throw Error('COMPROBADOR_Y_ALCANCE_REQUERIDOS');
const before=cache.cierre(root,paths);if(before.incompleto||before.archivos.some(([f,h])=>h==='AUSENTE'||path.resolve(root,f).startsWith(path.resolve(root)+path.sep)===false))throw Error('SUJETO_INCOMPLETO');
const result=check();if(!result||!['PASS','FAIL','ERROR','UNVERIFIED'].includes(result.status)||result.status==='PASS'&&!(result.assertions>0))throw Error('COMPROBACION_SIN_ASSERTIONS');
const after=cache.cierre(root,paths);const status=before.hash===after.hash?result.status:'UNVERIFIED';
const execution_id=crypto.randomUUID(),source_files=Object.fromEntries(before.archivos);
const saved=esc.guardarArtefacto(root,{execution_id,gate:input.gate,subject_hash:input.subject_hash,policy_id:esc.POLICY_ID,cycle_id:input.cycle_id||null,provenance:'gate-check',comprobador:checker,runner_status:status,status,assertions:result.assertions||0,expected:[],executed:[],escenarios:{},source_files,runner_hash:cache.huellaRunner(root)});
if(!saved.ok)throw Error(saved.reason_code);
return gr.createGateResult({...input,status,execution_id,evidence:[{kind:'checked-artifact',subject_hash:input.subject_hash,ref:saved.path}],reason_code:status==='UNVERIFIED'?'SUJETO_CAMBIO_DURANTE_CHECK':input.reason_code});
}
module.exports={comprobar};
