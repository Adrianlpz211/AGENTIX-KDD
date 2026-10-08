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
  // Un --amend sin cambios de contenido (o un rebase que reproduce el mismo árbol) genera un SHA nuevo con el MISMO árbol: el trabajo
  // ya está registrado. Se anota como hecho (DUP_TREE) en vez de gastar otra corrida de post-cycle con sus pruebas.
  const previo = item.tree && hechoConArbol(root, item.tree);
  if (previo) {
    escribirAtomico(path.join(dirHechos(root), commit + '.json'), Object.assign({}, item, { result: { status: 'DUP_TREE', de: previo }, done_at: new Date().toISOString() }));
    return { ok: true, sha: commit, item, duplicate: true, dup_tree: true };
  }
  escribirAtomico(destino, item);
  return { ok: true, sha: commit, item };
}

/** ¿Algún commit ya registrado con éxito tiene este árbol? Devuelve su SHA. */
function hechoConArbol(root, tree) {
  try {
    for (const f of fs.readdirSync(dirHechos(root))) {
      if (!f.endsWith('.json')) continue;
      let it; try { it = JSON.parse(fs.readFileSync(path.join(dirHechos(root), f), 'utf8')); } catch { continue; }
      if (it && it.tree === tree && it.result && (it.result.status === 'PASS' && it.result.verificado !== false)) return it.sha;
    }
  } catch { /* sin carpeta de hechos aún */ }
  return null;
}

function areaDe(root, sha) {
  // Un merge (más de un padre) sin -m da CERO archivos: se compara con el primer padre.
  const padres = sc.git(root, ['rev-list', '--parents', '-n', '1', sha]);
  const esMerge = padres.ok && padres.stdout.toString('utf8').trim().split(/\s+/).length > 2;
  const r = sc.git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', ...(esMerge ? ['-m', '--first-parent'] : []), sha]);
  const files = r.ok ? r.stdout.toString('utf8').split('\0').filter(Boolean) : [];
  // Área = carpeta de primer nivel dentro de la raíz de código REAL del proyecto (src/, app/, lib/, packages/x/src…), la más tocada.
  // Antes solo entendía src/<x>/…: en un proyecto Next.js (app/, lib/, components/) TODO caía en «general».
  let raices = []; try { raices = require('./code-roots.cjs').raicesDeCodigo(root).sort((a, b) => b.length - a.length); } catch { /* motor sin code-roots */ }
  const cuenta = new Map();
  for (const f of files) {
    const raiz = raices.find((r) => f.startsWith(r + '/'));
    if (!raiz) continue;
    const resto = f.slice(raiz.length + 1).split('/');
    const area = resto.length > 1 ? resto[0] : raiz.split('/').pop();
    cuenta.set(area, (cuenta.get(area) || 0) + 1);
  }
  const mejor = [...cuenta.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return { area: mejor ? mejor[0] : 'general', files, esMerge };
}

/** Asunto del commit: es lo que la persona escribió para describir ESTE trabajo (antes la tarea era «auto post-commit abc1234»). */
function asuntoDe(root, sha) {
  const r = sc.git(root, ['log', '-1', '--format=%s', sha]);
  return r.ok ? r.stdout.toString('utf8').replace(/[\r\n"]+/g, ' ').trim().slice(0, 140) : '';
}

/** Ejecutor por defecto: post-cycle sobre ESE commit, con su ciclo propio. */
function ejecutarPostCycle(root, item) {
  const pcPath = path.join(root, '.agentic', 'grafo', 'post-cycle.cjs');
  if (!fs.existsSync(pcPath)) return { status: 'SKIP', reason_code: 'NO_POST_CYCLE' };
  const { area } = areaDe(root, item.sha);
  const asunto = asuntoDe(root, item.sha);
  const tarea = 'auto post-commit ' + item.sha.slice(0, 7) + (asunto ? ' — ' + asunto : '');
  const r = spawnSync(process.execPath, [pcPath, area, '--hook', '--commit=' + item.sha, '--task=' + tarea], {
    cwd: root, encoding: 'utf8', timeout: 15 * 60 * 1000,
    env: Object.assign({}, process.env, { AKDD_CYCLE_ID: item.event_id }),
  });
  try {
    fs.appendFileSync(path.join(root, '.agentic', 'grafo', 'post-cycle.log'), (r.stdout || '') + (r.stderr || ''));
  } catch { /* log es un plus */ }
  // Antes: cualquier salida se daba por «hecha» y NUNCA se reintentaba (medinet: 2 de 4 commits sin ciclo, uno con «PASS» y otro con
  // «ERROR», los dos archivados en done/). Ahora un fallo es REINTENTABLE y un éxito se comprueba contra la base.
  if (r.error && r.error.code === 'ETIMEDOUT') return { status: 'RETRY', reason_code: 'POST_CYCLE_TIMEOUT', exit: null };
  if (r.status === 75) return { status: 'RETRY', reason_code: 'UPDATE_EN_CURSO', exit: 75 };
  if (r.status !== 0) return { status: 'RETRY', reason_code: 'POST_CYCLE_EXIT_' + r.status, exit: r.status };
  if (!fs.existsSync(path.join(root, '.agentic', 'memoria.db'))) return { status: 'SIN_BD', exit: 0 };
  // Salir con 0 no prueba que el ciclo exista (post-cycle sale con 0 «omitido» si algo falta): se mira en SQL.
  let v = { ok: null };
  try { v = require('./teams-registro.cjs').verificarCiclo(root, item.event_id); } catch { /* sin verificador: se informa como no comprobado */ }
  if (v.ok === false) return { status: 'RETRY', reason_code: 'CICLO_NO_REGISTRADO', causa: v.causa || null, exit: 0 };
  return { status: 'PASS', exit: 0, verificado: v.ok === true };
}

/**
 * Procesa la cola con un lock de archivo. Cada commit queda con su ACK en
 * done/<sha>.json. Un crash entre ejecutar y ACK reprocesa ese commit en la
 * siguiente pasada; el ciclo usa cycle_id = commit-<sha>, así que no se duplica.
 */
const MAX_INTENTOS_COLA = 5;
/** Espera antes del intento n (1,2,3…): 30 s, 1 min, 2 min, 4 min, 8 min (tope 10). */
const esperaReintento = (n) => Math.min(10 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, n - 1));
const dormir = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* sin espera */ } };

