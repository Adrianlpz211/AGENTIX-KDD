'use strict';

/**
 * Respaldo consistente de memoria.db para `akdd update` (3.20.1).
 *
 *   · El respaldo lo genera el MOTOR SQLite (VACUUM INTO): incluye los commits
 *     que aún viven en el -wal. Copiar solo memoria.db no los incluiría.
 *   · Un respaldo no cuenta hasta que se ABRE y supera integrity_check.
 *   · Se registra ruta, tamaño, sha256 y esquema.
 *   · Antes de empezar se comprueba espacio y permisos de escritura.
 *   · La retención jamás borra el respaldo de una operación en curso, el último
 *     respaldo verificado necesario para recuperarla, ni uno marcado para
 *     investigación (archivo .keep).
 *   · No se borran -wal ni -shm "para arreglar" una base.
 *   · Nada de esto viaja en npm ni en Git (.agentic/_update/ está ignorado).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dirUpdate = (projectPath) => path.join(projectPath, '.agentic', '_update');
const dirBackups = (projectPath) => path.join(dirUpdate(projectPath), 'backups');

function sha256Archivo(f) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(f, 'r');
  try {
    const b = Buffer.allocUnsafe(1 << 20);
    for (;;) { const n = fs.readSync(fd, b, 0, b.length, null); if (!n) break; h.update(b.subarray(0, n)); }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function tamano(f) { try { return fs.statSync(f).size; } catch { return 0; } }

/** Bytes libres del volumen que contiene `dir`; null si el runtime no lo ofrece. */
function espacioLibre(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return null; }
}

/**
 * Antes del primer cambio: permisos de escritura y espacio. El espacio que hace
 * falta es el respaldo de la base, la copia aislada para la verificación
 * funcional y los respaldos de archivos, con margen.
 */
function comprobarEntorno({ projectPath, dbPath, bytesArchivos = 0 }) {
  const problemas = [];
  const base = dirUpdate(projectPath);
  try {
    fs.mkdirSync(base, { recursive: true });
    const sonda = path.join(base, '.sonda-' + process.pid);
    fs.writeFileSync(sonda, 'x'); fs.rmSync(sonda, { force: true });
  } catch (e) {
    problemas.push({ code: 'SIN_PERMISO', message: `no se puede escribir en ${base}: ${e.message}` });
  }
  const db = dbPath && fs.existsSync(dbPath) ? tamano(dbPath) + tamano(dbPath + '-wal') : 0;
  const necesario = Math.ceil(db * 2.5 + bytesArchivos * 2 + 20 * 1024 * 1024);
  const libre = espacioLibre(base);
  if (libre !== null && libre < necesario) {
    problemas.push({ code: 'DISCO_INSUFICIENTE', message: `hacen falta ~${Math.ceil(necesario / 1048576)} MB libres y hay ${Math.floor(libre / 1048576)} MB` });
  }
  return { ok: problemas.length === 0, problemas, necesario, libre };
}

/**
 * Crea y VERIFICA el respaldo. `adapter` es el db-adapter; `driver` el elegido
 * por selectDriverForUpdate. Lanza si el respaldo no se puede abrir o no es íntegro.
 */
