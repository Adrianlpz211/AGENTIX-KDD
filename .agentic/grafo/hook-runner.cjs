#!/usr/bin/env node
'use strict';

/**
 * Los hooks de git de Agentix, en Node: igual en Windows y en Linux.
 *
 *   pre-commit          gates sobre el ÍNDICE (no el worktree)
 *   commit-msg <file>   canario con el mensaje de ESTE commit
 *   post-commit         encola el commit (SHA/parent/tree) y lanza el worker
 *   drain               procesa la cola, un commit cada vez, con ACK
 *
 * Severidad: CRITICAL/FAIL/ERROR de un gate requerido bloquea; WARN se ve y no
 * bloquea. Un gate que no pudo revisar todo lo que debía queda INCOMPLETE y
 * bloquea: no revisado no es limpio.
 *
 * Escotilla: AKDD_SKIP_GATES=1 git commit ...   (o git commit --no-verify)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const sc = require('./staged-content.cjs');

const GRAFO = __dirname;

const POLITICA = {
  max_archivos: 2000,
  max_bytes_archivo: 2 * 1024 * 1024,
  max_bytes_total: 64 * 1024 * 1024,
  /* Lo que el escudo de seguridad TIENE que leer: código, SQL, configuración y .env. */
  seguridad: /\.(js|jsx|ts|tsx|mjs|cjs|py|rb|php|go|java|cs|sql|json|ya?ml|toml|ini|properties|xml|sh|ps1|tf)$|(^|\/)\.env(\..+)?$|(^|\/)(Dockerfile|docker-compose[^/]*)$/i,
  front: /\.(js|jsx|ts|tsx|html)$/i,
};

function raizGit(cwd) {
  const r = sc.git(cwd || process.cwd(), ['rev-parse', '--show-toplevel']);
  return r.ok ? r.stdout.toString('utf8').trim() : null;
}

const dirHooks = (root) => path.join(root, '.agentic', '_hooks');

function escribirAtomico(archivo, datos) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = archivo + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 2));
  fs.renameSync(tmp, archivo);
}

// ── pre-commit ───────────────────────────────────────────────────────────────

/**
 * Revisa el índice. Devuelve { status: PASS|WARN|FAIL|INCOMPLETE|ERROR, bloquea,
 * tree, gates: {...}, omitidos, mensajes }.
 */