function drenar(root, opciones) {
  const o = opciones || {};
  const ejecutar = o.ejecutar || ejecutarPostCycle;
  // 3.20.1 — un akdd update vivo tiene la exclusión de escritores: los commits siguen en la cola y se procesan después.
  try {
    const g = require('./update-guard.cjs');
    const e = g.estado(root);
    if (e.held && !(e.holder && process.env.AKDD_UPDATE_TOKEN === e.holder.token)) return { ok: true, busy: true, update_in_progress: true, processed: [] };
  } catch { /* motor sin update-guard */ }
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
  const inicioPasada = Date.now();
  try {
    fs.writeSync(fd, String(process.pid));
    let pasadas = 0;
    for (;;) {
      if (o.unaPasada && pasadas++ > 0) break; // (pruebas) una sola vuelta por llamada
      let pendientes = [];
      try { pendientes = fs.readdirSync(dirCola(root)).filter((f) => f.endsWith('.json')); } catch { break; }
      const items = pendientes.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dirCola(root), f), 'utf8')); } catch { return null; } })
        .filter(Boolean).sort((a, b) => String(a.seq).localeCompare(String(b.seq)));
      if (!items.length) break;
      const ahora = Date.now();
      const debidos = items.filter((it) => !it.next_attempt_at || Date.parse(it.next_attempt_at) <= ahora);
      if (!debidos.length) {
        // Solo quedan reintentos futuros: el worker espera a que toque (con tope), no gira en vacío ni los abandona.
        if (o.noEsperar || Date.now() - inicioPasada > (o.esperaMaxMs || 40 * 60 * 1000)) break;
        const falta = Math.min(...items.map((it) => Date.parse(it.next_attempt_at) - ahora));
        dormir(Math.min(Math.max(falta, 500), 30000));
        continue;
      }
      for (const item of debidos) {
        const hecho = path.join(dirHechos(root), item.sha + '.json');
        if (!fs.existsSync(hecho)) {
          let res;
          try { res = ejecutar(root, item); } catch (err) { res = { status: 'ERROR', error: err.message }; }
          if (o.crashAntesDeAck) throw new Error('crash simulado antes del ACK');
          if (res && (res.status === 'RETRY' || res.status === 'ERROR')) {
            // No se da por hecho: vuelve a la cola con su contador y su próxima hora; al agotar los intentos se ARCHIVA con el motivo
            // (status ABANDONADA) para que `akdd` y el diagnóstico lo muestren. Antes quedaba como «hecho» y se perdía.
            const intentos = (item.intentos || 0) + 1;
            const motivo = res.reason_code || res.error || ('exit ' + res.exit);
            if (intentos >= (o.maxIntentos || MAX_INTENTOS_COLA)) {
              escribirAtomico(hecho, Object.assign({}, item, { intentos, result: Object.assign({}, res, { status: 'ABANDONADA', ultimo_motivo: motivo }), done_at: new Date().toISOString() }));
            } else {
              escribirAtomico(path.join(dirCola(root), item.sha + '.json'), Object.assign({}, item, { intentos, ultimo_motivo: motivo, next_attempt_at: new Date(Date.now() + (o.backoffMs !== undefined ? o.backoffMs : esperaReintento(intentos))).toISOString() }));
              processed.push({ sha: item.sha, result: Object.assign({}, res, { reintento: intentos }) });
              continue; // sigue en la cola
            }
          } else {
            escribirAtomico(hecho, Object.assign({}, item, { result: res, done_at: new Date().toISOString() }));
          }
          processed.push({ sha: item.sha, result: res });
        }
        try { fs.unlinkSync(path.join(dirCola(root), item.sha + '.json')); } catch { /* ya no está */ }
      }
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* */ }
    try { fs.unlinkSync(lockPath); } catch { /* */ }
  }
  // Un commit encolado justo después de la última lectura (con el worker nuevo rechazado por este lock) quedaba varado hasta el
  // siguiente commit: se vuelve a mirar la cola ya con el lock suelto.
  let resto = 0;
  try { resto = fs.readdirSync(dirCola(root)).filter((f) => f.endsWith('.json')).length; } catch { /* sin cola */ }
  return { ok: true, processed, resto };
}

