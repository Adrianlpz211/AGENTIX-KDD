'use strict';

/**
 * Orquestador de `akdd update` (3.20.1).
 *
 *   PREPARADO → RESPALDO_VERIFICADO → APLICANDO → VALIDANDO → CONFIRMADO
 *                                         └─ fallo → REVERTIDO | RECUPERACION_REQUERIDA
 *   (BLOQUEADO: no se aplicó nada)
 *
 * SQLite y el sistema de archivos no son una única transacción. Este módulo las
 * coordina con un journal persistente: la transacción de archivos NO se cierra
 * como aplicada hasta conocer el resultado de la migración y de las
 * verificaciones. La parte de BD es atómica (una transacción con registro de
 * migraciones); la de archivos se revierte con el journal.
 *
 * Estados externos: VERIFIED · VERIFIED_WITH_WARNINGS · NO_CHANGES_VERIFIED ·
 * BLOCKED · ROLLED_BACK · RECOVERY_REQUIRED · UNVERIFIED. En modo --check:
 * PLAN_READY · NO_CHANGES_NEEDED · BLOCKED.
 * Código de salida 0 solo para un resultado verificable.
 */

const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const chalk = require('chalk');
const ora = require('ora');
const { nodo, herramienta } = require('./run-safe');
const txm = require('./update-tx');
const classify = require('./update-classify');
const backup = require('./update-backup');
const verificador = require('./update-verify');
const manifest = require('./managed-manifest');

const GITHUB_REPO = 'Adrianlpz211/AGENTIX-KDD';
const REPO_URL = `https://github.com/${GITHUB_REPO}`;
const CLI_ROOT = path.join(__dirname, '..');

const SALIDA = {
  VERIFIED: 0, VERIFIED_WITH_WARNINGS: 0, NO_CHANGES_VERIFIED: 0, PLAN_READY: 0, NO_CHANGES_NEEDED: 0,
  BLOCKED: 1, UNVERIFIED: 2, ROLLED_BACK: 3, RECOVERY_REQUIRED: 4,
};

const codigo = (code, msg, extra) => { const e = new Error(msg); e.code = code; if (extra) Object.assign(e, extra); return e; };
const barra = (p) => String(p).split(path.sep).join('/');
const ahora = () => new Date().toISOString();
const norm = (t) => String(t).replace(/\r\n/g, '\n').trim();

// ─────────────────────────────── motor ────────────────────────────────────
/** Módulos del motor usados para la BD: los del paquete que se instala; si no los trae, los del CLI. */
function cargarMotor(dirStaging) {
  const necesarios = ['db-adapter.cjs', 'schema-catalog.cjs', 'memory-inventory.cjs', 'update-guard.cjs'];
  const candidatos = [dirStaging && path.join(dirStaging, '.agentic', 'grafo'), path.join(CLI_ROOT, '.agentic', 'grafo')].filter(Boolean);
  const dir = candidatos.find((d) => necesarios.every((n) => fs.existsSync(path.join(d, n))));
  if (!dir) throw codigo('MOTOR_NO_DISPONIBLE', 'ni el paquete ni la CLI traen los módulos de migración (db-adapter, schema-catalog, memory-inventory, update-guard)');
  return {
    dir,
    adapter: require(path.join(dir, 'db-adapter.cjs')),
    catalog: require(path.join(dir, 'schema-catalog.cjs')),
    inventory: require(path.join(dir, 'memory-inventory.cjs')),
    guard: require(path.join(dir, 'update-guard.cjs')),
  };
}

// ─────────────────────────────── resultado ────────────────────────────────
function nuevoResultado(opts, projectPath) {
  return {
    schema_version: 1, status: null, ok: false, exit_code: 1, mode: opts.check ? 'check' : 'update',
    op_id: opts.__opId || (ahora().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex')), project: projectPath,
    versions: { from: null, to: null }, source: null, started_at: ahora(), finished_at: null, duration_ms: null,
    plan: null, schema: null, backup: null, integrity: null, preservation: null, files: null, instructions: null,
    functional: null, recovery: null, hooks: null, warnings: [], errors: [], not_verified: [], coverage: { verified: [], not_executed: [] },
  };
}

function cerrarResultado(R, status, extra) {
  R.status = status;
  R.exit_code = SALIDA[status] !== undefined ? SALIDA[status] : 1;
  // Para el comando de rollback, ROLLED_BACK ES el éxito pedido (en un update es "falló y se recuperó").
  if (R.mode === 'rollback' && status === 'ROLLED_BACK') R.exit_code = 0;
  R.ok = R.exit_code === 0;
  R.finished_at = ahora();
  R.duration_ms = Date.parse(R.finished_at) - Date.parse(R.started_at);
  if (extra) Object.assign(R, extra);
  return R;
}

/** Informe local de la operación + resumen de la última actualización. */
function escribirInforme(projectPath, R, txDir) {
  try {
    const dir = txDir || path.join(txm.dirUpdate(projectPath), 'tx', R.op_id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'verification.json'), JSON.stringify(R, null, 2));
    const resumen = {
      schema_version: 1, op_id: R.op_id, status: R.status, ok: R.ok, mode: R.mode, finished_at: R.finished_at, duration_ms: R.duration_ms,
      versions: R.versions, schema: R.schema && { before: R.schema.before, after: R.schema.after, migrations: R.schema.migrations },
      preservation: R.preservation && { db: R.preservation.db && R.preservation.db.status, files: R.preservation.files && R.preservation.files.status },
      integrity: R.integrity, backup: R.backup && { path: R.backup.path, size: R.backup.size, sha256: R.backup.sha256 },
      files: R.files && { written: R.files.written, preserved: R.files.preserved, conflicts: R.files.conflicts },
      functional: R.functional && { ok: R.functional.ok, checks: (R.functional.checks || []).map((c) => ({ name: c.name, status: c.status })) },
      warnings: R.warnings, errors: R.errors, not_verified: R.not_verified, report: path.join(dir, 'verification.json'),
    };
    fs.writeFileSync(path.join(txm.dirUpdate(projectPath), 'last-result.json'), JSON.stringify(resumen, null, 2));
  } catch { /* el informe es evidencia: si no se puede escribir se avisa por la salida, no se rompe el update */ }
}

// ───────────────────────────────── fuente ─────────────────────────────────
async function obtenerFuente(opts, spinner) {
  let archivo = opts.archivo, commit = null, staging = null, descarga = null;
  if (!archivo && !opts.ref) {
    staging = txm.prepararBundle(opts.bundleRoot || CLI_ROOT).staging;
  } else if (!archivo) {
    const ref = opts.ref;
    if (spinner) spinner.text = `Resolving ${ref}...`;
    commit = txm.resolverRef(REPO_URL, ref);
    descarga = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-download-'));
    archivo = path.join(descarga, `${commit}.tar.gz`);
    if (spinner) spinner.text = `Downloading ${commit.slice(0, 12)}...`;
    herramienta('curl', ['-sfL', `${REPO_URL}/archive/${commit}.tar.gz`, '-o', archivo]);
  }
  const digest = staging
    ? txm.sha256(JSON.stringify(manifest.archivos(staging).map((rel) => [rel, txm.hashArchivo(path.join(staging, rel))])))
    : txm.hashArchivo(archivo);
  if (opts.sha256 && opts.sha256.toLowerCase() !== digest) throw codigo('INTEGRIDAD', `sha256 del archivo ${digest} ≠ esperado ${opts.sha256}`);
  if (!staging) staging = txm.prepararStaging(archivo);
  const valido = txm.validarStaging(staging);
  if (!valido.ok) throw codigo('STAGING_INVALIDO', 'la versión descargada no es válida:\n    ' + valido.problemas.slice(0, 10).join('\n    '));
  const origin = opts.archivo ? 'archive' : opts.ref ? 'github' : 'installed-package';
  return { staging, descarga, digest, commit, version: valido.version, origin };
}

