#!/usr/bin/env node
'use strict';
const args=process.argv.slice(2),action=args.find(a=>!a.startsWith('--'))||'help';
const opts=Object.fromEntries(args.filter(a=>a.startsWith('--')).map(a=>{const i=a.indexOf('=');return i<0?[a.slice(2),true]:[a.slice(2,i),a.slice(i+1)];}));
try{
if(action==='run'){const seed=Number(opts.seed??211),rounds=opts.rounds===undefined?undefined:Number(opts.rounds);if(!Number.isInteger(seed)||rounds!==undefined&&(!Number.isInteger(rounds)||rounds<1||rounds>4096))throw Error('SEED_OR_ROUNDS_INVALID');const r=require('../sandbox/core.cjs').run({mode:opts.mode||'individual',seed,rounds,output:opts.output});process.exitCode=r.report.status==='FAIL'?1:0;}
else if(action==='prepare')require('../sandbox/host.cjs').prepare({mode:opts.mode||'individual',output:opts.output});
else console.log('node scripts/sandbox.cjs run|prepare --mode=individual [--output=<directorio vacío externo>] [--seed=211] [--rounds=64]\nrun: mecanismos + ataques; prepare: campaña real para abrir en IDE. Sin push ni hooks globales.');
}catch(e){console.error(e.stack);process.exitCode=2;}
