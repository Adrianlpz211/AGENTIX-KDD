#!/usr/bin/env node
'use strict';
/**
 * Cobertura del registro: ¿cuánto de lo que se HACE queda en Agentix? — con números que se pueden comprobar, no con intención.
 *
 *   node .agentic/grafo/cobertura.cjs [--dias=7] [--json]        (akdd cobertura)
 *
 * Mide tres cosas, de la más dura a la más blanda, y dice cuál es cuál:
 *   1. COMMITS (exacto): commits de git en la ventana vs ciclos que existen en la base para ese commit. No depende de ningún clasificador.
 *   2. CALIDAD del registro (exacto): de los ciclos de la ventana, qué % trae cada campo (duración, pruebas, AST, módulos, memoria…).
 *      Un ciclo «registrado» con todo vacío no cuenta como cobertura real.
 *   3. MENSAJES que parecían tarea (aproximado): el hook anota cada mensaje (solo clasificación y huella, nunca el texto) en
 *      `.agentic/_cobertura.jsonl`; se informa cuántos eran tarea, cuántos se enriquecieron y qué hay sin commit. El clasificador
 *      es heurístico: este número orienta, no certifica.
 *
 * Además registra el trabajo SIN COMMIT (`.agentic/_sin-commit.json`): lo que se edita y no se commitea no queda en Agentix hasta el
 * commit, y esa es la única forma honesta de decirlo.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ARCHIVO = (root) => path.join(root, '.agentic', '_cobertura.jsonl');
const SIN_COMMIT = (root) => path.join(root, '.agentic', '_sin-commit.json');
const MAX_LINEAS = 5000;

// ── escritura (la llama el hook; fail-soft: la medición nunca rompe el trabajo) ──────────────────────────────────────

function registrarPrompt(root, { host, cls, enriquecido, motivo, prompt } = {}) {
  try {
    const f = ARCHIVO(root);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const linea = JSON.stringify({
      t: new Date().toISOString(), host: host || null,
      tarea: !!(cls && cls.esTarea), explicito: !!(cls && cls.explicito), p: cls ? cls.p : null,
      enriquecido: !!enriquecido, motivo: motivo || null,
      h: crypto.createHash('sha1').update(String(prompt || '')).digest('hex').slice(0, 8), n: String(prompt || '').length,
    });
    fs.appendFileSync(f, linea + '\n');
    // Rotación barata: solo se mira el tamaño, y rara vez.
    if (fs.statSync(f).size > 600000) {
      const ls = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(f, ls.slice(-MAX_LINEAS).join('\n') + '\n');
    }
  } catch { /* medir es un plus */ }
}

const git = (root, args) => { const r = spawnSync('git', ['-c', 'safe.directory=*', ...args], { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true }); return r.status === 0 ? r.stdout : null; };

/** Archivos con cambios sin commitear (sin el estado interno de Agentix). */
function archivosSinCommit(root) {
  const out = git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (out == null) return null;
  return out.split('\0').filter(Boolean).map((l) => l.slice(3).replace(/\\/g, '/'))
    .filter((f) => !/^(\.agentic\/|_output\/|\.legion\/|\.claude\/|\.cursor\/|node_modules\/)/.test(f) && !/(^|\/)\.[^/]*\.tmp$/.test(f));
}

/** Fin de turno (Stop del host): anota qué quedó editado y sin commit. No toca la base: solo deja constancia y la hora desde la que está así. */
function anotarSinCommit(root) {
  try {
    const archivos = archivosSinCommit(root);
    if (archivos == null) return null;
    const f = SIN_COMMIT(root);
    let prev = null; try { prev = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* primera vez */ }
    if (!archivos.length) { if (prev) { try { fs.unlinkSync(f); } catch { /* ya no está */ } } return { archivos: [] }; }
    const ahora = new Date().toISOString();
    const dato = { desde: (prev && prev.desde) || ahora, ultimo: ahora, archivos: archivos.slice(0, 200), total: archivos.length };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(dato, null, 2));
    return dato;
  } catch { return null; }
}

/** Línea para el brief del modelo: «hay N archivos sin commit desde hace X». Vacía si no hay nada. */
function avisoSinCommit(root) {
  try {
    const d = anotarSinCommit(root); // recalcula con git ahora: un commit hecho entre dos turnos ya no cuenta como «sin commit»
    if (!d || !d.total) return null;
    const min = Math.max(0, Math.round((Date.now() - Date.parse(d.desde)) / 60000));
    return `⚠️ ${d.total} archivo(s) editados SIN COMMIT desde hace ${min} min: Agentix registra el trabajo al hacer commit — hasta entonces no queda en la memoria, la línea de tiempo ni el tablero.`;
  } catch { return null; }
}

