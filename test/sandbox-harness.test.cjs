'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const core=require('../sandbox/core.cjs'),oracle=require('../sandbox/oracle.cjs');
function root(){const r=fs.mkdtempSync(path.join(os.tmpdir(),'akdd-oracle-'));fs.mkdirSync(path.join(r,'app'));return r;}
test('runner no cierra con cero tests, SKIP o salida PASS inventada',()=>{
assert.equal(core.verdict({exit:0,stdout:'PASS',stderr:''}).status,'UNVERIFIED');
assert.equal(core.verdict({exit:0,stdout:'# tests 2\n# pass 1\n# fail 0\n# skipped 1\n# todo 0\n',stderr:''}).status,'UNVERIFIED');
assert.equal(core.verdict({exit:1,stdout:'# tests 1\n# pass 1\n',stderr:''}).status,'FAIL');
assert.equal(core.verdict({exit:0,stdout:'# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# todo 0\n',stderr:''}).status,'PASS');
});
test('oráculo distingue función sana, mutante, timeout y pendiente humano',()=>{
const r=root(),f=path.join(r,'app/saludo.cjs');
fs.writeFileSync(f,"module.exports=n=>'Hola, '+(n.trim()||'visitante');");assert.equal(oracle.evaluate(r,'saludo').status,'PASS');
fs.writeFileSync(f,"module.exports=n=>'Hola, '+n;");assert.equal(oracle.evaluate(r,'saludo').status,'FAIL');
fs.writeFileSync(f,"module.exports=()=>{while(true){}};");assert.equal(oracle.evaluate(r,'saludo').status,'FAIL');
assert.equal(oracle.evaluate(r,'policy').status,'BLOCKED_HUMAN');
});
test('ninguna función pendiente inicia verde; todos los objetivos tienen oráculo o decisión humana',()=>{
const r=root();for(const t of oracle.tasks){fs.writeFileSync(path.join(r,'app',t.id+'.cjs'),'module.exports=()=>undefined;');assert.equal(oracle.evaluate(r,t.id).status,t.cases?'FAIL':'BLOCKED_HUMAN');}
});
test('directorio de salida original rechazado antes de copia',()=>{
assert.throws(()=>core.run({output:core.source}),/OUTSIDE/);
assert.throws(()=>core.run({output:path.join(core.source,'fixture')}),/OUTSIDE/);
});
