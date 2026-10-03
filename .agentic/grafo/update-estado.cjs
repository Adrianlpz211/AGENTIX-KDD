'use strict';
/**
 * Estado de actualización y memoria para el dashboard (3.20.1). SOLO LECTURA.
 *
 * Responde a las preguntas que una persona se hace después de `akdd update`:
 *   · ¿qué versión está instalada y es compatible el esquema de la memoria?
 *   · ¿cuándo se verificó por última vez y qué resultó?
 *   · ¿se conservó la memoria? ¿y mis personalizaciones?
 *   · ¿hay un respaldo disponible? ¿hay conflictos y qué debo hacer?
 *
 * Y separa dos cosas que no son lo mismo: "el servicio responde" (el tablero está
 * vivo) y "la memoria puede trabajar" (el esquema está completo, no hay un update
 * en curso y la base se puede abrir). Un tablero vivo sobre una memoria que el
 * motor se negaría a abrir NO es "todo bien".
 *
 * No expone secretos ni contenido de archivos: solo rutas relativas al proyecto,
 * tamaños, estados y recuentos. No ejecuta SQL arbitrario ni acepta SQL del navegador.
 */
const fs = require('fs');
const path = require('path');

const LIMITE = 50;
const rel = (root, f) => String(path.relative(root, f)).split(path.sep).join('/');
const leerJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function versionInstalada(root) {
  const fw = leerJSON(path.join(root, '.agentic', 'grafo', 'framework.json'));
  if (fw && fw.version) return fw.version;
  try { const m = /^\s*VERSION:\s*(\S+)/m.exec(fs.readFileSync(path.join(root, '.agentic', 'config.md'), 'utf8')); return m ? m[1] : null; } catch { return null; }
}

function paginar(lista, cursor, limit) {
  const desde = Number.isInteger(cursor) && cursor > 0 ? cursor : 0;
  const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : LIMITE;
  const pagina = lista.slice(desde, desde + lim);
  return { pagina, coverage: { total: lista.length, shown: pagina.length, truncated: lista.length > pagina.length, offset: desde, next_cursor: desde + pagina.length < lista.length ? desde + pagina.length : null } };
}