function preCommit(root, opciones) {
  const o = opciones || {};
  const mensajes = [];
  const gates = {};
  const tree = sc.treeDelIndice(root);

  const enConflicto = sc.conflictos(root);
  if (enConflicto.length) {
    return { status: 'FAIL', bloquea: true, tree, gates: { merge: { status: 'FAIL', reason_code: 'MERGE_CONFLICT', files: enConflicto } },
      omitidos: [], mensajes: ['Merge sin resolver en: ' + enConflicto.join(', ')] };
  }

  const ent = sc.entradas(root);
  if (!ent.ok) return { status: 'ERROR', bloquea: true, tree, gates: {}, omitidos: [], mensajes: ['git no pudo listar el índice: ' + ent.error] };

  const vivos = ent.items.filter((e) => e.status !== 'D');
  const contenido = new Map();
  const omitidos = [];
  let total = 0;
  for (const e of vivos) {
    if (contenido.size >= POLITICA.max_archivos) { omitidos.push({ file: e.path, reason: 'PRESUPUESTO_ARCHIVOS' }); continue; }
    const b = sc.leer(root, e.path);
    if (!b.ok) { omitidos.push({ file: e.path, reason: 'ILEGIBLE' }); continue; }
    if (b.binary) { omitidos.push({ file: e.path, reason: 'BINARIO' }); continue; }
    if (b.size > POLITICA.max_bytes_archivo) { omitidos.push({ file: e.path, reason: 'DEMASIADO_GRANDE' }); continue; }
    if (total + b.size > POLITICA.max_bytes_total) { omitidos.push({ file: e.path, reason: 'PRESUPUESTO_BYTES' }); continue; }
    total += b.size;
    contenido.set(e.path, b.buffer.toString('utf8'));
  }
  const leerIndice = (f) => (contenido.has(String(f).replace(/\\/g, '/')) ? contenido.get(String(f).replace(/\\/g, '/')) : null);

  // 1) Escudo de seguridad sobre todo lo que la política exige leer.
  const paraSeguridad = vivos.map((e) => e.path).filter((p) => POLITICA.seguridad.test(p));
  const sinLeer = omitidos.filter((x) => POLITICA.seguridad.test(x.file) && x.reason !== 'BINARIO');
  try {
    const sg = require(path.join(GRAFO, 'security-gate.cjs'));
    const r = paraSeguridad.length ? sg.runSecurityGate(paraSeguridad.filter((p) => contenido.has(p)), root, { readContent: leerIndice }) : { passed: true, message: 'sin archivos' };
    gates.security = sinLeer.length
      ? { status: 'INCOMPLETE', reason_code: 'NOT_ALL_SCANNED', files: sinLeer, message: r.message }
      : { status: r.passed ? (r.warn ? 'WARN' : 'PASS') : 'FAIL', message: r.message };
  } catch (err) {
    gates.security = { status: 'ERROR', reason_code: 'GATE_ERROR', message: err.message };
  }

  // 2) Integridad de tests protegidos (CRITICAL bloquea).
  try {
    const tig = require(path.join(GRAFO, 'test-integrity-gate.cjs'));
    const borrados = ent.items.filter((e) => e.status === 'D').map((e) => e.path);
    const renombrados = {};
    for (const e of ent.items) if (e.status === 'R') renombrados[e.path] = e.from;
    const res = tig.scan(root, { files: vivos.map((e) => e.path), readContent: leerIndice, deleted: borrados, renamed: renombrados });
    const crit = res.findings.filter((f) => f.nivel === 'CRITICAL');
    gates.test_integrity = { status: crit.length ? 'FAIL' : (res.findings.length ? 'WARN' : 'PASS'), message: tig.formatear(res) };
  } catch (err) {
    gates.test_integrity = { status: 'ERROR', reason_code: 'GATE_ERROR', message: err.message };
  }

  // 3) Canario sin mensaje: aquí solo avisa. El freno de "arreglo sin test" va en commit-msg.
  try {
    const cg = require(path.join(GRAFO, 'canario-gate.cjs'));
    const r = cg.revisar(root, { files: ent.items.filter((e) => e.status !== 'D').map((e) => e.path), mensaje: '' });
    gates.canario = { status: r.veredicto === 'PASS' ? 'PASS' : 'WARN', message: cg.formatear(r) };
  } catch (err) {
    gates.canario = { status: 'WARN', message: 'canario no disponible: ' + err.message };
  }

  // 4) Avisos (no bloquean): valores de negocio y diálogos nativos.
  if (!o.sinAvisos) {
    const svs = path.join(GRAFO, 'spec-value-scan.cjs');
    if (fs.existsSync(svs)) spawnSync(process.execPath, [svs, '--staged'], { cwd: root, stdio: 'inherit' });
    const front = vivos.map((e) => e.path).filter((p) => POLITICA.front.test(p));
    const ung = path.join(GRAFO, 'ui-native-gate.cjs');
    if (front.length && fs.existsSync(ung)) spawnSync(process.execPath, [ung, ...front], { cwd: root, stdio: 'inherit' });
  }

  const bloqueantes = ['security', 'test_integrity'];
  const peor = (s) => bloqueantes.some((g) => gates[g] && gates[g].status === s);
  const status = peor('ERROR') ? 'ERROR' : peor('FAIL') ? 'FAIL' : peor('INCOMPLETE') ? 'INCOMPLETE'
    : Object.values(gates).some((g) => g.status === 'WARN') ? 'WARN' : 'PASS';
  for (const [n, g] of Object.entries(gates)) if (g.status !== 'PASS' && g.message) mensajes.push(`[${n}] ${g.status}\n${g.message}`);

  const resultado = { status, bloquea: ['ERROR', 'FAIL', 'INCOMPLETE'].includes(status), tree, gates, omitidos,
    files: ent.items, mensajes, at: new Date().toISOString() };
  try { escribirAtomico(path.join(dirHooks(root), 'pre-commit.json'), resultado); } catch { /* la evidencia es un plus */ }
  return resultado;
}