function versionInstalada(projectPath) {
  try { return JSON.parse(fs.readFileSync(path.join(projectPath, '.agentic', 'grafo', 'framework.json'), 'utf8')).version || null; } catch { /* sin manifiesto */ }
  try { const m = /^\s*VERSION:\s*(\S+)/m.exec(fs.readFileSync(path.join(projectPath, '.agentic', 'config.md'), 'utf8')); return m ? m[1] : null; } catch { return null; }
}

// ───────────────────────────────── plan ───────────────────────────────────
/** Inspección SIN escribir: archivos, instrucciones y base. */
function planear(ctx) {
  const { projectPath, fuente, opts } = ctx;
  const upd = require('./update');
  const bloqueos = [];
  const proteccion = upd.guardiaProtegidos(projectPath, fuente.staging);
  if (!proteccion.ok) throw codigo('PROTEGIDOS', proteccion.message);
  const filtro = (rel) => proteccion.filtro(null, path.join(projectPath, rel));
  const owned = (() => { try { return JSON.parse(fs.readFileSync(txm.ownedPath(projectPath), 'utf8')); } catch { return { archivos: {} }; } })();
  const clasif = classify.clasificar({ projectPath, staging: fuente.staging, owned, filtro });
  bloqueos.push(...clasif.blockers);

  const plan = { classification: clasif, filtro, db: null, blockers: bloqueos, warnings: [] };
  const dbPath = path.join(projectPath, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) {
    plan.db = { present: false, note: 'el proyecto aún no tiene memoria.db: se creará al primer uso' };
    return plan;
  }
  const motor = ctx.motor;
  const sel = ctx.driverSel || (ctx.driverSel = motor.adapter.selectDriverForUpdate(opts.__driverCandidates));
  if (!sel.driver) {
    bloqueos.push({ code: 'DRIVER_NO_APTO', message: 'ningún conector SQLite supera las pruebas requeridas (lectura sin modificación, transacciones, bloqueo, respaldo con WAL, BLOB, INTEGER de 64 bits, multiproceso). ' +
      'Use Node >= 22.13 (node:sqlite) o instale better-sqlite3 compatible con su Node. Detalle: ' + sel.intentos.map((i) => `${i.driver}: ${i.failed[0] || 'no disponible'}`).join(' | ') });
    plan.db = { present: true, driver: null, attempts: sel.intentos.map((i) => ({ driver: i.driver, ok: i.ok, failed: i.failed })) };
    return plan;
  }
  let insp;
  try {
    const db = motor.adapter.openReadOnly(dbPath, { drivers: [sel.driver] });
    try { insp = motor.catalog.inspect(db); } finally { db.close(); }
  } catch (e) {
    bloqueos.push({ code: 'DB_ILEGIBLE', message: `memoria.db no se pudo inspeccionar (${e.message}). No se modifica nada.` });
    plan.db = { present: true, driver: sel.driver, error: e.message };
    return plan;
  }
  plan.db = { present: true, driver: sel.driver, inspection: insp };
  if (insp.status === 'NEWER_SCHEMA') bloqueos.push({ code: 'NEWER_SCHEMA', message: 'memoria.db tiene un esquema más nuevo que este motor (' + insp.newer_than_supported.map((n) => n.id).join(', ') + '): no se modifica nada. Actualice la CLI.' });
  if (insp.status === 'BLOCKED') for (const c of insp.conflicts) bloqueos.push({ code: 'SCHEMA_CONFLICT', message: c.message });
  if (insp.pending.length && opts.noMigrate) plan.warnings.push(`--no-migrate: ${insp.pending.length} migración(es) de esquema quedan pendientes: el proyecto NO quedará completamente actualizado`);
  return plan;
}

function resumenPlan(plan) {
  const c = plan.classification;
  const acc = {};
  for (const e of c.entries) acc[e.accion] = (acc[e.accion] || 0) + 1;
  return {
    files: { by_class: c.counts, by_action: acc, obsolete: (c.obsolete || []).map((o) => ({ file: o.rel, action: o.accion })), conflicts: c.conflicts, reliable_base: c.reliable_base, base: c.base },
    db: plan.db && plan.db.inspection ? {
      driver: plan.db.driver, status: plan.db.inspection.status, detected_level: plan.db.inspection.detected_level, supported_level: plan.db.inspection.supported_level,
      registry_present: plan.db.inspection.registry_present, user_version: plan.db.inspection.user_version, pending: plan.db.inspection.pending.map((p) => ({ id: p.id, ops: p.ops.map((o) => o.op) })),
      warnings: plan.db.inspection.warnings.map((w) => w.message), foreign_tables: plan.db.inspection.foreign_tables,
    } : plan.db,
    blockers: plan.blockers, warnings: plan.warnings,
  };
}

function hayCambios(plan, opts) {
  const c = plan.classification;
  if (c.entries.some((e) => e.accion === 'CREAR' || e.accion === 'ESCRIBIR' || e.accion === 'CONSERVAR_Y_APARTAR')) return true;
  if ((c.obsolete || []).some((o) => o.accion === 'BORRAR')) return true;
  const insp = plan.db && plan.db.inspection;
  if (insp && insp.pending.length && !opts.noMigrate) return true;
  if (insp && !insp.registry_present && !opts.noMigrate) return true; // falta el registro de migraciones: se adopta
  return false;
}

// ───────────────────────────── exclusión ─────────────────────────────────
async function tomarExclusion(ctx) {
  const { guard } = ctx.motor;
  // Los respaldos de memoria no pueden acabar en el Git de nadie: la carpeta se autoignora
  // (sin tocar el .gitignore del proyecto, que es suyo).
  fs.mkdirSync(txm.dirUpdate(ctx.projectPath), { recursive: true });
  const gi = path.join(txm.dirUpdate(ctx.projectPath), '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# estado de akdd update (respaldos verificados de la memoria, journals, informes): nunca se versiona\n*\n');
  const h = guard.acquire(ctx.projectPath, { opId: ctx.R.op_id, timeoutMs: ctx.opts.lockTimeoutMs, ttlMs: ctx.opts.lockTtlMs, phase: 'quiesce', command: 'update' });
  guard.startHeartbeat(h);
  ctx.lock = h;
  ctx.tokenAnterior = process.env.AKDD_UPDATE_TOKEN;
  process.env.AKDD_UPDATE_TOKEN = h.token;
  const w = await guard.waitForWriters(ctx.projectPath, ctx.R.op_id, ctx.opts.writerAckMs || 6000);
  if (!w.ok) {
    throw codigo('NO_PAUSE_ACK', 'hay servicios con conexión persistente que no confirmaron la pausa: ' + w.sinAck.map((x) => `${x.name} (pid ${x.pid})`).join(', ') + '. No se aplica nada; ciérrelos y repita.', { sinAck: w.sinAck });
  }
  ctx.R.coverage.verified.push(`exclusión de escritores: ${w.acked.length} servicio(s) confirmaron la pausa`);
  return w;
}

