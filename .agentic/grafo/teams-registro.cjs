'use strict';
/**
 * TEAMS v4 — registro en el núcleo de Agentix.
 *
 * El protocolo manual (canal MD a mano) funciona pero no registra nada porque vive fuera de `aa:`. Aquí está
 * la conexión: cuando el Director ACEPTA una tarea (o resuelve una corrección, o decide algo) lo ocurrido entra al
 * MISMO núcleo que `aa:` — ciclo, memoria KDD, contratos, AST, layout, preservación, dashboard — con origen `teams`.
 *
 * Reglas de diseño:
 *   · OBSERVA, no manda: un fallo aquí deja un aviso y un reintento; JAMÁS frena a Cursor ni al Director.
 *   · Idempotente: una tarea aceptada se registra una vez (id de ciclo determinista `teams_<hash>`); reintentar no duplica.
 *   · No inventa evidencia: pasa los archivos reales y corre post-cycle de verdad (el mismo que `aa:`).
 *   · Sin base / sin post-cycle / update en curso → PENDIENTE visible con su causa; `observar` reintenta.
 *   · NO da por registrado lo que no está en la base: que post-cycle salga con 0 no prueba que el ciclo exista
 *     (con una memoria.db sin migrar sale con 0 y no deja nada: 15 tareas «REGISTRADA» con la tabla `ciclos` ausente).
 *     Antes de lanzarlo se comprueba que el esquema base exista, y al volver se comprueba que el ciclo esté cerrado en SQL.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const canal = require('./teams-canal.cjs');

const REINTENTOS_MAX = 5;
const ENFRIAMIENTO_MS = 30 * 60 * 1000; // tras agotar los intentos, a los 30 min se vuelve a probar solo
const HIJO_MS = 4 * 60 * 1000;
const rutaRegistro = (root) => path.join(canal.dirEstado(root), 'registro.json');
/* Tablas que el registro necesita para existir (schema.sql). Si faltan, ningún ciclo puede quedar escrito. */
const TABLAS_NUCLEO = ['nodos', 'ciclos', 'fases', 'episodios', 'relaciones'];
const REPARAR = 'node .agentic/grafo/schema-columns.cjs fix';
const PRESUPUESTO_RONDA = 3; // registros que una sola ronda puede lanzar (cada post-cycle corre los tests: hasta 4 min)

function leerRegistro(root) {
  try { return JSON.parse(fs.readFileSync(rutaRegistro(root), 'utf8')); } catch { return { tareas: {}, memoria: {} }; }
}
function guardarRegistro(root, r) {
  fs.mkdirSync(path.dirname(rutaRegistro(root)), { recursive: true });
  const tmp = rutaRegistro(root) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  canal.renombrarConReintento(tmp, rutaRegistro(root));
}