// ── lectura / informe ────────────────────────────────────────────────────────────────────────────────────────────────

function abrirLectura(root) {
  const p = path.join(root, '.agentic', 'memoria.db');
  if (!fs.existsSync(p)) return null;
  try { return require('./db-adapter.cjs').openReadOnly(p, { busyTimeout: 3000 }); } catch { return null; }
}

const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);

function informe(root, { dias = 7 } = {}) {
  const desde = new Date(Date.now() - dias * 86400000);
  const out = { ventana_dias: dias, desde: desde.toISOString() };

  // 1. commits vs ciclos (exacto)
  const lista = git(root, ['log', '--since=' + desde.toISOString(), '--no-merges', '--format=%H']);
  const commits = lista ? lista.split(/\r?\n/).filter(Boolean) : null;
  const db = abrirLectura(root);
  let ciclos = [];
  if (db) {
    try { ciclos = db.all("SELECT ciclo_id, tarea, estado, post_cycle_ran, duracion_ms, tests_pasando, ast_indexed, modules_touched, stack_detected, memory_trace, area, fecha_inicio FROM ciclos WHERE fecha_inicio >= ? OR fecha_inicio IS NULL", desde.toISOString().slice(0, 19).replace('T', ' ')); }
    catch { try { ciclos = db.all('SELECT * FROM ciclos'); } catch { ciclos = []; } }
    try { db.close(); } catch { /* ya cerrada */ }
  }
  out.base = db ? 'ok' : 'sin_base_o_driver';
  if (commits) {
    const marcas = ciclos.map((c) => String(c.ciclo_id || '') + ' ' + String(c.tarea || ''));
    const sinCiclo = commits.filter((sha) => !marcas.some((m) => m.includes(sha) || m.includes('post-commit ' + sha.slice(0, 7))));
    let abandonados = 0;
    try { abandonados = require('./hook-runner.cjs').estadoCola(root).abandonados.length; } catch { /* motor viejo */ }
    out.commits = { en_git: commits.length, con_ciclo: commits.length - sinCiclo.length, sin_ciclo: sinCiclo.map((s) => s.slice(0, 7)).slice(0, 30), abandonados_por_el_hook: abandonados, pct: pct(commits.length - sinCiclo.length, commits.length) };
  } else out.commits = { en_git: null, nota: 'sin git: no se puede medir' };

  // 2. calidad del registro por origen (exacto)
  const origen = (c) => (/^teams_/.test(String(c.ciclo_id)) ? 'teams' : (/^commit-/.test(String(c.ciclo_id)) || /^auto post-commit/.test(String(c.tarea || '')) ? 'commit' : 'aa/manual'));
  const lleno = (v) => v !== null && v !== undefined && v !== '' && v !== 0 && v !== '0' && v !== '[]' && v !== '{}' && v !== false && v !== 'false';
  const campos = { 'post-cycle completo': (c) => lleno(c.post_cycle_ran), 'duración medida': (c) => Number(c.duracion_ms) > 0, 'con pruebas': (c) => Number(c.tests_pasando) > 0, 'AST indexado': (c) => lleno(c.ast_indexed), 'módulos': (c) => lleno(c.modules_touched), 'stack': (c) => lleno(c.stack_detected), 'memoria consultada': (c) => lleno(c.memory_trace), 'área concreta': (c) => c.area && c.area !== 'general' && c.area !== 'global' };
  out.calidad = {};
  for (const o of ['commit', 'teams', 'aa/manual']) {
    const g = ciclos.filter((c) => origen(c) === o);
    out.calidad[o] = { ciclos: g.length };
    for (const [k, fn] of Object.entries(campos)) out.calidad[o][k] = pct(g.filter(fn).length, g.length);
  }

  // TEAMS: tareas aceptadas vs registradas y verificadas
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(root, '.agentic', '_teams', 'registro.json'), 'utf8'));
    const v = Object.values(reg.tareas || {});
    out.teams = { en_registro: v.length, registradas_y_verificadas: v.filter((x) => x.estado === 'REGISTRADA' && x.verificada).length, pendientes: v.filter((x) => x.estado !== 'REGISTRADA').length };
  } catch { out.teams = null; }

  // 3. mensajes (aproximado)
  try {
    const ls = fs.readFileSync(ARCHIVO(root), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && Date.parse(x.t) >= desde.getTime());
    const tareas = ls.filter((x) => x.tarea);
    out.mensajes = { total: ls.length, parecian_tarea: tareas.length, con_aa_explicito: tareas.filter((x) => x.explicito).length, sin_aa_tratados_como_tarea: tareas.filter((x) => !x.explicito && x.enriquecido).length, tarea_sin_enriquecer: tareas.filter((x) => !x.enriquecido).length, nota: 'clasificación heurística: orienta, no certifica' };
  } catch { out.mensajes = null; }

  try { out.sin_commit = JSON.parse(fs.readFileSync(SIN_COMMIT(root), 'utf8')); } catch { out.sin_commit = null; }
  return out;
}