function liberarExclusion(ctx) {
  try { if (ctx.lock) ctx.motor.guard.release(ctx.lock); } catch { /* ya liberado */ }
  if (ctx.tokenAnterior === undefined) delete process.env.AKDD_UPDATE_TOKEN; else process.env.AKDD_UPDATE_TOKEN = ctx.tokenAnterior;
  ctx.lock = null;
}

/** Con el bloqueo tomado, una escritura inmediata prueba que ningún cliente externo tiene la base. */
function sondearEscritura(ctx) {
  const dbPath = path.join(ctx.projectPath, '.agentic', 'memoria.db');
  const db = ctx.motor.adapter.openWrite(dbPath, { drivers: [ctx.driver], updateOwner: true, busyTimeout: ctx.opts.busyMs || 1500 });
  try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); }
  catch (e) { throw codigo('DB_OCUPADA', 'memoria.db está tomada por otro proceso que no respeta el protocolo de exclusión (' + e.message + '). No se aplica nada.'); }
  finally { try { db.close(); } catch { /* cerrada */ } }
}

// ──────────────────────────── instrucciones ──────────────────────────────
function leerInstrucciones(projectPath) {
  const claude = path.join(projectPath, 'CLAUDE.md');
  const p = fs.existsSync(claude) ? classify.partirInstrucciones(fs.readFileSync(claude, 'utf8')) : { encontrado: false, usuario: '' };
  return { usuarioPrevio: p.usuario || '' };
}

/** Tras escribir CLAUDE.md: nada de lo propio puede desaparecer; si difiere, se fusiona sin perder ninguno. */
function reponerInstrucciones(projectPath, userInstrPath, usuarioPrevio, opId) {
  const claude = path.join(projectPath, 'CLAUDE.md');
  const archivoUsuario = fs.existsSync(userInstrPath) ? fs.readFileSync(userInstrPath, 'utf8') : '';
  const propio = archivoUsuario.trim();
  let anexo = '';
  if (propio) anexo += '\n' + propio + '\n';
  if (usuarioPrevio && !norm(propio).includes(norm(usuarioPrevio))) {
    anexo += `\n<!-- Texto que ya estaba debajo del marcador de CLAUDE.md (conservado por akdd update ${opId}) -->\n` + usuarioPrevio + '\n';
  }
  if (anexo) fs.appendFileSync(claude, anexo);
  const final = norm(fs.readFileSync(claude, 'utf8'));
  const faltan = [];
  if (propio && !final.includes(norm(propio))) faltan.push('.agentic/INSTRUCCIONES-PROYECTO.md');
  if (usuarioPrevio && !final.includes(norm(usuarioPrevio)) && !norm(propio).includes(norm(usuarioPrevio))) faltan.push('el texto previo de CLAUDE.md');
  if (faltan.length) throw codigo('INSTRUCCIONES_PERDIDAS', 'tras actualizar, desapareció texto propio: ' + faltan.join(', '));
  return { merged_previous_text: !!(usuarioPrevio && !norm(propio).includes(norm(usuarioPrevio))) };
}

// ───────────────────────────── pruebas de fallo ──────────────────────────
async function punto(ctx, nombre) {
  const h = ctx.opts.__hooks && ctx.opts.__hooks[nombre];
  if (h) await h(ctx);
  if (ctx.opts.__fallar === nombre) throw codigo('FALLO_INYECTADO', 'fallo inyectado en ' + nombre);
}

// ───────────────────────────── recuperación ──────────────────────────────
/** Vuelve a un estado verificado. Archivos: journal. Base: se conserva si prueba estar íntegra; se restaura solo si está corrupta. */
function recuperar(ctx, causa) {
  const { R, projectPath, motor } = ctx;
  const info = { cause: causa && causa.message, files: null, db: null };
  let ok = true;
  if (ctx.journal) {
    try {
      txm.marcarFase(ctx.journal, 'APLICANDO', 'recuperación: revertir archivos', 'journal.revertir');
      const rev = txm.revertir(projectPath, ctx.journal.archivo);
      txm.recargar(ctx.journal); // sin esto, marcarFase pisaría el estado 'revertido' con el 'aplicando' de la copia en memoria
      info.files = { reverted: rev.revertidos, conflicts: rev.conflictos };
      if (!rev.ok) ok = false;
    } catch (e) { info.files = { error: e.message }; ok = false; }
  }
  const dbPath = path.join(projectPath, '.agentic', 'memoria.db');
  if (ctx.backupMeta && ctx.driver && fs.existsSync(dbPath)) {
    try {
      const db = motor.adapter.openReadOnly(dbPath, { drivers: [ctx.driver] });
      let despues, integridad;
      try {
        integridad = db.get('PRAGMA integrity_check').integrity_check;
        despues = motor.inventory.takeInventory(db, { columnsFrom: ctx.invAntes });
      } finally { db.close(); }
      const cmp = ctx.invAntes ? motor.inventory.compare(ctx.invAntes, despues) : { ok: false, status: 'NO_VERIFICADO', problems: [] };
      if (integridad === 'ok' && cmp.ok) {
        info.db = { state: ctx.dbMigrated ? 'MIGRATED_KEPT_COMPATIBLE' : 'UNCHANGED', integrity: integridad, inventory: cmp.status, note: ctx.dbMigrated ? 'la base conserva la estructura aditiva ya migrada; los datos originales están intactos y el motor anterior la lee' : 'la base no cambió' };
      } else if (integridad !== 'ok') {
        const rest = backup.restaurarDesdeRespaldo({ projectPath, dbPath, meta: ctx.backupMeta, opId: R.op_id });
        info.db = { state: 'RESTORED_FROM_BACKUP', evidence: rest.evidence };
      } else {
        info.db = { state: 'INVENTORY_MISMATCH', problems: cmp.problems, note: 'la base está íntegra pero su contenido difiere del inventario previo: no se restaura a ciegas (podría haber datos nuevos). Revise el respaldo.' };
        ok = false;
      }
    } catch (e) { info.db = { state: 'RECOVERY_ERROR', error: e.message }; ok = false; }
  }
  if (ctx.journal) { try { txm.marcarFase(ctx.journal, ok ? 'REVERTIDO' : 'RECUPERACION_REQUERIDA', 'recuperación terminada', null); } catch { /* journal ya cerrado */ } }
  R.recovery = Object.assign({ verified: ok, backup: ctx.backupMeta && ctx.backupMeta.path, journal: ctx.journal && ctx.journal.archivo }, info);
  return ok;
}

