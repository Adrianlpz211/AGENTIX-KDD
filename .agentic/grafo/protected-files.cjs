#!/usr/bin/env node
'use strict';

/**
 * .agentic/protected_files — archivos que ningún flujo de Agentix escribe.
 *
 * Formato: una ruta relativa a la raíz por línea; `#` comenta; una ruta que
 * termina en `/` protege la carpeta entera. Comodines no: una entrada es una
 * ruta, para que nadie lea "*" de dos maneras.
 *
 *   ausente            → lista vacía explícita (nada protegido)
 *   ilegible/inválido  → ERROR: no se escribe nada hasta repararlo
 *
 * Las rutas se comparan ya resueltas (path-norm): un alias, un enlace o un
 * junction que apunte a un protegido es el protegido.
 *
 * El manifiesto y los desbloqueos están siempre protegidos: la protección no
 * se edita a sí misma para eludirse. Un desbloqueo es humano (requiere
 * terminal interactiva), por archivo, por acción y con vencimiento.
 */

const fs = require('fs');
const path = require('path');
const pn = require('./path-norm.cjs');

const MANIFEST = path.join('.agentic', 'protected_files');
const UNLOCKS = path.join('.agentic', 'protected_unlocks.json');
const SIEMPRE = ['.agentic/protected_files', '.agentic/protected_unlocks.json'];
const ACCIONES = ['write', 'update', 'restore', 'delete'];

function cargar(root) {
  const archivo = path.join(root, MANIFEST);
  if (!fs.existsSync(archivo)) return { ok: true, status: 'PASS', entries: [], explicitEmpty: true };
  let txt;
  try { txt = fs.readFileSync(archivo, 'utf8'); } catch (err) {
    return { ok: false, status: 'ERROR', reason_code: 'MANIFEST_UNREADABLE', message: err.message };
  }
  const entries = [];
  const lineas = txt.split(/\r?\n/);
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i].trim();
    if (!l || l.startsWith('#')) continue;
    const invalida = /[*?[\]\0]/.test(l) ? 'comodín no soportado'
      : path.isAbsolute(l) || /^[a-z]:/i.test(l) ? 'ruta absoluta'
      : null;
    if (invalida) return { ok: false, status: 'ERROR', reason_code: 'MANIFEST_INVALID', line: i + 1, entry: l, message: invalida };
    const carpeta = /[\\/]$/.test(l);
    const r = pn.resolverEnRaiz(root, l.replace(/[\\/]+$/, ''));
    if (!r.ok) return { ok: false, status: 'ERROR', reason_code: 'MANIFEST_INVALID', line: i + 1, entry: l, message: r.reason };
    entries.push(r.rel + (carpeta ? '/' : ''));
  }
  return { ok: true, status: 'PASS', entries, explicitEmpty: false };
}

function desbloqueosVigentes(root, ahora) {
  try {
    const lista = JSON.parse(fs.readFileSync(path.join(root, UNLOCKS), 'utf8'));
    return (Array.isArray(lista) ? lista : []).filter((u) => Date.parse(u.expires_at) > ahora);
  } catch { return []; }
}

/**
 * ¿Se puede hacer `accion` sobre estos archivos?
 * → { status: PASS|FAIL|ERROR, blocked: [{file, entry}], unlocked: [...] }
 */