// ── commit-msg ───────────────────────────────────────────────────────────────

function leerMensaje(archivo) {
  const txt = fs.readFileSync(archivo, 'utf8');
  return txt.split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n').trim();
}

/**
 * Canario con el mensaje real. Reutiliza la lista del pre-commit solo si el
 * árbol del índice no cambió desde entonces; si cambió, la recalcula.
 */
function commitMsg(root, archivoMensaje) {
  const mensaje = leerMensaje(archivoMensaje);
  const tree = sc.treeDelIndice(root);
  let files = null;
  let reutilizado = false;
  try {
    const previo = JSON.parse(fs.readFileSync(path.join(dirHooks(root), 'pre-commit.json'), 'utf8'));
    if (previo.tree && previo.tree === tree) { files = previo.files; reutilizado = true; }
  } catch { /* sin evidencia previa */ }
  if (!files) {
    const ent = sc.entradas(root);
    if (!ent.ok) return { status: 'ERROR', bloquea: true, message: 'git no pudo listar el índice' };
    files = ent.items;
  }
  const cg = require(path.join(GRAFO, 'canario-gate.cjs'));
  const r = cg.revisar(root, { files: files.filter((e) => e.status !== 'D').map((e) => e.path), mensaje });
  return { status: r.veredicto === 'STOP' ? 'FAIL' : (r.veredicto === 'WARN' ? 'WARN' : 'PASS'),
    bloquea: r.veredicto === 'STOP', message: cg.formatear(r), tree, reutilizado, mensaje };
}

// ── post-commit: cola por commit ─────────────────────────────────────────────

const dirCola = (root) => path.join(dirHooks(root), 'queue');
const dirHechos = (root) => path.join(dirHooks(root), 'done');

function revParse(root, ref) {
  const r = sc.git(root, ['rev-parse', '--verify', '--quiet', ref]);
  return r.ok ? r.stdout.toString('utf8').trim() : null;
}

/** Persiste el commit ANTES de lanzar nada. Idempotente por SHA. */
function encolar(root, sha) {
  const commit = sha || revParse(root, 'HEAD');
  if (!commit) return { ok: false, reason_code: 'NO_COMMIT' };
  const destino = path.join(dirCola(root), commit + '.json');
  if (fs.existsSync(destino) || fs.existsSync(path.join(dirHechos(root), commit + '.json'))) {
    return { ok: true, duplicate: true, sha: commit };
  }
  const item = {
    event_id: 'commit-' + commit,
    sha: commit,
    parent: revParse(root, commit + '^'),
    tree: revParse(root, commit + '^{tree}'),
    enqueued_at: new Date().toISOString(),
    seq: Date.now() + '-' + process.hrtime.bigint().toString(),
  };
  escribirAtomico(destino, item);
  return { ok: true, sha: commit, item };
}

function areaDe(root, sha) {
  const r = sc.git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', sha]);
  const files = r.ok ? r.stdout.toString('utf8').split('\0').filter(Boolean) : [];
  const src = files.find((f) => f.startsWith('src/') && f.split('/').length > 2);
  return { area: src ? src.split('/')[1] : 'general', files };
}

/** Ejecutor por defecto: post-cycle sobre ESE commit, con su ciclo propio. */
function ejecutarPostCycle(root, item) {
  const pcPath = path.join(root, '.agentic', 'grafo', 'post-cycle.cjs');
  if (!fs.existsSync(pcPath)) return { status: 'SKIP', reason_code: 'NO_POST_CYCLE' };
  const { area } = areaDe(root, item.sha);
  const r = spawnSync(process.execPath, [pcPath, area, '--hook', '--commit=' + item.sha, '--task=auto post-commit ' + item.sha.slice(0, 7)], {
    cwd: root, encoding: 'utf8', timeout: 15 * 60 * 1000,
    env: Object.assign({}, process.env, { AKDD_CYCLE_ID: item.event_id }),
  });
  try {
    fs.appendFileSync(path.join(root, '.agentic', 'grafo', 'post-cycle.log'), (r.stdout || '') + (r.stderr || ''));
  } catch { /* log es un plus */ }
  return { status: r.status === 0 ? 'PASS' : 'ERROR', exit: r.status };
}