function texto(r) {
  const L = [];
  L.push(`COBERTURA DEL REGISTRO — últimos ${r.ventana_dias} día(s)`);
  L.push('');
  const c = r.commits;
  L.push('1) COMMITS (exacto, no depende de ningún clasificador)');
  L.push(c.en_git == null ? '   sin git: no se puede medir' : `   ${c.con_ciclo} de ${c.en_git} commits tienen ciclo en la base → ${c.pct == null ? 'n/d' : c.pct + ' %'}` + (c.abandonados_por_el_hook ? `  · ${c.abandonados_por_el_hook} abandonado(s) por el hook tras agotar reintentos` : ''));
  if (c.sin_ciclo && c.sin_ciclo.length) L.push('   sin ciclo: ' + c.sin_ciclo.join(' ') + (c.en_git - c.con_ciclo > c.sin_ciclo.length ? ' …' : ''));
  L.push('');
  L.push('2) CALIDAD de lo registrado (% de ciclos con el campo lleno)');
  const cols = ['post-cycle completo', 'duración medida', 'con pruebas', 'AST indexado', 'módulos', 'stack', 'memoria consultada', 'área concreta'];
  L.push('   ' + 'origen'.padEnd(10) + 'ciclos'.padStart(7) + cols.map((k) => k.slice(0, 11).padStart(13)).join(''));
  for (const [o, v] of Object.entries(r.calidad)) L.push('   ' + o.padEnd(10) + String(v.ciclos).padStart(7) + cols.map((k) => (v.ciclos ? (v[k] == null ? 'n/d' : v[k] + ' %') : '—').padStart(13)).join(''));
  if (r.teams) { L.push(''); L.push(`   TEAMS: ${r.teams.registradas_y_verificadas} registradas y verificadas · ${r.teams.pendientes} pendientes (de ${r.teams.en_registro} en el registro)`); }
  L.push('');
  L.push('3) MENSAJES (aproximado — el clasificador es heurístico)');
  if (r.mensajes) L.push(`   ${r.mensajes.total} mensajes · ${r.mensajes.parecian_tarea} parecían tarea (${r.mensajes.con_aa_explicito} con aa:, ${r.mensajes.sin_aa_tratados_como_tarea} sin aa: y tratados como tarea, ${r.mensajes.tarea_sin_enriquecer} sin enriquecer)`);
  else L.push('   sin datos: el hook de prompt aún no ha anotado mensajes (¿hooks del host instalados? `akdd host-hooks status`)');
  if (r.sin_commit && r.sin_commit.total) { L.push(''); L.push(`⚠️ SIN COMMIT: ${r.sin_commit.total} archivo(s) editados desde ${r.sin_commit.desde}. No quedan en Agentix hasta el commit.`); }
  L.push('');
  L.push('Lo que este informe NO dice: si el trabajo estuvo bien hecho. Mide si quedó registrado y con qué detalle.');
  return L.join('\n');
}

module.exports = { registrarPrompt, anotarSinCommit, avisoSinCommit, archivosSinCommit, informe, texto, ARCHIVO, SIN_COMMIT };

if (require.main === module) {
  const root = process.cwd();
  const arg = process.argv.slice(2);
  const dias = Number((arg.find((a) => a.startsWith('--dias=')) || '--dias=7').slice(7)) || 7;
  const r = informe(root, { dias });
  console.log(arg.includes('--json') ? JSON.stringify(r, null, 2) : texto(r));
}
