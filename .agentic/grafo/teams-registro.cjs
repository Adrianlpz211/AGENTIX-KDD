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
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const canal = require('./teams-canal.cjs');

const REINTENTOS_MAX = 5;
const HIJO_MS = 4 * 60 * 1000;
const rutaRegistro = (root) => path.join(canal.dirEstado(root), 'registro.json');

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

/** Archivos reales de la tarea: los declarados en la tarea + los del reporte; sin ninguno, lo que Git ve cambiado. */
function archivosDe(root, tarea, reporte) {
  const declarados = [];
  const m = /^\s*Archivos?:\s*(.+)$/im.exec(tarea && tarea.texto ? tarea.texto : '');
  if (m) declarados.push(...m[1].split(/[,;]\s*/));
  if (reporte && reporte.archivos) declarados.push(...reporte.archivos);
  let lista = declarados.map((f) => rutaSegura(root, f.replace(/`/g, ''))).filter(Boolean);
  if (!lista.length) {
    try {
      const r = spawnSync('git', ['-c', 'safe.directory=*', 'status', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true });
      if (r.status === 0) lista = r.stdout.split(/\r?\n/).map((l) => l.slice(3).trim().replace(/^"|"$/g, '').replace(/.* -> /, '')).map((f) => rutaSegura(root, f)).filter(Boolean).filter((f) => !/^(\.legion|\.agentic)\//.test(f));
    } catch { /* sin git: lista vacía */ }
  }
  return [...new Set(lista)].slice(0, 200);
}

const areaDe = (archivos) => {
  const f = archivos.find((x) => x.includes('/')) || archivos[0] || '';
  const seg = f.split('/')[0].replace(/\.[a-z0-9]+$/i, '');
  return (seg || 'global').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'global';
};

/** Una tarea aceptada → ciclo en el núcleo común. Devuelve {estado, ...} y deja constancia en el registro local. */
function registrarTarea(root, tarea, acept, opts = {}) {
  const reg = leerRegistro(root);
  const clave = tarea.id + '@' + canal.sha(tarea.titulo + '|' + (acept.fecha || '')).slice(0, 10);
  const previo = reg.tareas[clave];
  if (previo && previo.estado === 'REGISTRADA') return { ...previo, estado: 'YA_REGISTRADA', clave };
  if (previo && (previo.intentos || 0) >= REINTENTOS_MAX) return { ...previo, estado: 'ABANDONADA', clave };

  const script = opts.postCycle || process.env.AKDD_TEAMS_POSTCYCLE || path.join(root, '.agentic', 'grafo', 'post-cycle.cjs');
  const archivos = archivosDe(root, tarea, acept.reporte);
  const area = areaDe(archivos);
  const ciclo = 'teams_' + canal.sha('v4|' + clave).slice(0, 24);
  const base = { id: tarea.id, titulo: tarea.titulo, ciclo, area, archivos: archivos.length, intentos: (previo ? previo.intentos : 0) + 1, at: new Date().toISOString() };

  if (!fs.existsSync(script)) {
    reg.tareas[clave] = { ...base, estado: 'PENDIENTE', causa: 'POST_CYCLE_AUSENTE' };
    guardarRegistro(root, reg);
    return { estado: 'PENDIENTE', causa: 'POST_CYCLE_AUSENTE', clave };
  }
  const tests = Number.isInteger(acept.tests) && acept.tests >= 0 ? acept.tests : 0;
  const tipo = /\b(fix|arregl|corrig|bug|error|hotfix)/i.test(tarea.titulo) ? 'fix' : 'feature';
  const args = [script, area, '--silent', '--origen=teams', '--tests=' + tests, '--tests-total=' + tests,
    '--task=' + String(tarea.titulo).replace(/[\r\n"]/g, ' ').slice(0, 160), '--type=' + tipo, '--modules=' + area, '--skip=deps,browser'];
  const r = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: opts.hijoMs || HIJO_MS,
    env: Object.assign({}, process.env, { AKDD_CYCLE_ID: ciclo, AKDD_ACTOR: 'teams-v4', AKDD_TEAMS_FILES: JSON.stringify(archivos), AKDD_TEAMS_REUSE: '{}' }),
  });
  let estado = 'REGISTRADA'; let causa = null;
  if (r.error && r.error.code === 'ETIMEDOUT') { estado = 'PENDIENTE'; causa = 'POST_CYCLE_TIMEOUT'; }
  else if (r.status === 75) { estado = 'PENDIENTE'; causa = 'UPDATE_EN_CURSO'; }
  else if (r.status !== 0) { estado = 'PENDIENTE'; causa = 'POST_CYCLE_EXIT_' + r.status + ': ' + String(r.stderr || r.stdout || '').trim().split(/\r?\n/).pop().slice(0, 160); }
  reg.tareas[clave] = { ...base, estado, causa };
  guardarRegistro(root, reg);
  return { estado, causa, ciclo, area, archivos: archivos.length, clave };
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

function resumen(root) {
  const reg = leerRegistro(root);
  const v = Object.values(reg.tareas);
  return {
    registradas: v.filter((x) => x.estado === 'REGISTRADA').length,
    pendientes: v.filter((x) => x.estado === 'PENDIENTE' && (x.intentos || 0) < REINTENTOS_MAX).length,
    abandonadas: v.filter((x) => x.estado === 'PENDIENTE' && (x.intentos || 0) >= REINTENTOS_MAX).length,
    memoria: Object.keys(reg.memoria || {}).length,
  };
}

module.exports = { registrarTarea, recordar, pendientes, resumen, leerRegistro, archivosDe, REINTENTOS_MAX };
