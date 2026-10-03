'use strict';

/**
 * Puntos de restauración reales del código, por actividad.
 *
 * Un punto es un commit de Git fuera de cualquier rama (refs/agentix/restore/<id>)
 * más un manifiesto inmutable (refs/agentix/restore-manifest/<id>, blob). Se
 * construye con un index temporal: HEAD, rama e index de la persona no se
 * tocan, y nada se empuja al remoto. Los blobs se guardan con --no-filters:
 * se recuperan los bytes exactos del working tree, no la versión normalizada.
 *
 * Restaurar = preview (qué se escribe/borra, qué no vuelve) → hash esperado →
 * punto de rescate → apply por journal → verificación por hash. Nunca reset,
 * clean ni checkout global.
 *
 * Sin Git: UNSUPPORTED. No se fingen puntos con metadatos.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCHEMA_VERSION = 1;
const REF_PUNTO = 'refs/agentix/restore/';
const REF_MANIFIESTO = 'refs/agentix/restore-manifest/';
const TIPOS = ['BASELINE', 'AFTER_VERIFIED', 'AFTER_UNVERIFIED', 'RESCATE', 'MANUAL'];
const POLITICA_DEFECTO = {
  schema_version: 1, rollback_automatico: false, max_rollback_por_intento: 1, max_rollback_por_tarea: 2,
  max_archivo_bytes: 5 * 1024 * 1024, untracked_allow: [], excluir: [], zona_horaria: null, reintentos_captura: 2,
};
const SECRETO = /(^|\/)(\.env(\.[\w.-]+)?|secrets?\.[\w]+|[^/]+\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?|\.npmrc|credentials(\.json)?)$/i;
const SIEMPRE_FUERA = /^(\.git\/|node_modules\/|\.agentic\/memoria\.db|\.agentic\/_[\w-]+\/|\.agentic\/efectos\.jsonl)/i;
const IDENTIDAD = { GIT_AUTHOR_NAME: 'agentix-restore', GIT_AUTHOR_EMAIL: 'restore@agentix.local', GIT_COMMITTER_NAME: 'agentix-restore', GIT_COMMITTER_EMAIL: 'restore@agentix.local' };

// ─── git y utilidades ────────────────────────────────────────────────────────

function git(root, args, { env, input } = {}) {
  const r = spawnSync('git', args, { cwd: root, env: Object.assign({}, process.env, env || {}), input, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (r.error) return { ok: false, stdout: Buffer.alloc(0), stderr: r.error.message };
  return { ok: r.status === 0, stdout: r.stdout || Buffer.alloc(0), stderr: r.stderr ? r.stderr.toString('utf8') : '' };
}
const txt = (r) => r.stdout.toString('utf8').trim();
const posix = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const dirRestore = (root) => path.join(root, '.agentic', '_restore');
const journalPath = (root) => path.join(dirRestore(root), 'journal.jsonl');

function errorR(code, detalle, extra) {
  return Object.assign({ status: code, detalle: detalle || null }, extra || {});
}

function escribirAtomico(f, contenido, modo) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = path.join(path.dirname(f), '.' + path.basename(f) + '.akdd-' + process.pid + '-' + Date.now() + '.tmp');
  fs.writeFileSync(tmp, contenido);
  if (modo) { try { fs.chmodSync(tmp, modo); } catch { /* Windows: el bit de ejecución no aplica */ } }
  fs.renameSync(tmp, f);
}