const limpiarRuta = (f) => String(f || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
function rutaSegura(root, f) {
  const n = limpiarRuta(f);
  if (!n || path.isAbsolute(n) || /^[a-z]:/i.test(n) || n.split('/').includes('..')) return null;
  if (/(^|\/)\.env(\.|$)|(^|\/)(secrets?|id_rsa|credentials)(\.|$)/i.test(n)) return null; // una ruta privada no viaja
  return n;
}

function abrirLectura(root) {
  const p = path.join(root, '.agentic', 'memoria.db');
  if (!fs.existsSync(p)) return null;
  try { return require('./db-adapter.cjs').openReadOnly(p, { busyTimeout: 3000 }); } catch { return null; }
}

let _cacheBase = null;
/** ¿Tiene memoria.db el esquema base? OK | SIN_MIGRAR (con lo que falta y cómo repararlo) | SIN_BD | NO_VERIFICABLE. Con caché de 30 s. */
function estadoBase(root, { sinCache = false } = {}) {
  const p = path.join(root, '.agentic', 'memoria.db');
  let mt = 0;
  try { mt = fs.statSync(p).mtimeMs; } catch { return { estado: 'SIN_BD' }; }
  if (!sinCache && _cacheBase && _cacheBase.root === root && _cacheBase.mt === mt && Date.now() - _cacheBase.at < 30000) return _cacheBase.v;
  const db = abrirLectura(root);
  let v;
  if (!db) v = { estado: 'NO_VERIFICABLE', motivo: 'sin conector de SQLite o la base está ocupada' };
  else {
    try {
      const tablas = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
      const faltan = TABLAS_NUCLEO.filter((t) => !tablas.has(t));
      let pendientes = null;
      try { const r = require('./schema-catalog.cjs').inspect(db); pendientes = r.status === 'COMPLETE' ? 0 : (r.pending || []).length; } catch { /* catálogo ausente: solo se mira el núcleo */ }
      v = faltan.length ? { estado: 'SIN_MIGRAR', faltan, pendientes, reparar: REPARAR } : { estado: 'OK', pendientes };
    } catch (e) { v = { estado: 'NO_VERIFICABLE', motivo: String(e.message).slice(0, 120) }; }
    finally { try { db.close(); } catch { /* ya cerrada */ } }
  }
  _cacheBase = { root, mt, at: Date.now(), v };
  return v;
}

/** ¿El ciclo está de verdad en la base y cerrado? ok:true | ok:false + causa | ok:null (no se pudo mirar). */
function verificarConDb(db, ciclo) {
  try {
    const f = db.get('SELECT ciclo_id, estado FROM ciclos WHERE ciclo_id = ?', ciclo);
    if (!f) return { ok: false, causa: 'CICLO_NO_REGISTRADO' };
    if (/EN_CURSO/i.test(String(f.estado))) return { ok: false, causa: 'CICLO_NO_CERRADO' };
    return { ok: true };
  } catch (e) {
    if (/no such table/i.test(String(e.message))) return { ok: false, causa: 'ESQUEMA_SIN_MIGRAR' };
    return { ok: null };
  }
}
function verificarCiclo(root, ciclo) {
  const db = abrirLectura(root);
  if (!db) return { ok: null };
  try { return verificarConDb(db, ciclo); } finally { try { db.close(); } catch { /* ya cerrada */ } }
}

/**
 * Las que figuran REGISTRADA sin que nadie lo comprobara (registro anterior a esta comprobación) se contrastan con la
 * base: si el ciclo no está, vuelven a PENDIENTE para registrarse de verdad. No relanza nada aquí: lo hace `observar`.
 */
function reverificar(root) {
  const reg = leerRegistro(root);
  const dudosas = Object.values(reg.tareas || {}).filter((v) => v.estado === 'REGISTRADA' && v.verificada !== true && v.ciclo);
  if (!dudosas.length) return { revisadas: 0, reabiertas: 0 };
  const db = abrirLectura(root);
  if (!db) return { revisadas: 0, reabiertas: 0 };
  let reabiertas = 0;
  try {
    for (const v of dudosas) {
      const r = verificarConDb(db, v.ciclo);
      if (r.ok === true) v.verificada = true;
      else if (r.ok === false) { v.estado = 'PENDIENTE'; v.causa = 'REVERIFICADA: ' + r.causa; v.intentos = 0; v.verificada = false; reabiertas++; }
    }
  } finally { try { db.close(); } catch { /* ya cerrada */ } }
  if (reabiertas || dudosas.some((v) => v.verificada === true)) guardarRegistro(root, reg);
  return { revisadas: dudosas.length, reabiertas };
}

/** Sin git: los archivos de código tocados desde que empezó la tarea (lo único que se sabe sin historial). */
const IGNORAR_DIR = new Set(['node_modules', '.git', '.agentic', '.legion', '_output', 'dist', 'build', '.next', 'coverage', 'evidencias', 'releases', '.turbo', '.cache']);
const EXT_CODIGO = /\.(ts|tsx|js|jsx|cjs|mjs|json|css|scss|html|md|sql|py|go|rs|java|php|rb|glsl|vue|svelte)$/i;
function archivosPorFecha(root, desdeMs, tope = 200, msMax = 4000) {
  if (!Number.isFinite(desdeMs)) return [];
  const fin = Date.now() + msMax; const out = [];
  const pila = [root];
  while (pila.length && out.length < tope && Date.now() < fin) {
    const dir = pila.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!IGNORAR_DIR.has(e.name)) pila.push(p); continue; }
      if (!e.isFile() || !EXT_CODIGO.test(e.name)) continue;
      try { if (fs.statSync(p).mtimeMs >= desdeMs - 1000) out.push(path.relative(root, p).split(path.sep).join('/')); } catch { /* desapareció */ }
    }
  }
  return out;
}