/** Esquema de la base contra el catálogo, en solo lectura. */
function esquema(root) {
  const dbPath = path.join(root, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return { available: false, status: 'SIN_BASE', note: 'el proyecto aún no tiene memoria.db: se crea al primer uso' };
  try {
    const dba = require('./db-adapter.cjs');
    const sc = require('./schema-catalog.cjs');
    const db = dba.openReadOnly(dbPath);
    try {
      const r = sc.inspect(db);
      return {
        available: true, status: r.status, detected_level: r.detected_level, supported_level: r.supported_level, registry_present: r.registry_present,
        registry_entries: r.registry_entries, pending: r.pending.length, conflicts: r.conflicts.length, warnings: r.warnings.length,
        newer_than_supported: r.newer_than_supported.length, foreign_tables: r.foreign_tables.length,
      };
    } finally { db.close(); }
  } catch (e) { return { available: false, status: 'ILEGIBLE', note: String(e.message || e).slice(0, 160) }; }
}

/**
 * Conservación de memoria y archivos propios. El informe completo trae el detalle;
 * el resumen (last-result.json) solo trae el estado, y se usa si el informe ya no está.
 */
function conservacion(ultimo, informe) {
  if (!ultimo) return null;
  const pres = informe && informe.preservation;
  if (pres) {
    const db = pres.db ? { status: pres.db.status, problems: (pres.db.problems || []).length, unverified: (pres.db.unverified || []).length } : null;
    const files = pres.files ? { status: pres.files.status, compared: pres.files.compared, problems: (pres.files.problems || []).length } : null;
    return { database: db, own_files: files, summary: pres.db && pres.db.summary ? { compared: pres.db.summary.compared, rows_compared: pres.db.summary.rows_compared, user_tables: pres.db.summary.user_tables || [] } : null };
  }
  const p = ultimo.preservation;
  return p ? { database: p.db ? { status: p.db } : null, own_files: p.files ? { status: p.files } : null, summary: null } : null;
}

/** Un update vivo tiene la exclusión de escritores: la memoria no puede trabajar mientras dure. */
function updateEnCurso(root) {
  try {
    const g = require('./update-guard.cjs');
    const e = g.estado(root);
    return e.held ? { in_progress: true, op_id: e.holder && e.holder.op_id, phase: e.holder && e.holder.phase, since: e.holder && e.holder.started_at } : { in_progress: false };
  } catch { return { in_progress: false }; }
}

/**
 * opts: { cursor, limit }  — pagina la lista de archivos conservados.
 */
function leer(root, opts = {}) {
  const dirUpdate = path.join(root, '.agentic', '_update');
  const ultimo = leerJSON(path.join(dirUpdate, 'last-result.json'));
  const informe = ultimo && ultimo.op_id ? leerJSON(path.join(dirUpdate, 'tx', ultimo.op_id, 'verification.json')) : null;
  const esq = esquema(root);
  const enCurso = updateEnCurso(root);

  // Respaldo disponible (el más reciente que siga en disco).
  let respaldo = { available: false };
  try {
    const base = path.join(dirUpdate, 'backups');
    const ids = fs.readdirSync(base).filter((id) => fs.existsSync(path.join(base, id, 'meta.json'))).sort();
    const id = ids[ids.length - 1];
    if (id) {
      const meta = leerJSON(path.join(base, id, 'meta.json'));
      const f = path.join(base, id, 'memoria.db');
      respaldo = { available: fs.existsSync(f), op_id: id, path: rel(root, f), size: meta && meta.size, created_at: meta && meta.created_at, integrity: meta && meta.integrity, sha256: meta && meta.sha256 ? String(meta.sha256).slice(0, 16) : null, kept_count: ids.length };
    }
  } catch { /* sin respaldos */ }

  const preservados = ((informe && informe.files && informe.files.preserved) || []).map((p) => ({ file: p.file, clase: p.clase, motivo: p.motivo, new_version: p.new_version }));
  const { pagina, coverage } = paginar(preservados, opts.cursor, opts.limit);
  const conflictos = (informe && informe.files && informe.files.conflicts) || [];
  const protegidos = (informe && informe.files && informe.files.protected) || [];

  // ¿Qué debe hacer la persona?
  const acciones = [];
  if (enCurso.in_progress) acciones.push({ code: 'UPDATE_EN_CURSO', message: 'hay un akdd update en marcha; espera a que termine' });
  if (esq.status === 'PENDING') acciones.push({ code: 'MIGRAR', message: 'el esquema de la memoria está incompleto: ejecuta akdd update' });
  if (esq.status === 'NEWER_SCHEMA') acciones.push({ code: 'ACTUALIZAR_CLI', message: 'la memoria es de una versión más nueva: actualiza la CLI (npm install -g agentic-kdd)' });
  if (esq.status === 'BLOCKED') acciones.push({ code: 'REVISAR_ESQUEMA', message: 'hay conflictos de esquema que requieren revisión humana: akdd update --check' });
  if (esq.status === 'ILEGIBLE') acciones.push({ code: 'BASE_ILEGIBLE', message: 'memoria.db no se pudo abrir: no ejecutes update; revisa el respaldo' });
  if (ultimo && ultimo.status === 'RECOVERY_REQUIRED') acciones.push({ code: 'RECUPERACION', message: 'una actualización quedó en RECUPERACION_REQUERIDA: revisa .agentic/_update/tx/' + ultimo.op_id + '/ y repite con --ack-recovery' });
  if (ultimo && ultimo.status === 'ROLLED_BACK') acciones.push({ code: 'REVISAR_FALLO', message: 'la última actualización falló y se recuperó: revisa su informe' });
  if (ultimo && ultimo.status === 'UNVERIFIED') acciones.push({ code: 'VERIFICAR', message: 'la última actualización no se pudo verificar por completo' });
  if (conflictos.length) acciones.push({ code: 'CONFLICTOS', message: conflictos.length + ' archivo(s) se conservaron por tener cambios propios: compara su versión nueva (está aparte)' });
  if (!ultimo) acciones.push({ code: 'SIN_VERIFICACION', message: 'este proyecto no tiene una verificación de actualización registrada: ejecuta akdd update' });

  const memoriaPuedeTrabajar = !enCurso.in_progress && (esq.status === 'COMPLETE' || esq.status === 'SIN_BASE');
  return {
    status: 'OK',
    data: {
      installed_version: versionInstalada(root),
      service: { responds: true, note: 'este tablero está vivo' },
      memory: {
        can_work: memoriaPuedeTrabajar,
        reason: enCurso.in_progress ? 'UPDATE_EN_CURSO' : (memoriaPuedeTrabajar ? null : esq.status),
        update: enCurso,
      },
      schema: esq,
      last_verification: ultimo ? { status: ultimo.status, ok: ultimo.ok, finished_at: ultimo.finished_at, duration_ms: ultimo.duration_ms, versions: ultimo.versions, op_id: ultimo.op_id, report: ultimo.report ? rel(root, ultimo.report) : null, warnings: (ultimo.warnings || []).length, errors: (ultimo.errors || []).map((e) => ({ code: e.code, message: String(e.message || '').slice(0, 200) })), not_verified: ultimo.not_verified || [] } : null,
      memory_preserved: conservacion(ultimo, informe),
      customizations: { preserved: pagina, protected: protegidos.slice(0, LIMITE), conflicts: conflictos.length },
      backup: respaldo,
      actions_needed: acciones,
    },
    coverage,
  };
}

module.exports = { leer, esquema, updateEnCurso, versionInstalada };