function anotar(root, ev) {
  fs.mkdirSync(dirRestore(root), { recursive: true });
  fs.appendFileSync(journalPath(root), JSON.stringify(Object.assign({ at: new Date().toISOString() }, ev)) + '\n');
}
function journal(root) {
  try { return fs.readFileSync(journalPath(root), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

function politica(root) {
  try { return Object.assign({}, POLITICA_DEFECTO, JSON.parse(fs.readFileSync(path.join(root, '.agentic', 'restore-policy.json'), 'utf8'))); }
  catch { return Object.assign({}, POLITICA_DEFECTO); }
}

/** Repositorio, raíz de Git y prefijo del proyecto dentro de ella. */
function contexto(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return null;
  /* Windows: os.tmpdir() puede dar nombres cortos 8.3 y Git el largo; se comparan rutas canónicas. */
  const canon = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const topDir = canon(txt(top));
  const fmt = git(root, ['rev-parse', '--show-object-format']);
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  const prefijo = posix(path.relative(topDir, canon(root)));
  if (prefijo.startsWith('..') || path.isAbsolute(prefijo)) return null;
  return {
    top: topDir, prefijo,
    formato: fmt.ok && txt(fmt) === 'sha256' ? 'sha256' : 'sha1', head: head.ok ? txt(head) : null,
  };
}
const aGit = (ctx, rel) => (ctx.prefijo ? ctx.prefijo + '/' : '') + rel;

function disponible(root) { return !!contexto(root); }

/* Git puede existir y negarse a operar; decirlo con su causa evita que se lea como "no hay Git". */
function motivoSinGit(root) {
  const r = git(root, ['rev-parse', '--show-toplevel']);
  if (r.ok) return 'la carpeta queda fuera del repositorio Git';
  if (/dubious ownership/i.test(r.stderr)) return 'Git rechaza el repositorio por propiedad dudosa (safe.directory); no se cambia sola la configuración global';
  if (/not a git repository/i.test(r.stderr)) return 'sin repositorio Git';
  return 'Git no disponible: ' + String(r.stderr).split('\n')[0];
}

function hashBlob(buf, formato) {
  return crypto.createHash(formato).update(Buffer.concat([Buffer.from('blob ' + buf.length + '\0'), buf])).digest('hex');
}

/* En Windows el sistema de archivos no tiene bit de ejecución: el modo lo dice Git, no el disco. */
const SIN_BIT_EJECUCION = process.platform === 'win32';
function modoDe(st) { return SIN_BIT_EJECUCION ? null : st.mode & 0o111 ? '100755' : '100644'; }

function modosIndex(root, ctx) {
  const r = git(root, ['ls-files', '-s', '-z', '--', '.']);
  const out = {};
  if (!r.ok) return out;
  for (const l of r.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const [meta, ruta] = l.split('\t');
    let rel = posix(ruta);
    if (ctx.prefijo && rel.startsWith(ctx.prefijo + '/')) rel = rel.slice(ctx.prefijo.length + 1);
    out[rel] = meta.split(' ')[0];
  }
  return out;
}

/** ¿La ruta cae dentro del proyecto sin pasar por enlaces ni junctions? */
function rutaSegura(root, rel) {
  const r = posix(rel);
  if (!r || path.isAbsolute(r) || /^[a-z]:/i.test(r) || r.split('/').some((s) => s === '..' || s === '') || r.includes(':')) return 'RUTA_INVALIDA';
  const base = fs.realpathSync(root);
  let actual = path.resolve(root);
  for (const parte of r.split('/')) {
    actual = path.join(actual, parte);
    let st;
    try { st = fs.lstatSync(actual); } catch { break; }
    if (st.isSymbolicLink()) return 'ENLACE_O_JUNCTION';
  }
  let existente = path.resolve(root, r);
  while (!fs.existsSync(existente)) existente = path.dirname(existente);
  const real = fs.realpathSync(existente);
  if (real !== base && !real.startsWith(base + path.sep)) return 'ESCAPE_DEL_PROYECTO';
  return null;
}

function leerActual(root, rel, formato) {
  const f = path.join(root, rel);
  let st;
  try { st = fs.lstatSync(f); } catch { return { existe: false }; }
  if (st.isSymbolicLink()) return { existe: true, enlace: true };
  if (!st.isFile()) return { existe: true, noArchivo: true };
  const buf = fs.readFileSync(f);
  return { existe: true, sha: hashBlob(buf, formato), modo: modoDe(st), bytes: buf.length };
}

function zona(root, pol) {
  if (pol.zona_horaria) return pol.zona_horaria;
  try {
    const m = /zona[ _]horaria\s*[:=]\s*\**\s*([A-Za-z_]+\/[A-Za-z_]+)/i.exec(fs.readFileSync(path.join(root, '.agentic', 'config.md'), 'utf8'));
    if (m) return m[1];
  } catch { /* sin config */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function horaLocal(iso, tz) {
  const d = new Date(iso);
  const partes = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
  let offset = '';
  try { offset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(d).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00'; } catch { /* sin offset */ }
  return { local: partes.replace(',', ''), zona: tz, offset };
}

// ─── alcance y exclusiones ───────────────────────────────────────────────────

function lsFiles(root, args) {
  const r = git(root, ['ls-files', '-z', ...args]);
  return r.ok ? r.stdout.toString('utf8').split('\0').filter(Boolean).map(posix) : [];
}

function coincide(rel, patrones) {
  return (patrones || []).some((p) => {
    const re = new RegExp('^' + String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$', 'i');
    return re.test(rel);
  });
}

/**
 * Alcance explícito (archivos de una tarea) o, si no se da, lo rastreado por
 * Git. Lo no rastreado solo entra si se nombró o si la política lo permite.
 */
function resolverAlcance(root, ctx, archivos, pol) {
  const explicito = Array.isArray(archivos) && archivos.length > 0;
  const rastreados = new Set(lsFiles(root, ['--', '.']).map((f) => (ctx.prefijo && f.startsWith(ctx.prefijo + '/') ? f.slice(ctx.prefijo.length + 1) : f)));
  const candidatos = explicito ? archivos.map(posix) : [...rastreados];
  const noRastreados = explicito ? [] : lsFiles(root, ['-o', '--exclude-standard', '--', '.']);
  if (!explicito) for (const f of noRastreados) if (coincide(f, pol.untracked_allow)) candidatos.push(f);
  const alcance = [];
  const excluidos = [];
  for (const rel of [...new Set(candidatos)].sort()) {
    const inseguro = rutaSegura(root, rel);
    if (inseguro) { excluidos.push({ path: rel, motivo: inseguro }); continue; }
    if (SIEMPRE_FUERA.test(rel)) { excluidos.push({ path: rel, motivo: 'POLITICA_INTERNA' }); continue; }
    if (SECRETO.test(rel) || coincide(rel, pol.excluir)) { excluidos.push({ path: rel, motivo: SECRETO.test(rel) ? 'SECRETO' : 'POLITICA' }); continue; }
    try {
      const st = fs.lstatSync(path.join(root, rel));
      if (st.isSymbolicLink()) { excluidos.push({ path: rel, motivo: 'ENLACE_O_JUNCTION' }); continue; }
      if (st.isFile() && st.size > pol.max_archivo_bytes) { excluidos.push({ path: rel, motivo: 'GRANDE' }); continue; }
    } catch { /* no existe ahora: se registra como ausente */ }
    alcance.push(rel);
  }
  const noCapturados = explicito ? [] : noRastreados.filter((f) => !alcance.includes(f) && !excluidos.some((e) => e.path === f));
  return { alcance, excluidos, explicito, no_capturados: noCapturados };
}

// ─── puntos ──────────────────────────────────────────────────────────────────

function nuevoId() {
  return 'rp-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + crypto.randomBytes(2).toString('hex');
}

function leerManifiesto(root, id) {
  const r = git(root, ['cat-file', 'blob', REF_MANIFIESTO + id]);
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout.toString('utf8')); } catch { return null; }
}

function disponibles(root) {
  const hechos = new Set(journal(root).filter((e) => e.op === 'create' && e.fase === 'disponible').map((e) => e.id));
  const refs = git(root, ['for-each-ref', '--format=%(refname)', REF_MANIFIESTO]);
  if (!refs.ok) return [];
  return txt(refs).split('\n').filter(Boolean).map((r) => r.slice(REF_MANIFIESTO.length))
    .filter((id) => hechos.has(id) && git(root, ['rev-parse', '--verify', '-q', REF_PUNTO + id]).ok)
    .map((id) => leerManifiesto(root, id)).filter(Boolean)
    .sort((a, b) => a.created_utc.localeCompare(b.created_utc) || a.point_id.localeCompare(b.point_id));
}

function huellaArchivos(files) {
  return crypto.createHash('sha256').update(JSON.stringify(Object.keys(files).sort().map((k) => [k, files[k]]))).digest('hex');
}

function capturarEstado(root, alcance, formato, modos) {
  const files = {};
  for (const rel of alcance) {
    const a = leerActual(root, rel, formato);
    files[rel] = a.existe && a.sha ? { exists: true, sha: a.sha, mode: a.modo || (modos && modos[rel]) || '100644' } : { exists: false };
  }
  return files;
}

/**
 * Crea un punto. Captura con revalidación: hash antes, blobs, hash después;
 * si algo cambió mientras se capturaba, reintenta y si sigue cambiando el
 * punto queda UNVERIFIED (nunca VERIFIED por haberse podido guardar).
 */
function crear(root, o = {}) {
  const ctx = contexto(root);
  if (!ctx) return errorR('UNSUPPORTED', motivoSinGit(root) + ' — no hay puntos recuperables');
  const tipo = TIPOS.includes(o.tipo) ? o.tipo : 'MANUAL';
  const pol = politica(root);
  const sel = resolverAlcance(root, ctx, o.archivos, pol);
  const ultimo = disponibles(root).filter((p) => p.task_id === (o.task_id || null) && p.kind === tipo && JSON.stringify(p.scope) === JSON.stringify(sel.alcance)).pop();
  let files;
  let consistente = false;
  let blobs = {};
  const modos = SIN_BIT_EJECUCION ? modosIndex(root, ctx) : null;
  for (let intento = 0; intento <= pol.reintentos_captura && !consistente; intento++) {
    files = capturarEstado(root, sel.alcance, ctx.formato, modos);
    const presentes = sel.alcance.filter((f) => files[f].exists);
    blobs = {};
    if (presentes.length) {
      const w = git(root, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: presentes.join('\n') + '\n' });
      if (!w.ok) return errorR('ERROR', 'no se pudieron guardar los blobs: ' + w.stderr);
      txt(w).split('\n').forEach((sha, i) => { blobs[presentes[i]] = sha.trim(); });
    }
    if (typeof o.alCapturar === 'function') o.alCapturar(intento);
    const despues = capturarEstado(root, sel.alcance, ctx.formato, modos);
    consistente = presentes.every((f) => blobs[f] === files[f].sha) && huellaArchivos(despues) === huellaArchivos(files);
  }
  const subject = huellaArchivos(files);
  if (ultimo && ultimo.subject_hash === subject && ultimo.base_head === ctx.head && consistente) {
    return { status: 'OK', deduplicado: true, punto: resumen(root, ultimo) };
  }
  const id = nuevoId();
  anotar(root, { op: 'create', id, fase: 'inicio', kind: tipo, task_id: o.task_id || null });
  const idx = path.join(os.tmpdir(), 'akdd-idx-' + id + '-' + process.pid);
  const env = Object.assign({ GIT_INDEX_FILE: idx }, IDENTIDAD);
  try {
    const rt = ctx.head ? git(root, ['read-tree', ctx.head], { env }) : git(root, ['read-tree', '--empty'], { env });
    if (!rt.ok) return errorR('ERROR', rt.stderr);
    const nulo = ctx.formato === 'sha256' ? '0'.repeat(64) : '0'.repeat(40);
    const info = sel.alcance.map((f) => (files[f].exists ? `${files[f].mode} ${blobs[f] || files[f].sha}\t${aGit(ctx, f)}` : `0 ${nulo}\t${aGit(ctx, f)}`)).join('\n');
    if (info) {
      const ui = git(root, ['update-index', '--index-info'], { env, input: info + '\n' });
      if (!ui.ok) return errorR('ERROR', ui.stderr);
    }
    const tree = git(root, ['write-tree'], { env });
    if (!tree.ok) return errorR('ERROR', tree.stderr);
    const ct = git(root, ['commit-tree', txt(tree), ...(ctx.head ? ['-p', ctx.head] : []), '-m', 'agentix restore point ' + id], { env });
    if (!ct.ok) return errorR('ERROR', ct.stderr);
    const commit = txt(ct);
    const cambios = ctx.head ? txt(git(root, ['diff-tree', '-r', '-M', '--name-status', ctx.head, commit])).split('\n').filter(Boolean).map((l) => {
      const [st, a, b] = l.split('\t');
      return { status: st, path: posix(b || a), from: b ? posix(a) : null };
    }) : [];
    /* Releer lo guardado: el punto vale por lo que se puede recuperar, no por haberse escrito. */
    const releido = sel.alcance.every((f) => {
      if (!files[f].exists) return !git(root, ['cat-file', '-e', commit + ':' + aGit(ctx, f)]).ok;
      return txt(git(root, ['rev-parse', commit + ':' + aGit(ctx, f)])) === blobs[f];
    });
    const excluidosEnAlcance = sel.explicito ? sel.excluidos : sel.excluidos.filter((e) => e.motivo !== 'POLITICA_INTERNA');
    const estado = !consistente || !releido ? 'UNVERIFIED' : excluidosEnAlcance.length ? 'PARTIAL' : 'VERIFIED';
    const ahora = new Date().toISOString();
    const dirty = git(root, ['status', '--porcelain=v1', '-z', '--', '.']);
    const manifiesto = {
      schema_version: SCHEMA_VERSION, project_id: crypto.createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16),
      point_id: id, kind: tipo, label: String(o.label || '').slice(0, 200), task_id: o.task_id || null, sprint_id: o.sprint_id || null,
      attempt: o.attempt || null, parent_point: ultimo ? ultimo.point_id : null, created_utc: ahora, base_head: ctx.head, commit,
      scope: sel.alcance, scope_explicito: sel.explicito, files, excluded: sel.excluidos, no_capturados: sel.no_capturados,
      cambios_vs_head: cambios, dirty_baseline: dirty.ok ? dirty.stdout.toString('utf8').split('\0').filter(Boolean) : [],
      subject_hash: subject, state: estado, motivo_estado: !consistente ? 'CAMBIO_DURANTE_CAPTURA' : !releido ? 'RELECTURA_FALLIDA' : excluidosEnAlcance.length ? 'ARCHIVOS_EXCLUIDOS' : null,
      side_effects: Array.isArray(o.side_effects) ? o.side_effects : [], evidence: o.evidence || [],
    };
    const mb = git(root, ['hash-object', '-w', '--stdin'], { input: JSON.stringify(manifiesto) });
    if (!mb.ok) return errorR('ERROR', mb.stderr);
    if (!git(root, ['update-ref', REF_MANIFIESTO + id, txt(mb)]).ok || !git(root, ['update-ref', REF_PUNTO + id, commit]).ok) return errorR('ERROR', 'no se pudo crear la ref privada');
    anotar(root, { op: 'create', id, fase: 'disponible', state: estado });
    evento(root, 'CREATE_' + tipo, estado, id);
    return { status: 'OK', deduplicado: false, punto: resumen(root, manifiesto) };
  } finally {
    try { fs.unlinkSync(idx); } catch { /* no se creó */ }
  }
}

function resumen(root, m) {
  const tz = zona(root, politica(root));
  return {
    id: m.point_id, utc: m.created_utc, ...horaLocal(m.created_utc, tz), kind: m.kind, label: m.label, task_id: m.task_id, sprint_id: m.sprint_id,
    state: m.state, motivo_estado: m.motivo_estado, alcance: m.scope.length, excluidos: m.excluded.length, invalidado: invalidacion(root, m.point_id),
  };
}

function invalidacion(root, id) {
  const e = journal(root).filter((x) => x.op === 'invalidate' && x.id === id).pop();
  return e ? e.motivo : null;
}

function listar(root) {
  if (!contexto(root)) return errorR('UNSUPPORTED', motivoSinGit(root));
  return { status: 'OK', puntos: disponibles(root).map((m) => resumen(root, m)), incompletos: incompletos(root) };
}

function incompletos(root) {
  const j = journal(root).filter((e) => e.op === 'create');
  const hechos = new Set(j.filter((e) => e.fase === 'disponible').map((e) => e.id));
  return [...new Set(j.filter((e) => e.fase === 'inicio' && !hechos.has(e.id)).map((e) => e.id))];
}

function mostrar(root, ref) {
  const r = resolverReferencia(root, ref);
  if (r.status !== 'OK') return r;
  return { status: 'OK', manifiesto: r.manifiesto, resumen: resumen(root, r.manifiesto) };
}

/** Un punto con un bug crítico conocido deja de ofrecerse como válido. */
function invalidar(root, id, motivo) {
  if (!leerManifiesto(root, id)) return errorR('PUNTO_DESCONOCIDO');
  anotar(root, { op: 'invalidate', id, motivo: String(motivo || 'sin motivo').slice(0, 200) });
  return { status: 'OK' };
}

/**
 * ID exacto = autoridad. Fecha + hora única también; fecha sola u hora que
 * se repite piden elegir. El texto recibido nunca llega a un shell.
 */
function resolverReferencia(root, ref) {
  const s = String(ref || '').trim();
  if (!/^[\w:.\- +]{1,40}$/.test(s)) return errorR('REFERENCIA_INVALIDA');
  const puntos = disponibles(root);
  const exacto = puntos.find((p) => p.point_id === s);
  if (exacto) return { status: 'OK', manifiesto: exacto };
  if (/^rp-/.test(s)) {
    const pref = puntos.filter((p) => p.point_id.startsWith(s));
    if (pref.length === 1) return { status: 'OK', manifiesto: pref[0] };
    return pref.length ? errorR('SELECCION_REQUERIDA', 'prefijo ambiguo', { candidatos: pref.map((p) => resumen(root, p)) }) : errorR('PUNTO_DESCONOCIDO');
  }
  const tz = zona(root, politica(root));
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?$/.exec(s) || /^()(\d{2}:\d{2})$/.exec(s);
  if (!m) return errorR('REFERENCIA_INVALIDA');
  const candidatos = puntos.filter((p) => {
    const l = horaLocal(p.created_utc, tz).local;
    return (!m[1] || l.startsWith(m[1])) && (!m[2] || l.slice(11, 16) === m[2]);
  });
  if (!candidatos.length) return errorR('PUNTO_DESCONOCIDO');
  if (m[1] && m[2] && candidatos.length === 1) return { status: 'OK', manifiesto: candidatos[0] };
  return errorR('SELECCION_REQUERIDA', m[1] && m[2] ? 'varios puntos en esa hora' : 'fecha u hora sola: elige un id', { candidatos: candidatos.map((p) => resumen(root, p)), zona: tz });
}

// ─── preview y apply ─────────────────────────────────────────────────────────

function hashActual(root, archivos, formato) {
  const h = crypto.createHash('sha256');
  for (const f of [...archivos].sort()) {
    const a = leerActual(root, f, formato);
    h.update(f + '\0' + (a.existe ? a.sha || 'X' : '-') + '\0' + (a.modo || '') + '\0');
  }
  return h.digest('hex');
}

/**
 * Qué haría restaurar este punto. `soloArchivos` limita el alcance (rollback
 * de una tarea). No escribe nada.
 */
function preview(root, ref, { soloArchivos = null } = {}) {
  const ctx = contexto(root);
  if (!ctx) return errorR('UNSUPPORTED');
  const r = resolverReferencia(root, ref);
  if (r.status !== 'OK') return r;
  const m = r.manifiesto;
  const motivosBloqueo = [];
  const decisiones = [];
  const inv = invalidacion(root, m.point_id);
  if (inv) motivosBloqueo.push('PUNTO_INVALIDADO: ' + inv);
  if (m.state === 'UNVERIFIED') motivosBloqueo.push('PUNTO_NO_VERIFICADO: ' + m.motivo_estado);
  const alcance = (soloArchivos ? m.scope.filter((f) => soloArchivos.map(posix).includes(f)) : m.scope);
  const ops = [];
  for (const f of alcance) {
    const seguro = rutaSegura(root, f);
    if (seguro) { motivosBloqueo.push(seguro + ': ' + f); continue; }
    const objetivo = m.files[f];
    const actual = leerActual(root, f, ctx.formato);
    if (actual.enlace || actual.noArchivo) { motivosBloqueo.push('NO_ES_ARCHIVO: ' + f); continue; }
    if (objetivo.exists) {
      if (!git(root, ['cat-file', '-e', objetivo.sha]).ok) { motivosBloqueo.push('BLOB_AUSENTE: ' + f); continue; }
      if (!actual.existe || actual.sha !== objetivo.sha) ops.push({ op: 'WRITE', path: f, sha: objetivo.sha, mode: objetivo.mode, pre: actual.existe ? actual.sha : null });
      else if (actual.modo && actual.modo !== objetivo.mode) ops.push({ op: 'CHMOD', path: f, sha: objetivo.sha, mode: objetivo.mode, pre: actual.sha });
    } else if (actual.existe) {
      ops.push({ op: 'DELETE', path: f, pre: actual.sha });
    }
  }
  const tocados = ops.map((o) => o.path);
  if (tocados.length) {
    try {
      const pf = require('./protected-files.cjs').verificar(root, tocados, { accion: 'restore' });
      if (pf.status === 'FAIL') motivosBloqueo.push('PROTEGIDO: ' + pf.blocked.map((b) => b.file || b).join(', '));
      if (pf.status === 'ERROR') motivosBloqueo.push('MANIFIESTO_PROTEGIDOS_ERROR');
    } catch { /* sin manifiesto: nada protegido */ }
  }
  /* Trabajo posterior: puntos más nuevos de otra tarea que tocan los mismos archivos. */
  const posteriores = disponibles(root).filter((p) => p.created_utc > m.created_utc && p.point_id !== m.point_id && p.kind !== 'RESCATE'
    && p.scope.some((f) => tocados.includes(f)));
  const ajenos = posteriores.filter((p) => p.task_id !== m.task_id);
  if (ajenos.length) decisiones.push('TRABAJO_POSTERIOR_DE_OTRA_ACTIVIDAD: ' + [...new Set(ajenos.map((p) => p.task_id || p.label || p.point_id))].join(', '));
  /* Contenido actual que ningún punto registró: puede ser de otra persona. */
  for (const f of tocados) {
    const ultimoConF = posteriores.filter((p) => p.files[f]).pop();
    if (!ultimoConF) continue;
    const a = leerActual(root, f, ctx.formato);
    const reg = ultimoConF.files[f];
    if ((reg.exists ? reg.sha : null) !== (a.existe ? a.sha : null)) decisiones.push('CAMBIOS_SIN_PUNTO: ' + f);
  }
  const status = motivosBloqueo.length ? 'BLOQUEADO' : decisiones.length ? 'REQUIERE_DECISION' : ops.length ? 'LISTO' : 'SIN_CAMBIOS';
  /* Lo que pasó fuera del código después del punto: restaurar no lo deshace. */
  let posterioresFuera = [];
  try { posterioresFuera = require('./efectos.cjs').pendientesDesde(root, m.created_utc); } catch { /* sin diario de efectos */ }
  return {
    status, point_id: m.point_id, kind: m.kind, task_id: m.task_id, ops, motivos: motivosBloqueo, decisiones,
    excluidos: m.excluded, no_capturados: m.no_capturados || [],
    efectos_externos_no_revertibles: (m.side_effects || []).concat(posterioresFuera.map((e) => ({
      id: e.id, tipo: e.tipo, recurso_id: e.recurso_id, tenant: e.tenant || null, reversible: e.reversible, compensacion: e.compensacion || null, at: e.at,
    }))),
    trabajo_posterior: posteriores.map((p) => ({ id: p.point_id, task_id: p.task_id, kind: p.kind })),
    expected_current_hash: hashActual(root, tocados, ctx.formato),
    nota: 'Restaurar devuelve código del alcance; no revierte bases de datos, migraciones, despliegues, pagos ni mensajes.',
  };
}

function aplicarOps(root, ops, journalId, { desde = 0, inyectarFallo } = {}) {
  for (let i = desde; i < ops.length; i++) {
    const o = ops[i];
    if (inyectarFallo && inyectarFallo(i, o)) throw Object.assign(new Error('fallo inyectado en ' + o.path), { code: 'INYECTADO' });
    const f = path.join(root, o.path);
    if (o.op === 'DELETE') { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    else {
      const blob = git(root, ['cat-file', 'blob', o.sha]);
      if (!blob.ok) throw new Error('blob ausente ' + o.sha);
      escribirAtomico(f, blob.stdout, o.mode === '100755' ? 0o755 : 0o644);
    }
    anotar(root, { op: 'apply-step', apply: journalId, i, path: o.path });
  }
}

function verificarOps(root, ops, formato) {
  return ops.filter((o) => {
    const a = leerActual(root, o.path, formato);
    if (o.op === 'DELETE') return a.existe;
    return !a.existe || a.sha !== o.sha;
  }).map((o) => o.path);
}

/**
 * Aplica un punto. Exige el hash del preview (nada cambió desde que la
 * persona lo revisó) y una decisión explícita si el preview la pidió. Antes
 * de escribir guarda un punto de rescate; si algo falla, vuelve a él. Si
 * tampoco se puede volver, es un incidente: nunca se declara éxito.
 */
function aplicar(root, ref, { expected_current_hash, confirmar_decision = false, soloArchivos = null, origen = 'manual', inyectarFallo, inyectarFalloRescate, task_id = null } = {}) {
  const ctx = contexto(root);
  if (!ctx) return errorR('UNSUPPORTED');
  const p = preview(root, ref, { soloArchivos });
  if (!p.point_id) return p;
  if (p.status === 'BLOQUEADO') return Object.assign(errorR('BLOQUEADO'), { motivos: p.motivos });
  if (p.status === 'SIN_CAMBIOS') return { status: 'SIN_CAMBIOS', point_id: p.point_id };
  if (!expected_current_hash || expected_current_hash !== p.expected_current_hash) return errorR('HASH_CAMBIO_DESDE_PREVIEW', 'el alcance cambió desde el preview: revisa de nuevo', { preview: p });
  if (p.status === 'REQUIERE_DECISION' && !confirmar_decision) return Object.assign(errorR('REQUIERE_DECISION'), { decisiones: p.decisiones });
  const tocados = p.ops.map((o) => o.path);
  const rescate = crear(root, { tipo: 'RESCATE', archivos: tocados, label: 'rescate antes de restaurar ' + p.point_id, task_id });
  if (rescate.status !== 'OK' || rescate.punto.state !== 'VERIFIED') return errorR('SIN_PUNTO_DE_RESCATE', 'no se aplicó nada', { rescate });
  const applyId = 'ap-' + crypto.randomUUID().slice(0, 12);
  const plan = { apply: applyId, point_id: p.point_id, rescate: rescate.punto.id, ops: p.ops, origen, task_id };
  anotar(root, { op: 'apply', fase: 'preparado', ...plan });
  try {
    aplicarOps(root, p.ops, applyId, { inyectarFallo });
    const mal = verificarOps(root, p.ops, ctx.formato);
    if (mal.length) throw new Error('hash distinto tras escribir: ' + mal.join(', '));
  } catch (e) {
    return recuperar(root, plan, ctx, e.message, inyectarFalloRescate);
  }
  anotar(root, { op: 'apply', fase: 'completado', apply: applyId, point_id: p.point_id });
  evento(root, 'APPLY', 'OK', p.point_id);
  const revertidas = revertirTareas(root, tocados, p.point_id);
  return {
    status: 'RESTAURADO', point_id: p.point_id, rescate: rescate.punto.id, escritos: p.ops.filter((o) => o.op !== 'DELETE').length,
    borrados: p.ops.filter((o) => o.op === 'DELETE').length, recuperacion: p.efectos_externos_no_revertibles.length ? 'SOLO_CODIGO' : 'CODIGO',
    efectos_externos_no_revertidos: p.efectos_externos_no_revertibles, tareas_revertidas: revertidas,
    sistema_restaurado: p.efectos_externos_no_revertibles.length === 0 ? null : false,
    pendiente: 'correr los gates del alcance: el contenido volvió, la verificación no viene incluida',
  };
}

/** Vuelta al punto de rescate tras un apply fallido. */
function recuperar(root, plan, ctx, causa, inyectarFallo) {
  const m = leerManifiesto(root, plan.rescate);
  const ops = plan.ops.map((o) => {
    const r = m && m.files[o.path];
    return r && r.exists ? { op: 'WRITE', path: o.path, sha: r.sha, mode: r.mode } : { op: 'DELETE', path: o.path };
  });
  try {
    aplicarOps(root, ops, plan.apply + '-rescate', { inyectarFallo });
    const mal = verificarOps(root, ops, ctx.formato);
    if (mal.length) throw new Error('rescate incompleto: ' + mal.join(', '));
    anotar(root, { op: 'apply', fase: 'revertido', apply: plan.apply, causa });
    evento(root, 'APPLY', 'FALLO_RECUPERADO', plan.point_id);
    return errorR('FALLO_RECUPERADO', causa, { rescate: plan.rescate, nota: 'el alcance volvió al estado previo al intento' });
  } catch (e2) {
    anotar(root, { op: 'apply', fase: 'incidente', apply: plan.apply, causa, causa_rescate: e2.message });
    evento(root, 'APPLY', 'INCIDENTE', plan.point_id);
    const archivos = plan.ops.map((o) => o.path);
    if (plan.task_id) { try { require('./teams-manager.cjs').restauracionFallida(root, { task_id: plan.task_id, files: archivos, detalle: e2.message }); } catch { /* sin TEAMS */ } }
    return errorR('INCIDENTE', 'ni el apply ni el rescate quedaron verificados: estado desconocido en ' + archivos.join(', '), { causa, causa_rescate: e2.message, rescate: plan.rescate, archivos });
  }
}

/**
 * Tras un reinicio: retoma applies a medias sin repetir a ciegas. Cada paso
 * se decide por el hash actual: ya aplicado → se salta; igual al de antes →
 * se aplica; otro → incidente.
 */
function reanudar(root) {
  const ctx = contexto(root);
  if (!ctx) return errorR('UNSUPPORTED');
  const j = journal(root).filter((e) => e.op === 'apply');
  const cerrados = new Set(j.filter((e) => ['completado', 'revertido', 'incidente'].includes(e.fase)).map((e) => e.apply));
  const abiertos = j.filter((e) => e.fase === 'preparado' && !cerrados.has(e.apply));
  const out = [];
  for (const plan of abiertos) {
    const pendientes = [];
    let desconocido = null;
    for (const o of plan.ops) {
      const a = leerActual(root, o.path, ctx.formato);
      const yaHecho = o.op === 'DELETE' ? !a.existe : a.existe && a.sha === o.sha;
      if (yaHecho) continue;
      if ((a.existe ? a.sha : null) === o.pre) pendientes.push(o);
      else { desconocido = o.path; break; }
    }
    if (desconocido) { out.push(recuperar(root, plan, ctx, 'estado desconocido tras reinicio en ' + desconocido)); continue; }
    try {
      aplicarOps(root, pendientes, plan.apply);
      const mal = verificarOps(root, plan.ops, ctx.formato);
      if (mal.length) throw new Error('hash distinto: ' + mal.join(', '));
      anotar(root, { op: 'apply', fase: 'completado', apply: plan.apply, point_id: plan.point_id, reanudado: true });
      out.push({ status: 'RESTAURADO', apply: plan.apply, point_id: plan.point_id, reanudado: true, pasos_aplicados: pendientes.length });
    } catch (e) {
      out.push(recuperar(root, plan, ctx, e.message));
    }
  }
  return { status: 'OK', reanudados: out };
}

function revertirTareas(root, archivos, pointId) {
  try {
    const tm = require('./teams-manager.cjs');
    if (!tm.estado(root).inicializado) return [];
    return tm.invalidarPorRestore(root, { files: archivos, point_id: pointId });
  } catch { return []; }
}

function evento(root, gate, verdict, id) {
  try {
    const f = path.join(root, '.agentic', 'memoria.db');
    if (!fs.existsSync(f)) return;
    const db = require('./db-adapter.cjs').openWrite(f);
    try { require('./gate-telemetry.cjs').recordGateEvent(db, { gate: 'RESTORE_' + gate, verdict, file: id }); } finally { db.close(); }
  } catch { /* la línea de tiempo es informativa */ }
}

// ─── rollback automático (TEAMS) ─────────────────────────────────────────────

/**
 * Solo si todo esto es cierto: la política lo autoriza; la tarea tiene un
 * BASELINE completo; lo que hay ahora en su alcance es exactamente lo que ella
 * entregó; nadie más tocó esos archivos después; el fallo es reproducible; no
 * hay protegidos ni efectos externos; y no se pasó el tope de rollbacks.
 */
function elegibilidadRollback(root, { task_id, attempt = null, fallo_reproducible = false, side_effects = [] }) {
  const pol = politica(root);
  const motivos = [];
  if (!pol.rollback_automatico) motivos.push('POLITICA_NO_AUTORIZA');
  if (!fallo_reproducible) motivos.push('FALLO_NO_REPRODUCIBLE');
  if (side_effects.length) motivos.push('EFECTOS_EXTERNOS');
  const puntos = disponibles(root).filter((p) => p.task_id === task_id);
  const base = puntos.filter((p) => p.kind === 'BASELINE').pop();
  if (!base) motivos.push('SIN_BASELINE');
  else if (base.state !== 'VERIFIED') motivos.push('BASELINE_' + base.state);
  const despues = puntos.filter((p) => p.kind.startsWith('AFTER_')).pop();
  if (!despues) motivos.push('SIN_PUNTO_DE_ENTREGA');
  const ctx = contexto(root);
  if (base && despues && ctx) {
    for (const f of base.scope) {
      const a = leerActual(root, f, ctx.formato);
      const suyo = despues.files[f];
      if (!suyo || (suyo.exists ? suyo.sha : null) !== (a.existe ? a.sha : null)) { motivos.push('TRABAJO_AJENO_EN_ALCANCE: ' + f); break; }
    }
    const ajenos = disponibles(root).filter((p) => p.created_utc > base.created_utc && p.task_id !== task_id && p.kind !== 'RESCATE' && p.scope.some((f) => base.scope.includes(f)));
    if (ajenos.length) motivos.push('OTRA_TAREA_EN_EL_ALCANCE');
  }
  const previos = journal(root).filter((e) => e.op === 'rollback' && e.task_id === task_id && e.fase === 'ok');
  if (previos.length >= pol.max_rollback_por_tarea) motivos.push('TOPE_POR_TAREA');
  if (attempt != null && previos.filter((e) => e.attempt === attempt).length >= pol.max_rollback_por_intento) motivos.push('TOPE_POR_INTENTO');
  if (base && !motivos.length) {
    const p = preview(root, base.point_id);
    if (p.status === 'BLOQUEADO') motivos.push(...p.motivos);
    if (p.status === 'REQUIERE_DECISION') motivos.push(...p.decisiones);
  }
  return { elegible: motivos.length === 0, motivos, baseline: base ? base.point_id : null };
}

function rollbackAutomatico(root, o) {
  const e = elegibilidadRollback(root, o);
  const tm = (() => { try { return require('./teams-manager.cjs'); } catch { return null; } })();
  if (!e.elegible) {
    if (tm && o.task_id) {
      try {
        tm.stop(root, {
          reason_code: 'ROLLBACK_NO_ELEGIBLE', scope: 'DEPENDENCY_CHAIN', task_id: o.task_id, decision_required: true,
          evidence: [{ kind: 'rollback', motivos: e.motivos }], question: `No se puede revertir ${o.task_id} solo: ${e.motivos.join('; ')}. ¿Cómo seguir?`,
        });
      } catch { /* tarea ajena a TEAMS */ }
    }
    return { status: 'NO_ELEGIBLE', motivos: e.motivos };
  }
  const p = preview(root, e.baseline);
  anotar(root, { op: 'rollback', fase: 'inicio', task_id: o.task_id, attempt: o.attempt || null, point_id: e.baseline });
  const r = aplicar(root, e.baseline, { expected_current_hash: p.expected_current_hash, origen: 'rollback-teams', task_id: o.task_id });
  if (r.status !== 'RESTAURADO') {
    anotar(root, { op: 'rollback', fase: 'fallo', task_id: o.task_id, attempt: o.attempt || null, resultado: r.status });
    return Object.assign({ status: 'ROLLBACK_FALLIDO' }, r);
  }
  anotar(root, { op: 'rollback', fase: 'ok', task_id: o.task_id, attempt: o.attempt || null, point_id: e.baseline });
  if (tm) { try { tm.marcarRevertida(root, { task_id: o.task_id, point_id: e.baseline, motivo: 'ROLLBACK_AUTOMATICO' }); } catch { /* sin TEAMS */ } }
  return { status: 'REVERTIDA', point_id: e.baseline, restauracion: r, nota: 'la tarea no quedó implementada: volvió al punto sano' };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
  const pos = args.filter((a) => !a.startsWith('--'));
  const root = process.cwd();
  const cmd = pos[0] || 'list';
  let r;
  if (cmd === 'list') r = listar(root);
  else if (cmd === 'create') r = crear(root, { label: opt.label || pos.slice(1).join(' '), archivos: opt.files ? String(opt.files).split(',') : null, task_id: opt.task || null, tipo: opt.kind || 'MANUAL' });
  else if (cmd === 'show') r = mostrar(root, pos.slice(1).join(' '));
  else if (cmd === 'preview') r = preview(root, pos.slice(1).join(' '));
  else if (cmd === 'apply') r = aplicar(root, pos.slice(1).join(' '), { expected_current_hash: opt['expected-current-hash'], confirmar_decision: !!opt.confirmar && process.stdin.isTTY });
  else if (cmd === 'resume') r = reanudar(root);
  else if (cmd === 'invalidate') r = invalidar(root, pos[1], pos.slice(2).join(' '));
  else r = errorR('USO', 'restore-manager.cjs list|create [--label=..] [--files=a,b]|show <id>|preview <id>|apply <id> --expected-current-hash=H [--confirmar]|resume|invalidate <id> <motivo>');
  console.log(JSON.stringify(r, null, 2));
  if (r && !['OK', 'RESTAURADO', 'LISTO', 'SIN_CAMBIOS', 'REQUIERE_DECISION'].includes(r.status)) process.exitCode = 1;
}

module.exports = {
  SCHEMA_VERSION, TIPOS, POLITICA_DEFECTO, disponible, crear, listar, mostrar, preview, aplicar, reanudar, invalidar,
  resolverReferencia, elegibilidadRollback, rollbackAutomatico, rutaSegura, politica,
};