// ─────────────────────────────── ejecución ────────────────────────────────
async function ejecutar(ctx) {
  const { opts, projectPath, R, spinner } = ctx;
  const upd = require('./update');
  const dbPath = path.join(projectPath, '.agentic', 'memoria.db');

  if (!fs.existsSync(path.join(projectPath, '.agentic', 'config.md'))) {
    R.errors.push({ code: 'NOT_INSTALLED', message: 'Agentic KDD is not installed in this project. Run akdd init to install it.' });
    return cerrarResultado(R, 'BLOCKED', { reason: 'NOT_INSTALLED' });
  }
  R.versions.from = versionInstalada(projectPath);

  // ── 1. fuente verificada ────────────────────────────────────────────────
  if (spinner) spinner.text = 'Preparing update...';
  ctx.fuente = await obtenerFuente(opts, spinner);
  const { fuente } = ctx;
  R.versions.to = fuente.version;
  R.source = { origin: fuente.origin, ref: opts.ref || null, commit: fuente.commit, sha256: fuente.digest, version: fuente.version };
  ctx.motor = cargarMotor(fuente.staging);

  // ── 2. plan (solo lectura) ──────────────────────────────────────────────
  if (spinner) spinner.text = 'Inspecting the project...';
  let plan = planear(ctx);
  ctx.driver = plan.db && plan.db.driver;
  R.plan = resumenPlan(plan);
  R.warnings.push(...plan.warnings);

  const pendientes = (() => {
    try { return fs.readdirSync(path.join(txm.dirUpdate(projectPath), 'tx')).filter((id) => { try { const d = JSON.parse(fs.readFileSync(path.join(txm.dirUpdate(projectPath), 'tx', id, 'journal.json'), 'utf8')); return d.estado === 'recuperacion_requerida' || d.estado === 'aplicando'; } catch { return false; } }); }
    catch { return []; }
  })();
  if (pendientes.length && !opts.check && !opts.ackRecovery) R.warnings.push(`hay ${pendientes.length} operación(es) anterior(es) sin cerrar: ${pendientes.join(', ')}`);

  if (opts.check) {
    if (plan.blockers.length) { R.errors.push(...plan.blockers); return cerrarResultado(R, 'BLOCKED', { reason: plan.blockers[0].code }); }
    return cerrarResultado(R, hayCambios(plan, opts) ? 'PLAN_READY' : 'NO_CHANGES_NEEDED', { reason: undefined });
  }
  if (plan.blockers.length) {
    R.errors.push(...plan.blockers);
    return cerrarResultado(R, 'BLOCKED', { reason: plan.blockers[0].code, message: plan.blockers[0].message });
  }

  // ── 3. nada que cambiar: verificación de solo lectura ───────────────────
  if (!hayCambios(plan, opts) && !pendientes.length) {
    return await sinCambios(ctx, plan);
  }

  // ── 4. exclusión de escritores ──────────────────────────────────────────
  if (spinner) spinner.text = 'Pausing writers...';
  await tomarExclusion(ctx);
  ctx.motor.guard.setPhase(ctx.lock, 'prepare');

  // Operaciones anteriores a medias: se recuperan ANTES de seguir.
  const recuperados = txm.recuperarPendientes(projectPath);
  if (recuperados.length) {
    R.recovered_previous = recuperados;
    for (const r of recuperados) R.warnings.push(`un update anterior quedó a medias (${r.id}, fase ${r.fase_al_morir || '?'}): revertidos ${r.revertidos} archivo(s)`);
    if (recuperados.some((r) => !r.ok)) {
      R.errors.push({ code: 'RECUPERACION_PREVIA_CON_CONFLICTOS', message: 'la recuperación de un update anterior encontró archivos editados después; resuélvalos a mano (están en el journal) y repita.' });
      return cerrarResultado(R, 'RECOVERY_REQUIRED', { reason: 'RECUPERACION_PREVIA_CON_CONFLICTOS' });
    }
  }
  if (opts.ackRecovery) {
    // La persona declara resuelta una recuperación pendiente.
    try {
      const f = path.join(txm.dirUpdate(projectPath), 'tx', opts.ackRecovery, 'journal.json');
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      d.estado = 'revertido'; d.fase = 'REVERTIDO'; d.reconocido_por_persona = ahora();
      fs.writeFileSync(f, JSON.stringify(d, null, 2));
    } catch (e) { R.warnings.push('no se pudo reconocer la recuperación ' + opts.ackRecovery + ': ' + e.message); }
  }
  const sinCerrar = (() => { try { return fs.readdirSync(path.join(txm.dirUpdate(projectPath), 'tx')).filter((id) => { try { return JSON.parse(fs.readFileSync(path.join(txm.dirUpdate(projectPath), 'tx', id, 'journal.json'), 'utf8')).estado === 'recuperacion_requerida'; } catch { return false; } }); } catch { return []; } })();
  if (sinCerrar.length) {
    R.errors.push({ code: 'RECUPERACION_PENDIENTE', message: `la operación ${sinCerrar.join(', ')} quedó en RECUPERACION_REQUERIDA. Revise .agentic/_update/tx/<id>/ y, cuando esté resuelta, repita con --ack-recovery=<id>.` });
    return cerrarResultado(R, 'BLOCKED', { reason: 'RECUPERACION_PENDIENTE' });
  }

  // Tras la exclusión se vuelve a planear: lo visto antes pudo cambiar.
  plan = planear(ctx);
  R.plan = resumenPlan(plan);
  if (plan.blockers.length) { R.errors.push(...plan.blockers); return cerrarResultado(R, 'BLOCKED', { reason: plan.blockers[0].code, message: plan.blockers[0].message }); }

  const hayDb = !!(plan.db && plan.db.present && plan.db.driver);
  if (hayDb) { try { sondearEscritura(ctx); } catch (e) { R.errors.push({ code: e.code, message: e.message }); return cerrarResultado(R, 'BLOCKED', { reason: e.code, message: e.message }); } }

  const bytesArchivos = plan.classification.entries.reduce((n, e) => n + (e.accion === 'NINGUNA' ? 0 : 1), 0) * 40000;
  const entorno = backup.comprobarEntorno({ projectPath, dbPath: hayDb ? dbPath : null, bytesArchivos });
  if (!entorno.ok) { R.errors.push(...entorno.problemas); return cerrarResultado(R, 'BLOCKED', { reason: entorno.problemas[0].code, message: entorno.problemas[0].message }); }
  R.coverage.verified.push('espacio y permisos de escritura comprobados antes de empezar');

  // ── 5. PREPARADO → RESPALDO_VERIFICADO ──────────────────────────────────
  const journal = txm.abrirJournal(projectPath, { op_id: R.op_id, ref: opts.ref || null, origin: fuente.origin, commit: fuente.commit, sha256: fuente.digest, version: fuente.version, from_version: R.versions.from, schema_level_before: plan.db && plan.db.inspection ? plan.db.inspection.detected_level : null });
  ctx.journal = journal;
  if (hayDb) {
    if (spinner) spinner.text = 'Backing up memory (verified)...';
    txm.marcarFase(journal, 'PREPARADO', 'respaldar memoria.db con VACUUM INTO y verificarlo', 'ninguno: aún no se modificó nada');
    ctx.backupMeta = backup.crearRespaldoDb({ adapter: ctx.motor.adapter, catalog: ctx.motor.catalog, driver: ctx.driver, dbPath, projectPath, opId: R.op_id });
    txm.pasoHecho(journal, { backup: ctx.backupMeta.path, sha256: ctx.backupMeta.sha256 });
    R.backup = ctx.backupMeta;
    txm.marcarFase(journal, 'RESPALDO_VERIFICADO', 'respaldo abierto y con integrity_check ok', 'restaurar el respaldo solo si la base queda corrupta');
    txm.pasoHecho(journal);
    // Inventario previo: contenido, objetos propios, secuencias, FK.
    const lector = ctx.motor.adapter.openReadOnly(dbPath, { drivers: [ctx.driver] });
    try {
      ctx.invAntes = ctx.motor.inventory.takeInventory(lector);
      ctx.declarado = ctx.motor.inventory.snapshotDeclarado(lector);
    } finally { lector.close(); }
    if (ctx.invAntes.ok === false) R.not_verified.push('inventario de memoria: ' + ctx.invAntes.reason);
    R.integrity = { before: { integrity_check: ctx.invAntes.integrity, foreign_key_check: ctx.invAntes.foreign_keys } };
  }
  const noEsFramework = (rel) => !manifest.esManaged(rel);
  ctx.archivosAntes = ctx.motor.inventory.inventoryFiles(projectPath, { incluir: noEsFramework });
  await punto(ctx, 'tras_respaldo');

  // ── 6. APLICANDO ────────────────────────────────────────────────────────
  ctx.motor.guard.setPhase(ctx.lock, 'apply');
  if (spinner) spinner.text = 'Updating system files (keeping your memory intact)...';
  const configPath = path.join(projectPath, '.agentic', 'config.md');
  const userInstrPath = path.join(projectPath, '.agentic', 'INSTRUCCIONES-PROYECTO.md');
  const userState = upd.preserveUserState(projectPath, configPath);
  const previoInstr = leerInstrucciones(projectPath);

  txm.marcarFase(journal, 'APLICANDO', 'respaldar y escribir archivos del framework según la clasificación', 'journal.revertir (no pisa ediciones externas)');
  txm.respaldar(journal, projectPath, barra(path.relative(projectPath, configPath)), 'config');
  txm.respaldar(journal, projectPath, '.agentic/INSTRUCCIONES-PROYECTO.md', 'instrucciones');
  upd.migrarInstruccionesUsuario(projectPath, userInstrPath);

  const res = txm.aplicar(projectPath, fuente.staging, journal, { filtro: plan.filtro, plan: plan.classification.entries, fallarTras: opts.fallarTras });
  ctx.res = res;
  if (fs.existsSync(userInstrPath) || previoInstr.usuarioPrevio) {
    if (res.escritos.includes('CLAUDE.md')) R.instructions = reponerInstrucciones(projectPath, userInstrPath, previoInstr.usuarioPrevio, R.op_id);
  }
  if (!R.instructions) R.instructions = { merged_previous_text: false };
  upd.restoreUserState(configPath, userState);
  txm.respaldar(journal, projectPath, '.agentic/_update/owned.json', 'registro');
  txm.pasoHecho(journal, { escritos: res.escritos.length });
  await punto(ctx, 'tras_archivos');

  // ── 7. migración de la base (UNA transacción, con registro) ─────────────
  let migracion = null;
  if (hayDb && !opts.noMigrate) {
    if (spinner) spinner.text = 'Migrating memory schema (compatible, additive)...';
    txm.marcarFase(journal, 'APLICANDO', 'migrar esquema de memoria.db en una transacción', 'la transacción revierte sola si falla; si ya confirmó la estructura aditiva se conserva');
    await punto(ctx, 'antes_migracion');
    const db = ctx.motor.adapter.openWrite(dbPath, { drivers: [ctx.driver], busyTimeout: opts.busyMs || 5000 });
    try {
      migracion = ctx.motor.catalog.apply(db, { version: fuente.version, actor: 'akdd update ' + R.op_id });
    } finally { db.close(); }
    ctx.dbMigrated = migracion.applied.length > 0 || migracion.adopted.length > 0;
    txm.pasoHecho(journal, { applied: migracion.applied.length, adopted: migracion.adopted.length });
    await punto(ctx, 'tras_migracion');
  }

  // ── 8. VALIDANDO ────────────────────────────────────────────────────────
  ctx.motor.guard.setPhase(ctx.lock, 'verify');
  if (spinner) spinner.text = 'Verifying (integrity, preserved memory, functional checks)...';
  txm.marcarFase(journal, 'VALIDANDO', 'integridad, conservación de registros y archivos, funcionamiento', 'recuperar(): archivos por journal; base según inventario');
  const validacion = await validar(ctx, plan, migracion);
  txm.pasoHecho(journal, { ok: validacion.ok });
  if (!validacion.ok) throw codigo('VERIFICACION_FALLIDA', 'la verificación posterior no superó: ' + validacion.problemas.join('; '), { problemas: validacion.problemas });
  await punto(ctx, 'tras_validacion');

  // ── 9. CONFIRMADO ───────────────────────────────────────────────────────
  txm.registrarOwned(projectPath, res.hashes, { version: fuente.version, commit: fuente.commit, sha256: fuente.digest }, ['CLAUDE.md']);
  txm.cerrarJournal(journal, { resumen: { escritos: res.escritos.length, sinCambios: res.sinCambios.length, personalizados: res.personalizados, protegidos: res.protegidos, obsoletosBorrados: res.obsoletosBorrados, obsoletosConservados: res.obsoletosConservados },
    schema_level_after: migracion ? ctx.motor.catalog.SUPPORTED_LEVEL : (plan.db && plan.db.inspection ? plan.db.inspection.detected_level : null), db_backup: ctx.backupMeta ? ctx.backupMeta.path : null });
  txm.podar(projectPath);
  backup.podarRespaldos(projectPath, { conservar: 3, activos: [R.op_id] });
  R.coverage.verified.push('transacción de archivos cerrada solo después de migrar y verificar');

  // Hooks de Git: opcionales y fuera del criterio de éxito; no pisan hooks ajenos.
  R.hooks = { status: 'OMITIDO' };
  try {
    const hooksJs = path.join(projectPath, '.agentic', 'grafo', 'install-hooks.cjs');
    if (opts.installHooks !== false && fs.existsSync(hooksJs)) {
      nodo(hooksJs, ['--quiet'], { cwd: projectPath, timeout: 15000 });
      R.hooks = { status: 'OK' };
    }
  } catch (e) { R.hooks = { status: 'FALLO', message: e.message }; R.warnings.push('hooks de Git no instalados (' + e.message + '): se ve con akdd health'); }

  // Hooks del HOST (Claude Code / Cursor): enriquecimiento sin aa:, guardia, avisos y registro del fin de turno. Solo los hosts que el
  // proyecto usa, con merge, y sin tocar uno que el dueño rechazó. Opt-out: AKDD_NO_HOST_HOOKS=1.
  R.host_hooks = { status: 'OMITIDO' };
  try {
    const hhJs = path.join(projectPath, '.agentic', 'grafo', 'host-hooks.cjs');
    if (opts.installHostHooks !== false && fs.existsSync(hhJs)) {
      nodo(hhJs, ['auto'], { cwd: projectPath, timeout: 15000 });
      R.host_hooks = { status: 'OK' };
    }
  } catch (e) { R.host_hooks = { status: 'FALLO', message: e.message }; R.warnings.push('hooks del host no instalados (' + e.message + '): corre akdd host-hooks install'); }

  // Mods de Claude Code: se refresca SOLO lo que el dueño ya tenía encendido (akdd mod on).
  R.mods = { status: 'OMITIDO' };
  try {
    const modsJs = path.join(projectPath, '.agentic', 'grafo', 'mods-manager.cjs');
    if (fs.existsSync(modsJs)) {
      nodo(modsJs, ['refresh', '--quiet'], { cwd: projectPath, timeout: 15000 });
      R.mods = { status: 'OK' };
    }
  } catch (e) { R.mods = { status: 'FALLO', message: e.message }; R.warnings.push('mods de Claude Code no refrescados (' + e.message + '): corre akdd mod on'); }

  const pasos = [];
  if (opts.deps) {
    try { herramienta('npm', ['rebuild', 'better-sqlite3'], { cwd: projectPath }); pasos.push('better-sqlite3 reconstruido'); }
    catch (e) { R.warnings.push('npm rebuild FALLÓ: ' + e.message); }
  }
  ctx.pasos = pasos;

  // Estado final
  const esquema = {
    before: plan.db && plan.db.inspection ? { status: plan.db.inspection.status, detected_level: plan.db.inspection.detected_level, pending: plan.db.inspection.pending.length } : null,
    after: validacion.esquemaDespues || null,
    migrations: migracion ? { applied: migracion.applied, adopted: migracion.adopted, dynamic_defaults: migracion.dynamic_defaults, data_changes: migracion.data_changes } : { applied: [], adopted: [], note: opts.noMigrate ? '--no-migrate' : 'sin base' },
  };
  R.schema = esquema;
  R.files = {
    written: res.escritos.length, unchanged: res.sinCambios.length, protected: res.protegidos, obsolete_removed: res.obsoletosBorrados, obsolete_kept: res.obsoletosConservados,
    preserved: plan.classification.entries.filter((e) => e.accion === 'CONSERVAR_Y_APARTAR').map((e) => ({ file: e.rel, clase: e.clase, motivo: e.motivo, new_version: barra(path.relative(projectPath, path.join(journal.dir, 'personalizados', e.rel))) })),
    conflicts: plan.classification.conflicts, edited_during_update: res.editadosDurante,
  };
  for (const c of plan.classification.conflicts) R.warnings.push(`conflicto: ${c.file} (${c.clase}) se conservó; la versión nueva quedó aparte`);
  for (const w of validacion.warnings || []) R.warnings.push(w);
  if (opts.noMigrate && plan.db && plan.db.inspection && plan.db.inspection.pending.length) {
    R.not_verified.push('esquema de memoria.db incompleto por --no-migrate');
    return cerrarResultado(R, 'UNVERIFIED', { reason: 'SCHEMA_PENDING', ...legado(ctx, fuente, res, journal) });
  }
  const huboCambios = res.escritos.length > 0 || (migracion && migracion.applied.length > 0) || res.obsoletosBorrados.length > 0;
  const estado = R.not_verified.length ? 'UNVERIFIED' : (R.warnings.length ? 'VERIFIED_WITH_WARNINGS' : (huboCambios ? 'VERIFIED' : 'NO_CHANGES_VERIFIED'));
  return cerrarResultado(R, estado, legado(ctx, fuente, res, journal));
}