/** Qué hay en la cola y qué no llegó a registrarse (para `hook-runner.cjs estado` y el diagnóstico). */
function estadoCola(root) {
  const leerDir = (d) => { try { return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } }).filter(Boolean); } catch { return []; } };
  const cola = leerDir(dirCola(root)); const hechos = leerDir(dirHechos(root));
  return {
    pendientes: cola.length, hechos: hechos.length,
    enEspera: cola.filter((i) => i.next_attempt_at).map((i) => ({ sha: i.sha, intentos: i.intentos || 0, motivo: i.ultimo_motivo || '?' })),
    abandonados: hechos.filter((i) => i.result && i.result.status === 'ABANDONADA').map((i) => ({ sha: i.sha, motivo: i.result.ultimo_motivo || '?' })),
    sinComprobar: hechos.filter((i) => i.result && i.result.status === 'PASS' && i.result.verificado === false).length,
  };
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
  if (cmd === 'drain') {
    const r = drenar(root);
    // Quedó algo en la cola (llegó mientras drenábamos, o está en espera de reintento): un solo relevo, sin bucles.
    if (r && r.resto > 0 && !r.busy && process.env.AKDD_HOOK_NO_WORKER !== '1' && (r.processed || []).length > 0) lanzarWorker(root);
    return 0;
  }
  if (cmd === 'estado') {
    const e = estadoCola(root);
    console.log('Cola de commits: ' + e.pendientes + ' pendiente(s) · ' + e.hechos + ' hecho(s) · ' + e.abandonados.length + ' abandonado(s) · ' + e.sinComprobar + ' PASS sin comprobar en la base');
    for (const a of e.abandonados.slice(0, 10)) console.log('  ABANDONADO ' + a.sha.slice(0, 7) + ': ' + a.motivo);
    for (const p of e.enEspera.slice(0, 10)) console.log('  EN ESPERA  ' + p.sha.slice(0, 7) + ' (intento ' + p.intentos + '): ' + p.motivo);
    return 0;
  }
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

module.exports = { preCommit, commitMsg, encolar, drenar, main, POLITICA, leerMensaje, estadoCola, areaDe, asuntoDe, lanzarWorker };