function verificar(root, archivos, opciones) {
  const o = opciones || {};
  const accion = o.accion || 'write';
  const m = cargar(root);
  if (!m.ok) return { status: 'ERROR', reason_code: m.reason_code, message: `${MANIFEST}: ${m.message}${m.line ? ' (línea ' + m.line + ')' : ''}`, blocked: [] };
  const lista = SIEMPRE.concat(m.entries);
  const vigentes = desbloqueosVigentes(root, o.ahora || Date.now());
  const blocked = [];
  const unlocked = [];
  for (const f of archivos || []) {
    const r = pn.resolverEnRaiz(root, f);
    if (!r.ok) { blocked.push({ file: f, entry: null, reason: r.reason }); continue; }
    const entrada = lista.find((e) => pn.permitido(root, r.rel, [e]));
    if (!entrada) continue;
    const llave = pn.clave(r.rel);
    const u = !SIEMPRE.includes(entrada) && vigentes.find((x) => pn.clave(x.file) === llave && x.accion === accion);
    if (u) unlocked.push({ file: r.rel, until: u.expires_at, by: u.by });
    else blocked.push({ file: r.rel, entry: entrada });
  }
  return { status: blocked.length ? 'FAIL' : 'PASS', reason_code: blocked.length ? 'PROTECTED' : null, blocked, unlocked, accion };
}

function desbloquear(root, { file, accion, minutos, by }, opciones) {
  const o = opciones || {};
  if (!o.interactivo) return { ok: false, reason_code: 'HUMAN_REQUIRED', message: 'el desbloqueo se pide desde una terminal interactiva' };
  if (!ACCIONES.includes(accion)) return { ok: false, reason_code: 'BAD_ACTION', message: 'acción: ' + ACCIONES.join('|') };
  const min = Number(minutos);
  if (!(min > 0 && min <= 24 * 60)) return { ok: false, reason_code: 'BAD_DURATION', message: 'minutos entre 1 y 1440' };
  const r = pn.resolverEnRaiz(root, file);
  if (!r.ok) return { ok: false, reason_code: r.reason };
  if (SIEMPRE.includes(r.rel)) return { ok: false, reason_code: 'NOT_UNLOCKABLE' };
  const ahora = o.ahora || Date.now();
  const lista = desbloqueosVigentes(root, ahora).concat({
    file: r.rel, accion, by: by || process.env.USERNAME || process.env.USER || 'humano',
    at: new Date(ahora).toISOString(), expires_at: new Date(ahora + min * 60000).toISOString(),
  });
  fs.writeFileSync(path.join(root, UNLOCKS), JSON.stringify(lista, null, 2));
  return { ok: true, file: r.rel, accion, expires_at: lista[lista.length - 1].expires_at };
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const root = process.cwd();
  const flag = (n) => { const a = rest.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
  if (cmd === 'check') {
    const r = verificar(root, rest.filter((x) => !x.startsWith('--')), { accion: flag('accion') || 'write' });
    if (r.status === 'ERROR') console.log(`⛔ ERROR — ${r.message}`);
    else if (r.status === 'FAIL') console.log('⛔ Protegido: ' + r.blocked.map((b) => b.file).join(', '));
    else console.log('✅ Ningún archivo protegido' + (r.unlocked.length ? ` (desbloqueados: ${r.unlocked.map((u) => u.file).join(', ')})` : ''));
    process.exit(r.status === 'PASS' ? 0 : 1);
  } else if (cmd === 'unlock') {
    const r = desbloquear(root, { file: flag('file'), accion: flag('accion'), minutos: flag('minutos') },
      { interactivo: !!(process.stdin.isTTY && process.stdout.isTTY) });
    console.log(r.ok ? `🔓 ${r.file} (${r.accion}) hasta ${r.expires_at}` : `⛔ ${r.reason_code}${r.message ? ' — ' + r.message : ''}`);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'list') {
    const m = cargar(root);
    if (!m.ok) { console.log(`⛔ ERROR — ${m.message}`); process.exit(1); }
    console.log(m.explicitEmpty ? '(sin manifiesto: nada protegido)' : m.entries.join('\n') || '(manifiesto vacío)');
  } else {
    console.log('Uso: protected-files.cjs check <archivos...> [--accion=write|update|restore|delete]');
    console.log('     protected-files.cjs unlock --file=<ruta> --accion=<acción> --minutos=<n>   (terminal interactiva)');
    console.log('     protected-files.cjs list');
  }
}

module.exports = { cargar, verificar, desbloquear, MANIFEST, SIEMPRE, ACCIONES };