/** Claves de la versión anterior de update(): los consumidores y pruebas existentes las usan. */
function legado(ctx, fuente, res, journal) {
  return Object.assign({ version: fuente.version, commit: fuente.commit, sha256: fuente.digest, journal: journal && journal.archivo, failedSteps: [] }, res ? {
    escritos: res.escritos, sinCambios: res.sinCambios, personalizados: res.personalizados, protegidos: res.protegidos, obsoletosBorrados: res.obsoletosBorrados, obsoletosConservados: res.obsoletosConservados, hashes: res.hashes,
  } : {});
}

// ──────────────────────────── validación posterior ───────────────────────
async function validar(ctx, plan, migracion) {
  const { projectPath, R, motor, opts } = ctx;
  const dbPath = path.join(projectPath, '.agentic', 'memoria.db');
  const problemas = [], warnings = [];
  let esquemaDespues = null;
  const hayDb = !!(plan.db && plan.db.present && plan.db.driver);

  if (hayDb) {
    const lector = motor.adapter.openReadOnly(dbPath, { drivers: [ctx.driver] });
    try {
      const despues = motor.inventory.takeInventory(lector, { columnsFrom: ctx.invAntes && ctx.invAntes.ok !== false ? ctx.invAntes : undefined });
      const cmp = motor.inventory.compare(ctx.invAntes, despues);
      const declarado = motor.inventory.verificarDeclarado(lector, ctx.declarado);
      const verif = opts.noMigrate ? { ok: true, problemas: [] } : motor.catalog.verify(lector);
      esquemaDespues = (() => { const r = motor.catalog.inspect(lector); return { status: r.status, detected_level: r.detected_level, pending: r.pending.length, warnings: r.warnings.map((w) => w.message) }; })();
      R.integrity = Object.assign(R.integrity || {}, { after: { integrity_check: despues.integrity, foreign_key_check: despues.foreign_keys } });
      R.preservation = Object.assign(R.preservation || {}, { db: { status: cmp.status, problems: cmp.problems, unverified: cmp.unverified, summary: cmp.summary, added_tables: cmp.info && cmp.info.added_tables, derived: cmp.info && cmp.info.derived, declared_rule: declarado.length ? declarado : 'cumplida' } });
      if (cmp.status === 'FAIL') problemas.push(...cmp.problems.map((p) => 'memoria: ' + p));
      if (cmp.status === 'NO_VERIFICADO') R.not_verified.push('conservación de registros: ' + (cmp.reason || cmp.unverified.join('; ') || 'sin detalle'));
      if (declarado.length) problemas.push(...declarado);
      if (!verif.ok) problemas.push(...verif.problemas.map((p) => 'esquema: ' + p));
      for (const w of esquemaDespues.warnings) warnings.push('esquema: ' + w);
      R.coverage.verified.push(`conservación de memoria: ${cmp.summary ? cmp.summary.compared : 0} tabla(s), ${cmp.summary ? cmp.summary.rows_compared : 0} fila(s) comparadas por contenido`);
    } finally { lector.close(); }
  }

  // Archivos propios del proyecto: ninguno cambia.
  const noEsFramework = (rel) => !manifest.esManaged(rel);
  const despuesF = motor.inventory.inventoryFiles(projectPath, { incluir: noEsFramework });
  const cmpF = motor.inventory.compareFiles(ctx.archivosAntes, despuesF, {});
  // Solo es un FALLO si el update tocó ese archivo (el journal anota todo lo que escribe, antes de escribirlo). Si cambió o desapareció
  // un archivo que el update nunca tocó, lo hizo otro programa mientras corría (un editor, Claude Code, Cursor, SQLite): se avisa y
  // se conserva como quedó, pero NO se revierte una actualización correcta por algo que no hizo.
  const tocados = new Set(((ctx.journal && ctx.journal.datos && ctx.journal.datos.entradas) || []).map((e) => e.rel));
  const detalleF = cmpF.detail || [];
  const porUpdate = detalleF.filter((x) => tocados.has(x.rel));
  const ajenos = detalleF.filter((x) => !tocados.has(x.rel));
  R.preservation = Object.assign(R.preservation || {}, { files: { status: porUpdate.length ? 'FAIL' : 'PASS', compared: cmpF.compared, problems: porUpdate.map((x) => `el archivo propio ${x.rel} ${x.tipo}`), external_changes: ajenos } });
  if (porUpdate.length) problemas.push(...porUpdate.map((x) => `el archivo propio ${x.rel} ${x.tipo}`));
  else R.coverage.verified.push(`archivos propios: ${cmpF.compared - ajenos.length} sin cambios`);
  for (const x of ajenos) warnings.push(`el archivo ${x.rel} ${x.tipo} mientras corría la actualización, pero el update no lo tocó (lo cambió otro programa): se conserva como quedó`);

  // Motor nuevo cargado: sus archivos esenciales existen y compilan.
  for (const rel of classify.ESENCIALES) {
    const abs = path.join(projectPath, rel);
    if (!fs.existsSync(abs)) { if (ctx.fuente && fs.existsSync(path.join(ctx.fuente.staging, rel))) problemas.push('motor: falta ' + rel); }
  }

  if (!opts.__sinFuncional) {
    const f = await verificador.verificarFuncional({ projectPath, cliRoot: CLI_ROOT, adapter: motor.adapter, driver: ctx.driver, expectedVersion: ctx.fuente.version, timeoutMs: opts.functionalTimeoutMs || 90000 });
    R.functional = f;
    if (!f.ok) problemas.push(...f.checks.filter((c) => c.status === 'FAIL').map((c) => `funcional ${c.name}: ${c.detail}`));
    warnings.push(...(f.warnings || []));
    for (const c of f.checks) if (c.status === 'SKIP') R.coverage.not_executed.push(`${c.name}: ${c.detail}`);
  } else {
    R.coverage.not_executed.push('verificación funcional omitida por la prueba');
  }
  return { ok: problemas.length === 0, problemas, warnings, esquemaDespues };
}