function crearRespaldoDb({ adapter, catalog, driver, dbPath, projectPath, opId }) {
  const destDir = path.join(dirBackups(projectPath), opId);
  const destino = path.join(destDir, 'memoria.db');
  fs.mkdirSync(destDir, { recursive: true });

  const origen = adapter.openReadOnly(dbPath, { drivers: [driver] });
  try { origen.backupTo(destino); } finally { origen.close(); }

  const copia = adapter.openReadOnly(destino, { drivers: [driver] });
  let integridad, quick, version, esquema = null, tablas = 0;
  try {
    integridad = copia.get('PRAGMA integrity_check').integrity_check;
    quick = copia.get('PRAGMA quick_check').quick_check;
    version = Number((copia.get('PRAGMA user_version') || {}).user_version || 0);
    tablas = Number(copia.get("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").n);
    if (catalog) { const r = catalog.inspect(copia); esquema = { status: r.status, detected_level: r.detected_level, pending: r.pending.length }; }
  } finally { copia.close(); }
  if (integridad !== 'ok' || quick !== 'ok') {
    const e = new Error(`el respaldo no superó integrity_check (${integridad}/${quick}): no se continúa`);
    e.code = 'RESPALDO_NO_VERIFICADO';
    throw e;
  }
  const meta = {
    op_id: opId, path: destino, size: tamano(destino), sha256: sha256Archivo(destino), integrity: integridad,
    user_version: version, tables: tablas, schema: esquema, created_at: new Date().toISOString(), driver, source_size: tamano(dbPath),
  };
  fs.writeFileSync(path.join(destDir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

/** ¿El respaldo sigue siendo el mismo archivo verificado? */
function respaldoIntacto(meta) {
  try { return fs.existsSync(meta.path) && sha256Archivo(meta.path) === meta.sha256; } catch { return false; }
}

/**
 * Retención. Nunca borra: la operación en curso, respaldos de transacciones no
 * cerradas, el último verificado, ni los marcados con .keep. `activos` = ids.
 */
function podarRespaldos(projectPath, { conservar = 3, activos = [] } = {}) {
  const base = dirBackups(projectPath);
  let ids = [];
  try { ids = fs.readdirSync(base).sort(); } catch { return []; }
  const txBase = path.join(dirUpdate(projectPath), 'tx');
  const abiertas = new Set(activos);
  try {
    for (const id of fs.readdirSync(txBase)) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(txBase, id, 'journal.json'), 'utf8'));
        if (d.estado === 'aplicando' || d.estado === 'recuperacion_requerida') abiertas.add(d.op_id || id);
      } catch { /* journal ilegible: se trata como abierto por prudencia */ abiertas.add(id); }
    }
  } catch { /* sin transacciones */ }
  const verificados = ids.filter((id) => fs.existsSync(path.join(base, id, 'meta.json')));
  const ultimo = verificados[verificados.length - 1];
  const borrables = ids.filter((id) => id !== ultimo && !abiertas.has(id) && !fs.existsSync(path.join(base, id, '.keep')));
  const sobran = borrables.slice(0, Math.max(0, ids.length - conservar));
  const borrados = [];
  for (const id of sobran) {
    if (abiertas.has(id) || id === ultimo) continue;
    try { fs.rmSync(path.join(base, id), { recursive: true, force: true }); borrados.push(id); } catch { /* en uso */ }
  }
  return borrados;
}

/**
 * Restauración histórica de la base desde un respaldo VERIFICADO. Operación de
 * último recurso (base corrupta): exige exclusión ya tomada por quien la llama.
 * No reemplaza una base abierta: si el sistema operativo no deja apartarla, falla.
 * La base y sus -wal/-shm se APARTAN como evidencia, no se borran.
 */
function restaurarDesdeRespaldo({ projectPath, dbPath, meta, opId }) {
  if (!respaldoIntacto(meta)) { const e = new Error('el respaldo cambió desde que se verificó: no se restaura'); e.code = 'RESPALDO_ALTERADO'; throw e; }
  const evidencia = path.join(dirUpdate(projectPath), 'evidence', opId + '-' + Date.now());
  fs.mkdirSync(evidencia, { recursive: true });
  for (const suf of ['', '-wal', '-shm']) {
    const f = dbPath + suf;
    if (fs.existsSync(f)) fs.renameSync(f, path.join(evidencia, path.basename(f))); // falla si otro proceso la tiene abierta
  }
  fs.copyFileSync(meta.path, dbPath);
  if (sha256Archivo(dbPath) !== meta.sha256) { const e = new Error('la base restaurada no coincide con el respaldo'); e.code = 'RESTAURACION_INCOMPLETA'; throw e; }
  return { ok: true, evidence: evidencia };
}

module.exports = { comprobarEntorno, crearRespaldoDb, respaldoIntacto, podarRespaldos, restaurarDesdeRespaldo, sha256Archivo, espacioLibre, dirBackups, dirUpdate };
