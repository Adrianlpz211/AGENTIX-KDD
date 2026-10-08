#!/usr/bin/env node
'use strict';
/**
 * Registro RETROACTIVO de commits que quedaron sin ciclo (caso medinet: una semana de commits sin registrarse por «database is locked»).
 *
 *   node .agentic/grafo/registro-historico.cjs [--dias=30] [--max=200] [--aplicar]        (akdd reconciliar)
 *
 * Sin --aplicar solo LISTA qué commits no tienen ciclo. Con --aplicar crea, por cada uno, un ciclo `commit-<sha>` con lo que SÍ se sabe
 * (fecha del commit, asunto, archivos, área, módulos, memoria relevante derivada) y lo marca `post_cycle_ran = 'historico'`:
 * NO se corren pruebas, ni AST, ni compuertas (sobre el árbol de hoy no probarían el commit de entonces), la duración queda SIN DATO
 * y los contratos no se tocan. Un ciclo histórico cuenta como «commit registrado» pero NO como «post-cycle completo» en `akdd cobertura`.
 * Idempotente: el id del ciclo es el mismo que usa el hook, así que un commit ya registrado se omite.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const git = (root, args) => { const r = spawnSync('git', ['-c', 'safe.directory=*', ...args], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };
const utc = (iso) => new Date(iso).toISOString().replace('T', ' ').slice(0, 19);

function commitsSinCiclo(root, { dias = 30, max = 200 } = {}) {
  const log = git(root, ['log', '--since=' + new Date(Date.now() - dias * 86400000).toISOString(), '--no-merges', '--format=%H%x1f%aI%x1f%s']);
  if (log == null) return { error: 'sin git' };
  const commits = log.split(/\r?\n/).filter(Boolean).map((l) => { const [sha, fecha, asunto] = l.split('\x1f'); return { sha, fecha, asunto: asunto || '' }; });
  let existentes = new Set();
  try {
    const db = require('./db-adapter.cjs').openReadOnly(path.join(root, '.agentic', 'memoria.db'), { busyTimeout: 3000 });
    try { existentes = new Set(db.all('SELECT ciclo_id, tarea FROM ciclos').map((c) => String(c.ciclo_id) + ' ' + String(c.tarea || ''))); } finally { db.close(); }
  } catch (e) { return { error: 'no se pudo leer la base: ' + String(e.message).slice(0, 100) }; }
  const marcas = [...existentes];
  const faltan = commits.filter((c) => !marcas.some((m) => m.includes(c.sha) || m.includes('post-commit ' + c.sha.slice(0, 7)))).slice(0, max);
  return { total_en_git: commits.length, sin_ciclo: faltan };
}

function registrar(root, commit) {
  const prevCwd = process.cwd();
  try {
    process.chdir(root); // grafo.cjs resuelve la base desde el directorio de trabajo
    const hr = require('./hook-runner.cjs');
    const { area, files } = hr.areaDe(root, commit.sha);
    const grafo = require('./grafo.cjs');
    const id = 'commit-' + commit.sha;
    const modulos = [...new Set(files.map((f) => f.split('/')[0]).filter(Boolean))].slice(0, 12);
    const cid = grafo.registrarCiclo({
      ciclo_id: id,
      tarea: 'auto post-commit ' + commit.sha.slice(0, 7) + (commit.asunto ? ' — ' + commit.asunto.slice(0, 140) : ''),
      tipo_tarea: /\b(fix|arregl|corrig|bug|error|hotfix)/i.test(commit.asunto) ? 'fix' : 'feature',
      modulo: area, area, estado: 'COMPLETADO_CON_PENDIENTES', context_guard: 'OK',
      fases_total: 1, fases_completadas: 1, tests_generados: 0, tests_pasando: 0, stops_count: 0, sync_grafo: false, duracion_ms: 0,
      post_cycle_ran: 'historico', modules_touched: JSON.stringify(modulos), fecha_inicio: utc(commit.fecha),
    });
    if (!cid) return { ok: false, motivo: 'registrarCiclo no escribió (¿ya existe o está cerrado?)' };
    // registrarCiclo pone fecha_fin = ahora: en un ciclo retroactivo el fin ES la fecha del commit, no la de hoy.
    const db = require('./db-adapter.cjs').openWrite(path.join(root, '.agentic', 'memoria.db'), { busyTimeout: 5000 });
    try { db.run('UPDATE ciclos SET fecha_fin = fecha_inicio WHERE ciclo_id = ?', id); } finally { db.close(); }
    try { grafo.registrarEpisodio({ ciclo_id: id, tipo: 'ciclo_aa', descripcion: commit.asunto || ('commit ' + commit.sha.slice(0, 7)), accion_tomada: 'registro retroactivo (el commit no se registró en su momento)', resultado: 'historico', archivos_tocados: files.slice(0, 80), area, modulo: area }); } catch { /* el episodio es un plus */ }
    return { ok: true, id, area, archivos: files.length };
  } catch (e) { return { ok: false, motivo: String(e && e.message || e).slice(0, 160) }; } finally { try { process.chdir(prevCwd); } catch { /* sin cwd */ } }
}

module.exports = { commitsSinCiclo, registrar };

if (require.main === module) {
  const arg = process.argv.slice(2);
  const num = (n, d) => { const a = arg.find((x) => x.startsWith('--' + n + '=')); return a ? Number(a.split('=')[1]) || d : d; };
  const root = process.cwd();
  const r = commitsSinCiclo(root, { dias: num('dias', 30), max: num('max', 200) });
  if (r.error) { console.error('✖ ' + r.error); process.exit(1); }
  console.log(`Commits en los últimos ${num('dias', 30)} día(s): ${r.total_en_git} · sin ciclo: ${r.sin_ciclo.length}`);
  if (!arg.includes('--aplicar')) {
    for (const c of r.sin_ciclo.slice(0, 15)) console.log('  ' + c.sha.slice(0, 7) + '  ' + c.fecha.slice(0, 16).replace('T', ' ') + '  ' + c.asunto.slice(0, 80));
    if (r.sin_ciclo.length > 15) console.log('  … y ' + (r.sin_ciclo.length - 15) + ' más');
    console.log(r.sin_ciclo.length ? '\nSolo se listó. Para registrarlos (sin pruebas ni AST, duración sin dato): node .agentic/grafo/registro-historico.cjs --aplicar' : '\nNada que reconciliar.');
    process.exit(0);
  }
  let ok = 0, mal = 0;
  for (const c of r.sin_ciclo.slice().reverse()) { // del más viejo al más nuevo
    const x = registrar(root, c);
    if (x.ok) ok++; else { mal++; console.error('  ✖ ' + c.sha.slice(0, 7) + ': ' + x.motivo); }
  }
  console.log(`Registrados: ${ok} · con error: ${mal}. Marcados post_cycle_ran='historico' (sin pruebas, sin AST, duración sin dato).`);
  process.exit(mal ? 1 : 0);
}