async function sinCambios(ctx, plan) {
  const { R, motor, projectPath, opts } = ctx;
  const dbPath = path.join(projectPath, '.agentic', 'memoria.db');
  const problemas = [];
  const hayDb = !!(plan.db && plan.db.present && plan.db.driver);
  if (hayDb) {
    const lector = motor.adapter.openReadOnly(dbPath, { drivers: [ctx.driver] });
    try {
      const v = motor.catalog.verify(lector);
      if (!v.ok) problemas.push(...v.problemas);
      const integ = lector.get('PRAGMA integrity_check').integrity_check;
      R.integrity = { after: { integrity_check: integ } };
      if (integ !== 'ok') problemas.push('integrity_check: ' + integ);
      R.schema = { before: { status: plan.db.inspection.status, detected_level: plan.db.inspection.detected_level, pending: 0 }, migrations: { applied: [], adopted: [] } };
    } finally { lector.close(); }
  }
  if (!opts.__sinFuncional) {
    const f = await verificador.verificarFuncional({ projectPath, cliRoot: CLI_ROOT, adapter: motor.adapter, driver: ctx.driver, expectedVersion: ctx.fuente.version, timeoutMs: opts.functionalTimeoutMs || 90000 });
    R.functional = f;
    if (!f.ok) problemas.push(...f.checks.filter((c) => c.status === 'FAIL').map((c) => `funcional ${c.name}: ${c.detail}`));
    R.warnings.push(...(f.warnings || []));
  }
  R.files = { written: 0, unchanged: plan.classification.entries.length, preserved: [], conflicts: [], protected: plan.classification.entries.filter((e) => e.accion === 'OMITIR').map((e) => e.rel) };
  if (problemas.length) { R.errors.push(...problemas.map((m) => ({ code: 'VERIFICACION_FALLIDA', message: m }))); return cerrarResultado(R, 'UNVERIFIED', { reason: 'VERIFICACION_FALLIDA', ...legado(ctx, ctx.fuente, null, null) }); }
  return cerrarResultado(R, R.warnings.length ? 'VERIFIED_WITH_WARNINGS' : 'NO_CHANGES_VERIFIED', { ...legado(ctx, ctx.fuente, { escritos: [], sinCambios: plan.classification.entries.map((e) => e.rel), personalizados: [], protegidos: [], obsoletosBorrados: [], obsoletosConservados: [], hashes: {} }, null) });
}