/**
 * Procesa la cola con un lock de archivo. Cada commit queda con su ACK en
 * done/<sha>.json. Un crash entre ejecutar y ACK reprocesa ese commit en la
 * siguiente pasada; el ciclo usa cycle_id = commit-<sha>, así que no se duplica.
 */
function drenar(root, opciones) {
  const o = opciones || {};
  const ejecutar = o.ejecutar || ejecutarPostCycle;
  const lockPath = path.join(dirHooks(root), 'drain.lock');
  fs.mkdirSync(dirHooks(root), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch {
    let viejo = 0;
    try { viejo = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { /* se acaba de liberar */ }
    if (viejo < (o.lockTtlMs || 20 * 60 * 1000)) return { ok: true, busy: true, processed: [] };
    try { fs.unlinkSync(lockPath); fd = fs.openSync(lockPath, 'wx'); } catch { return { ok: true, busy: true, processed: [] }; }
  }
  const processed = [];
  try {
    fs.writeSync(fd, String(process.pid));
    for (;;) {
      let pendientes = [];
      try { pendientes = fs.readdirSync(dirCola(root)).filter((f) => f.endsWith('.json')); } catch { break; }
      const items = pendientes.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dirCola(root), f), 'utf8')); } catch { return null; } })
        .filter(Boolean).sort((a, b) => String(a.seq).localeCompare(String(b.seq)));
      if (!items.length) break;
      for (const item of items) {
        const hecho = path.join(dirHechos(root), item.sha + '.json');
        if (!fs.existsSync(hecho)) {
          let res;
          try { res = ejecutar(root, item); } catch (err) { res = { status: 'ERROR', error: err.message }; }
          if (o.crashAntesDeAck) throw new Error('crash simulado antes del ACK');
          escribirAtomico(hecho, Object.assign({}, item, { result: res, done_at: new Date().toISOString() }));
          processed.push({ sha: item.sha, result: res });
        }
        try { fs.unlinkSync(path.join(dirCola(root), item.sha + '.json')); } catch { /* ya no está */ }
      }
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* */ }
    try { fs.unlinkSync(lockPath); } catch { /* */ }
  }
  return { ok: true, processed };
}

function lanzarWorker(root) {
  const hijo = spawn(process.execPath, [__filename, 'drain'], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
  hijo.unref();
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function imprimirBloqueo(titulo, mensajes) {
  console.log('');
  console.log('  COMMIT BLOQUEADO — ' + titulo);
  for (const m of mensajes) console.log('\n' + m.split('\n').map((l) => '   ' + l).join('\n'));
  console.log('\n     Arregla lo señalado y vuelve a intentar.');
  console.log('     Si de verdad no aplica:  AKDD_SKIP_GATES=1 git commit ...\n');
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const root = raizGit(process.cwd());
  if (!root) return 0;
  if (cmd === 'post-commit') {
    const r = encolar(root);
    if (r.ok && !r.duplicate && process.env.AKDD_HOOK_NO_WORKER !== '1') lanzarWorker(root);
    return 0;
  }
  if (cmd === 'drain') { drenar(root); return 0; }
  if (process.env.AKDD_SKIP_GATES === '1') {
    console.log('  ⚠️  AKDD_SKIP_GATES=1 — gates de ' + cmd + ' saltados a propósito');
    return 0;
  }
  if (cmd === 'pre-commit') {
    const r = preCommit(root);
    for (const m of r.mensajes) if (!r.bloquea) console.log(m);
    if (r.bloquea) { imprimirBloqueo(r.status, r.mensajes); return 1; }
    return 0;
  }
  if (cmd === 'commit-msg') {
    if (!rest[0]) return 0;
    const r = commitMsg(root, rest[0]);
    if (r.bloquea) { imprimirBloqueo('canario', [r.message]); return 1; }
    if (r.status === 'WARN') console.log(r.message);
    return 0;
  }
  console.log('Uso: hook-runner.cjs pre-commit | commit-msg <archivo> | post-commit | drain');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { preCommit, commitMsg, encolar, drenar, main, POLITICA, leerMensaje };