/** Archivos reales de la tarea: los declarados en la tarea + los del reporte; sin ninguno, lo que Git ve cambiado
 *  (o, sin Git, lo modificado desde que empezó la tarea). */
function archivosDe(root, tarea, reporte, inicioMs) {
  const declarados = [];
  const m = /^\s*Archivos?:\s*(.+)$/im.exec(tarea && tarea.texto ? tarea.texto : '');
  if (m) declarados.push(...m[1].split(/[,;]\s*/));
  if (reporte && reporte.archivos) declarados.push(...reporte.archivos);
  let lista = declarados.map((f) => rutaSegura(root, f.replace(/`/g, ''))).filter(Boolean);
  if (!lista.length) {
    try {
      const r = spawnSync('git', ['-c', 'safe.directory=*', 'status', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true });
      if (r.status === 0) lista = r.stdout.split(/\r?\n/).map((l) => l.slice(3).trim().replace(/^"|"$/g, '').replace(/.* -> /, '')).map((f) => rutaSegura(root, f)).filter(Boolean).filter((f) => !/^(\.legion|\.agentic)\//.test(f));
      else lista = archivosPorFecha(root, inicioMs).map((f) => rutaSegura(root, f)).filter(Boolean); // no es un repositorio Git
    } catch { /* sin git: lista vacía */ }
  }
  return [...new Set(lista)].slice(0, 200);
}

const areaDe = (archivos) => {
  const f = archivos.find((x) => x.includes('/')) || archivos[0] || '';
  const seg = f.split('/')[0].replace(/\.[a-z0-9]+$/i, '');
  return (seg || 'global').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'global';
};

/** Sella en la libreta CUÁNDO empezó el ciclo (el reloj de Agentix lo usa para la duración). Sin dato → no se inventa. */
function estamparInicio(root, ciclo, inicioMs, titulo) {
  // Por el adaptador común (respeta la exclusión de escritura de un `akdd update` en curso, como todo lo que escribe la base).
  let db = null;
  try {
    if (!Number.isFinite(inicioMs)) return false;
    const dbPath = path.join(root, '.agentic', 'memoria.db');
    if (!fs.existsSync(dbPath)) return false;
    db = require('./db-adapter.cjs').openWrite(dbPath, { busyTimeout: 8000 });
    require('./gate-telemetry.cjs').ensureTelemetrySchema(db); // solo usa exec: idempotente y compatible con el adaptador
    const cols = db.all('PRAGMA table_info(gate_events)').map((c) => c.name);
    if (!cols.includes('cycle_id') || !cols.includes('event_id')) return false; // la libreta aún no tiene el esquema: sin dato, no se inventa
    const ts = new Date(inicioMs).toISOString().replace('T', ' ').slice(0, 19);
    db.run("INSERT OR IGNORE INTO gate_events (ts, gate, verdict, detalle, source, cycle_id, event_id) VALUES (?, 'reloj', 'CICLO_INICIO', ?, 'mechanical', ?, ?)",
      ts, JSON.stringify({ tarea: String(titulo).slice(0, 160), origen: 'teams' }), String(ciclo), 'teams-inicio:' + ciclo);
    return true;
  } catch { return false; } finally { try { if (db) db.close(); } catch { /* ya cerrada */ } }
}

/** Una tarea aceptada → ciclo en el núcleo común. Devuelve {estado, ...} y deja constancia en el registro local. */
function registrarTarea(root, tarea, acept, opts = {}) {
  const reg = leerRegistro(root);
  const clave = tarea.id + '@' + canal.sha(tarea.titulo + '|' + (acept.fecha || '')).slice(0, 10);
  const previo = reg.tareas[clave];
  if (previo && previo.estado === 'REGISTRADA') return { ...previo, estado: 'YA_REGISTRADA', clave };
  if (previo && previo.estado === 'PENDIENTE') {
    // Espera progresiva entre intentos (1, 2, 4, 8, 15 min): un fallo transitorio (base ocupada por otro proceso) NO gasta los
    // 5 intentos en segundos — medido en glowly: tres tareas agotaron el presupuesto en 1 s por «database is locked».
    const edad = Date.now() - Date.parse(previo.at);
    if (opts.forzar || acept.forzar) previo.intentos = 0;
    else if ((previo.intentos || 0) >= REINTENTOS_MAX && edad > ENFRIAMIENTO_MS) previo.intentos = 0; // enfriado: vuelve a intentarlo solo
    else if ((previo.intentos || 0) >= REINTENTOS_MAX) return { ...previo, estado: 'ABANDONADA', clave };
    else if (edad < Math.min(15 * 60000, 60000 * 2 ** Math.max(0, (previo.intentos || 1) - 1))) return { ...previo, estado: 'EN_ESPERA', clave };
  }

  const script = opts.postCycle || process.env.AKDD_TEAMS_POSTCYCLE || path.join(root, '.agentic', 'grafo', 'post-cycle.cjs');
  const archivos = archivosDe(root, tarea, acept.reporte, acept.inicio);
  const area = areaDe(archivos);
  const ciclo = 'teams_' + canal.sha('v4|' + clave).slice(0, 24);
  const base = { id: tarea.id, titulo: tarea.titulo, ciclo, area, archivos: archivos.length, intentos: (previo ? previo.intentos : 0) + 1, at: new Date().toISOString() };

  if (!fs.existsSync(script)) {
    reg.tareas[clave] = { ...base, estado: 'PENDIENTE', causa: 'POST_CYCLE_AUSENTE' };
    guardarRegistro(root, reg);
    return { estado: 'PENDIENTE', causa: 'POST_CYCLE_AUSENTE', clave };
  }
  /* El inicio del ciclo se sella siempre (es del reloj, no del esquema base): idempotente por event_id. */
  if (acept.inicio) estamparInicio(root, ciclo, acept.inicio, tarea.titulo);
  /* Sin el esquema base post-cycle sale con 0 y no deja nada: se detecta ANTES, sin gastar los tests de la tarea. */
  const base_bd = estadoBase(root, { sinCache: true });
  if (base_bd.estado === 'SIN_MIGRAR') {
    const causa = 'ESQUEMA_SIN_MIGRAR: faltan las tablas ' + base_bd.faltan.join(', ') + ' en memoria.db — repara con `' + REPARAR + '` y luego `teams.cjs observar --reintentar`';
    reg.tareas[clave] = { ...base, estado: 'PENDIENTE', causa, verificada: false };
    guardarRegistro(root, reg);
    return { estado: 'PENDIENTE', causa, clave };
  }
  /* Cada post-cycle corre los tests de la tarea: una ronda no puede lanzar un aluvión (p. ej. al reabrir un registro viejo). */
  if (opts.presupuesto) {
    if (opts.presupuesto.restantes <= 0) return { ...(previo || base), estado: 'EN_ESPERA', causa: 'PRESUPUESTO_DE_RONDA', clave };
    opts.presupuesto.restantes--;
  }
  const tests = Number.isInteger(acept.tests) && acept.tests >= 0 ? acept.tests : 0;
  const tipo = /\b(fix|arregl|corrig|bug|error|hotfix)/i.test(tarea.titulo) ? 'fix' : 'feature';
  const args = [script, area, '--silent', '--origen=teams', '--tests=' + tests, '--tests-total=' + tests,
    '--task=' + String(tarea.titulo).replace(/[\r\n"]/g, ' ').slice(0, 160), '--type=' + tipo, '--modules=' + area, '--skip=deps,browser'];
  const r = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: opts.hijoMs || HIJO_MS,
    env: Object.assign({}, process.env, { AKDD_CYCLE_ID: ciclo, AKDD_ACTOR: 'teams-v4', AKDD_TEAMS_REUSE: '{}' },
      /* Una lista vacía («[]») es verdadera para post-cycle y anula su respaldo (los archivos del último commit): sin datos, sin variable. */
      archivos.length ? { AKDD_TEAMS_FILES: JSON.stringify(archivos) } : {}),
  });
  let estado = 'REGISTRADA'; let causa = null;
  if (r.error && r.error.code === 'ETIMEDOUT') { estado = 'PENDIENTE'; causa = 'POST_CYCLE_TIMEOUT'; }
  else if (r.status === 75) { estado = 'PENDIENTE'; causa = 'UPDATE_EN_CURSO'; }
  else if (r.status !== 0) { estado = 'PENDIENTE'; causa = 'POST_CYCLE_EXIT_' + r.status + ': ' + String(r.stderr || r.stdout || '').trim().split(/\r?\n/).pop().slice(0, 160); }
  /* Salir con 0 no prueba que el ciclo exista: se comprueba en la base. */
  let verificada = false;
  if (estado === 'REGISTRADA') {
    const v = verificarCiclo(root, ciclo);
    if (v.ok === true) verificada = true;
    else if (v.ok === false) { estado = 'PENDIENTE'; causa = v.causa + ': post-cycle terminó sin error pero el ciclo no quedó en la base (revisa _output/log-AAAA-MM.md)'; }
  }
  reg.tareas[clave] = { ...base, estado, causa, verificada };
  guardarRegistro(root, reg);
  return { estado, causa, ciclo, area, archivos: archivos.length, clave, verificada };
}

/** Un hallazgo corregido / una decisión → memoria KDD (error o decisión), una sola vez por clave. Fail-soft. */
function recordar(root, clave, entrada, opciones) {
  const reg = leerRegistro(root);
  reg.memoria = reg.memoria || {};
  if (reg.memoria[clave]) return { ok: true, estado: 'YA_REGISTRADO' };
  try {
    const m = require('./kdd-memory.cjs');
    const r = m.remember(String(entrada).slice(0, 1500), { tipo: opciones.tipo || 'patron', area: opciones.area || 'global', confianza: opciones.confianza || 'BAJA', archivos: opciones.archivos || [], via: 'teams' }, root);
    if (r && r.ok) { reg.memoria[clave] = { id: r.id || null, at: new Date().toISOString() }; guardarRegistro(root, reg); return { ok: true, estado: 'REGISTRADO', id: r.id }; }
    return { ok: false, estado: 'PENDIENTE', causa: (r && (r.reason || r.error)) || 'sin detalle' };
  } catch (e) { return { ok: false, estado: 'PENDIENTE', causa: e.message }; }
}

function pendientes(root) {
  const reg = leerRegistro(root);
  return Object.entries(reg.tareas).filter(([, v]) => v.estado === 'PENDIENTE').map(([clave, v]) => ({ clave, ...v }));
}

/** Un registro PENDIENTE de una tarea que ya no figura ACEPTADA (la cancelaron o la reabrieron) no puede cerrarse nunca: se declara OBSOLETO. */
function descartarObsoletas(root, idsAceptadas) {
  const reg = leerRegistro(root); let n = 0;
  for (const v of Object.values(reg.tareas || {})) {
    if (v.estado === 'PENDIENTE' && !idsAceptadas.includes(v.id)) { v.estado = 'OBSOLETA'; v.causa = 'la tarea ya no está aceptada (cancelada o reabierta)'; v.obsoleta_at = new Date().toISOString(); n++; }
  }
  if (n) guardarRegistro(root, reg);
  return n;
}

function resumen(root) {
  const reg = leerRegistro(root);
  const v = Object.values(reg.tareas);
  return {
    registradas: v.filter((x) => x.estado === 'REGISTRADA').length,
    /* De las registradas, cuántas se comprobaron en la base. El resto está «dado por bueno» sin prueba. */
    verificadas: v.filter((x) => x.estado === 'REGISTRADA' && x.verificada === true).length,
    sin_verificar: v.filter((x) => x.estado === 'REGISTRADA' && x.verificada !== true).length,
    pendientes: v.filter((x) => x.estado === 'PENDIENTE' && (x.intentos || 0) < REINTENTOS_MAX).length,
    abandonadas: v.filter((x) => x.estado === 'PENDIENTE' && (x.intentos || 0) >= REINTENTOS_MAX).length,
    obsoletas: v.filter((x) => x.estado === 'OBSOLETA').length,
    memoria: Object.keys(reg.memoria || {}).length,
  };
}

module.exports = { estamparInicio, registrarTarea, recordar, pendientes, descartarObsoletas, resumen, leerRegistro, archivosDe, REINTENTOS_MAX,
  estadoBase, verificarCiclo, reverificar, archivosPorFecha, areaDe, PRESUPUESTO_RONDA, REPARAR };