// ───────────────────────────────── salida ─────────────────────────────────
function imprimir(R) {
  const rojo = chalk.red, ama = chalk.yellow, ver = chalk.green, gris = chalk.gray;
  const etiqueta = { VERIFIED: ver('✔ Updated and verified'), VERIFIED_WITH_WARNINGS: ver('✔ Updated and verified') + ama(' (with warnings)'), NO_CHANGES_VERIFIED: ver('✔ Already up to date (verified)'), PLAN_READY: chalk.blue('Plan ready (nothing was modified)'), NO_CHANGES_NEEDED: ver('Nothing to update'), BLOCKED: rojo('✖ Blocked — nothing was changed'), UNVERIFIED: ama('⚠ Not verified'), ROLLED_BACK: ama('↺ Failed — recovered and verified'), RECOVERY_REQUIRED: rojo('✖ RECOVERY REQUIRED') };
  console.log('  ' + (etiqueta[R.status] || R.status) + gris(`  ${R.versions.from || '?'} → ${R.versions.to || '?'}`));
  if (R.files) console.log(gris(`  ${R.files.written} archivo(s) actualizados, ${R.files.unchanged} sin cambios`));
  if (R.files && R.files.protected && R.files.protected.length) console.log(ama(`  🔒 Protegidos (no se actualizaron): ${R.files.protected.join(', ')}`));
  if (R.files && R.files.preserved && R.files.preserved.length) {
    console.log(ama(`  ✋ Conservados por tener cambios propios o sin base fiable (${R.files.preserved.length}): ${R.files.preserved.map((p) => p.file).join(', ')}`));
    console.log(gris('     La versión nueva de cada uno quedó en .agentic/_update/tx/' + R.op_id + '/personalizados/'));
  }
  if (R.schema && R.schema.migrations && R.schema.migrations.applied) console.log(gris(`  · Esquema: ${R.schema.migrations.applied.length} migración(es) aplicada(s), ${(R.schema.migrations.adopted || []).length} adoptada(s) (estructura ya existente)`));
  if (R.preservation && R.preservation.db) console.log(gris(`  · Memoria: ${R.preservation.db.status} — ${R.preservation.db.summary ? R.preservation.db.summary.rows_compared + ' fila(s) comparadas por contenido' : 'sin detalle'}`));
  if (R.backup) console.log(gris(`  · Respaldo verificado: ${R.backup.path}`));
  for (const w of R.warnings) console.log(ama('  ! ' + w));
  for (const e of R.errors) console.log(rojo('  ✖ ' + (e.message || e)));
  for (const n of R.not_verified) console.log(ama('  ? No verificado: ' + n));
  if (R.recovery) console.log(gris('  · Recuperación: ' + JSON.stringify({ archivos: R.recovery.files && (R.recovery.files.conflicts && R.recovery.files.conflicts.length ? 'con conflictos' : 'revertidos'), base: R.recovery.db && R.recovery.db.state })));
  if (R.mode === 'update' && R.ok) console.log(gris('  · Tu memoria, config.md, conocimiento y PLAN.md se conservaron. Informe: .agentic/_update/last-result.json'));
  console.log('');
}

// ─────────────────────────────── API pública ──────────────────────────────
async function run(opts = {}) {
  const projectPath = path.resolve(opts.projectPath || process.cwd());
  const salir = opts.salir !== false;
  const R = nuevoResultado(opts, projectPath);
  const silencioso = !!(opts.json || opts.silent);
  const ctx = { opts, projectPath, R, spinner: null, motor: null, lock: null };
  if (!silencioso) console.log('\n' + chalk.bold.blue('  Agentic KDD') + chalk.gray(opts.check ? ' — checking update plan...\n' : ' — updating...\n'));
  if (!silencioso) ctx.spinner = ora({ text: 'Preparing update...', color: 'blue' }).start();

  try {
    await ejecutar(ctx);
  } catch (err) {
    R.errors.push({ code: err.code || 'ERROR', message: err.message });
    if (ctx.journal) {
      const ok = recuperar(ctx, err);
      cerrarResultado(R, ok ? 'ROLLED_BACK' : 'RECOVERY_REQUIRED', { reason: err.code || 'ERROR', message: err.message, revertidos: ctx.journal && R.recovery && R.recovery.files ? R.recovery.files.reverted : 0 });
    } else {
      // Sin journal no se modificó ningún archivo del proyecto: nada que recuperar.
      cerrarResultado(R, 'BLOCKED', { reason: err.code || 'ERROR', message: err.message, revertidos: 0 });
    }
  } finally {
    liberarExclusion(ctx);
    if (ctx.fuente && ctx.fuente.staging) fs.rmSync(ctx.fuente.staging, { recursive: true, force: true });
    if (ctx.fuente && ctx.fuente.descarga) fs.rmSync(ctx.fuente.descarga, { recursive: true, force: true });
  }
  if (!R.finished_at) cerrarResultado(R, R.status || 'UNVERIFIED');
  // El informe es evidencia: se escribe siempre que haya un proyecto Agentix (no en --check ni sin instalar).
  if (R.mode === 'update' && R.reason !== 'NOT_INSTALLED' && fs.existsSync(path.join(projectPath, '.agentic'))) {
    escribirInforme(projectPath, R, ctx.journal ? ctx.journal.dir : null);
  }
  if (ctx.spinner) {
    if (R.ok) ctx.spinner.succeed(chalk.green(`Updated to ${R.versions.to || 'unknown'}`));
    else if (R.status === 'BLOCKED') ctx.spinner.stop();
    else ctx.spinner.fail(chalk.red('Update ' + R.status));
  }
  if (opts.json) process.stdout.write(JSON.stringify(R, null, 2) + '\n');
  else if (!silencioso) imprimir(R);
  if (salir && R.exit_code) process.exit(R.exit_code);
  return R;
}

/**
 * Rollback posterior: revierte los ARCHIVOS de la última actualización aplicada.
 * La memoria se conserva SIEMPRE (no se restaura una base antigua ni se borran
 * aprendizajes nuevos). Se bloquea si el esquema cambió desde esa actualización
 * o si el motor anterior no puede leerlo. Restaurar datos históricos es otra
 * operación explícita, no esta.
 */
function rollbackUltima(opts = {}) {
  const projectPath = path.resolve(opts.projectPath || process.cwd());
  const R = nuevoResultado({ mode: 'rollback' }, projectPath);
  R.mode = 'rollback';
  const silencioso = !!(opts.json || opts.silent);
  const ctx = { opts, projectPath, R, motor: null, lock: null };
  try {
    ctx.motor = cargarMotor(null);
    const base = path.join(txm.dirUpdate(projectPath), 'tx');
    let ids = []; try { ids = fs.readdirSync(base).sort(); } catch { /* sin transacciones */ }
    let elegido = null;
    for (const id of ids.reverse()) {
      const f = path.join(base, id, 'journal.json');
      let d = null; try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      if (d.estado === 'aplicado') { elegido = { id, f, d }; break; }
    }
    if (!elegido) { R.errors.push({ code: 'SIN_TRANSACCION', message: 'No hay ninguna actualización aplicada que revertir.' }); cerrarResultado(R, 'BLOCKED', { reason: 'SIN_TRANSACCION' }); }
    else {
      R.versions = { from: elegido.d.version || null, to: elegido.d.from_version || null };
      const dbPath = path.join(projectPath, '.agentic', 'memoria.db');
      let compat = { checked: false };
      if (fs.existsSync(dbPath)) {
        const sel = ctx.motor.adapter.selectDriverForUpdate();
        if (!sel.driver) throw codigo('DRIVER_NO_APTO', 'ningún conector SQLite apto para comprobar la compatibilidad del esquema');
        const db = ctx.motor.adapter.openReadOnly(dbPath, { drivers: [sel.driver] });
        try {
          const insp = ctx.motor.catalog.inspect(db);
          const nivelUpdate = elegido.d.schema_level_after;
          compat = { checked: true, current_level: insp.detected_level, level_after_that_update: nivelUpdate, status: insp.status };
          if (insp.status === 'NEWER_SCHEMA' || (nivelUpdate !== null && nivelUpdate !== undefined && insp.detected_level !== null && insp.detected_level > nivelUpdate)) {
            throw codigo('ESQUEMA_POSTERIOR', 'el esquema de memoria.db cambió DESPUÉS de esa actualización (nivel ' + insp.detected_level + ' > ' + nivelUpdate + '): volver a un motor anterior podría no poder leerlo. Rollback bloqueado; la memoria no se tocó.');
          }
          if (insp.status === 'BLOCKED') throw codigo('SCHEMA_CONFLICT', 'conflictos de esquema pendientes: ' + insp.conflicts.map((c) => c.message).join('; '));
          compat.engine_reads_schema = 'additive_only: el motor anterior lee tablas y columnas añadidas';
        } finally { db.close(); }
      }
      const h = ctx.motor.guard.acquire(projectPath, { opId: R.op_id, timeoutMs: opts.lockTimeoutMs, phase: 'rollback', command: 'rollback' });
      ctx.lock = h; ctx.motor.guard.startHeartbeat(h);
      const rev = txm.revertir(projectPath, elegido.f);
      R.recovery = { journal: elegido.f, files: { reverted: rev.revertidos, conflicts: rev.conflictos }, db: { state: 'UNTOUCHED', note: 'la memoria no se restaura ni se borra al volver atrás: solo se revierten archivos del framework' }, schema_compat: compat };
      R.files = { written: rev.revertidos, unchanged: 0, preserved: [], conflicts: rev.conflictos };
      if (!rev.ok) { R.errors.push({ code: 'CONFLICTOS_DE_REVERSION', message: 'archivos editados después de la actualización se dejaron como están: ' + rev.conflictos.map((c) => c.file).join(', ') }); cerrarResultado(R, 'RECOVERY_REQUIRED', { reason: 'CONFLICTOS_DE_REVERSION' }); }
      else cerrarResultado(R, 'ROLLED_BACK', { id: elegido.id, revertidos: rev.revertidos, journal: elegido.f });
    }
  } catch (err) {
    R.errors.push({ code: err.code || 'ERROR', message: err.message });
    cerrarResultado(R, 'BLOCKED', { reason: err.code || 'ERROR', message: err.message });
  } finally {
    try { if (ctx.lock) ctx.motor.guard.release(ctx.lock); } catch { /* ya liberado */ }
  }
  if (opts.json) process.stdout.write(JSON.stringify(R, null, 2) + '\n');
  else if (!silencioso) {
    if (R.status === 'ROLLED_BACK') console.log(chalk.green(`  ↺ Revertida la actualización ${R.id}: ${R.revertidos} archivo(s) restaurados.`) + chalk.gray(' La memoria no se tocó.'));
    else for (const e of R.errors) console.log(chalk.yellow('  ' + e.message));
  }
  if (opts.salir === true && R.exit_code) process.exit(R.exit_code); // solo la CLI sale; el API devuelve el resultado
  return Object.assign({ ok: R.status === 'ROLLED_BACK', reason: R.status === 'ROLLED_BACK' ? undefined : (R.reason === 'SIN_TRANSACCION' ? 'SIN_TRANSACCION' : R.reason) }, R);
}

module.exports = { run, rollbackUltima, planear, cargarMotor, SALIDA, resumenPlan, escribirInforme };
