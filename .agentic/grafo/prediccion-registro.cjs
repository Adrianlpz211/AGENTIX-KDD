'use strict';

/**
 * Registro y calificación de las predicciones.
 *
 * EL HUECO QUE CIERRA
 * -------------------
 * `prediccion.cjs` estima el riesgo de una tarea antes de tocarla, y el
 * enricher lo llama en cada ciclo. La tabla `prediction_log` existe desde el
 * principio, con una columna llamada `fue_correcto`.
 *
 * Tenía CERO filas. Nadie insertaba nunca. O sea: el sistema predecía y **nadie
 * sabía si acertaba**. Una predicción que no se apunta no es una predicción: es
 * una opinión que se olvida.
 *
 * CÓMO SE CALIFICA, Y POR QUÉ ASÍ
 * -------------------------------
 * Aquí está la decisión difícil, y merece explicarse porque lo obvio es un
 * error. Lo obvio sería: "predijo ALTO y no pasó nada → falsa alarma".
 *
 * Es falso. **Un aviso atendido previene el problema.** Si el sistema dice
 * "cuidado con esto" y el dev tiene cuidado y no se rompe nada, castigar al
 * sistema es castigarlo por funcionar. Ese es el error clásico al medir
 * cualquier alerta, y produce el resultado peor posible: bajar la sensibilidad
 * hasta que la alerta deja de avisar de nada.
 *
 * Así que solo se califica lo que tiene verdad conocida:
 *
 *   predijo ALTO/MEDIO  ·  hubo problema   → ACIERTO   (fue_correcto = 1)
 *   predijo BAJO        ·  sin problema    → ACIERTO   (fue_correcto = 1)
 *   predijo BAJO        ·  HUBO problema   → FALLO     (fue_correcto = 0)
 *   predijo ALTO/MEDIO  ·  sin problema    → SIN VERDAD (fue_correcto = NULL)
 *
 * LA MÉTRICA QUE IMPORTA ES EL FALSO NEGATIVO: predijo BAJO y se rompió. Ese no
 * admite interpretación — el sistema dijo "tranquilo" y no lo estaba. Es el
 * único número que se puede exigir que baje.
 *
 *   node .agentic/grafo/prediccion-registro.cjs precision
 *   node .agentic/grafo/prediccion-registro.cjs listar [n]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

/* Ventana para emparejar una predicción con el ciclo que cerró. Una predicción
   de hace dos días no es la de este ciclo: es una que quedó huérfana porque
   aquel trabajo se abandonó. */
const VENTANA_HORAS = 12;

function openDB(root, { write = true } = {}) {
  const p = path.join(root, '.agentic', 'memoria.db');
  if (!fs.existsSync(p)) return null;
  try {
    const BS3 = require('better-sqlite3');
    return write ? new BS3(p) : new BS3(p, { readonly: true });
  } catch {}
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(p, write ? {} : { readOnly: true });
  } catch {}
  return null;
}

function asegurarEsquema(db) {
  safe(() => db.exec(`CREATE TABLE IF NOT EXISTS prediction_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tarea           TEXT,
    modulo          TEXT,
    archivos        TEXT,
    nivel_predicho  TEXT,
    alertas         TEXT,
    precondiciones  TEXT,
    fue_correcto    INTEGER,
    ciclo_id        TEXT,
    fecha           TEXT DEFAULT (datetime('now'))
  )`));
  /* Columnas de la calificación. ALTER falla si ya existen: se ignora. */
  for (const col of ['hubo_problema INTEGER', 'evidencia TEXT', 'evaluado_en TEXT',
                     'prediccion_id TEXT']) {
    safe(() => db.exec(`ALTER TABLE prediction_log ADD COLUMN ${col}`));
  }
}

/* ── al empezar: apuntar la predicción ─────────────────────────────────────── */

/**
 * Guarda lo que el sistema predijo, ANTES de que se toque nada.
 *
 * Se llama desde el enricher (paso 0.1 del pipeline), que ya corre siempre. Va
 * pegado a algo que ya ocurre: si dependiera de un comando aparte, no ocurriría
 * — la misma lección que el reloj y la memoria de diseño.
 *
 * @returns el id de la predicción, o null si no se pudo apuntar (fail-soft: la
 *          predicción es un plus, nunca un requisito para trabajar).
 */
function registrarPrediccion(root, datos) {
  const db = openDB(root);
  if (!db) return null;
  try {
    asegurarEsquema(db);
    const pid = 'pred-' + crypto.randomBytes(6).toString('hex');
    db.prepare(`
      INSERT INTO prediction_log
        (prediccion_id, tarea, modulo, archivos, nivel_predicho, alertas, precondiciones)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      pid,
      String(datos.tarea || '').slice(0, 500),
      String(datos.modulo || 'global'),
      JSON.stringify(datos.archivos || []),
      String(datos.nivel || 'BAJO').toUpperCase(),
      JSON.stringify(datos.alertas || []),
      JSON.stringify(datos.precondiciones || [])
    );
    return pid;
  } catch { return null; }
  finally { safe(() => db.close()); }
}

/* ── al cerrar: ¿acertó? ───────────────────────────────────────────────────── */

/**
 * ¿Pasó algo malo durante el ciclo?
 *
 * Se mira lo que dejan los controles mecánicos, no una impresión. Cuatro
 * fuentes, todas escritas por máquinas:
 *   · gate_events con veredicto STOP          — un control frenó
 *   · contract_violations                     — algo verde se rompió
 *   · WARN_REVERSION de la memoria de diseño  — se revirtió una decisión
 *   · el propio ciclo con stops_count > 0
 */
function huboProblema(db, desde) {
  const pruebas = [];

  const stops = safe(() => db.prepare(
    `SELECT gate, COUNT(*) n FROM gate_events
      WHERE verdict = 'STOP' AND ts >= ? GROUP BY gate`
  ).all(desde), []) || [];
  for (const s of stops) pruebas.push(`${s.n} STOP de ${s.gate}`);

  const roturas = safe(() => db.prepare(
    'SELECT COUNT(*) n FROM contract_violations WHERE created_at >= ?'
  ).get(desde), null);
  if (roturas && roturas.n > 0) pruebas.push(`${roturas.n} contrato(s) roto(s)`);

  const revs = safe(() => db.prepare(
    `SELECT COUNT(*) n FROM gate_events
      WHERE verdict = 'WARN_REVERSION' AND ts >= ?`
  ).get(desde), null);
  if (revs && revs.n > 0) pruebas.push(`${revs.n} reversión(es) de diseño`);

  const st = safe(() => db.prepare(
    'SELECT SUM(stops_count) n FROM ciclos WHERE fecha_fin >= ?'
  ).get(desde), null);
  if (st && st.n > 0) pruebas.push(`${st.n} parada(s) registrada(s) en el ciclo`);

  return { hubo: pruebas.length > 0, evidencia: pruebas.join(' · ') };
}

/**
 * Califica las predicciones abiertas y las liga al ciclo que acaba de cerrar.
 *
 * @returns {evaluadas, aciertos, falsosNegativos, sinVerdad}
 */
function evaluarPendientes(root, cicloId) {
  const db = openDB(root);
  if (!db) return { evaluadas: 0 };
  try {
    asegurarEsquema(db);

    const abiertas = safe(() => db.prepare(`
      SELECT id, prediccion_id, nivel_predicho, fecha FROM prediction_log
       WHERE evaluado_en IS NULL
         AND fecha >= datetime('now', '-' || ? || ' hours')
       ORDER BY id`
    ).all(VENTANA_HORAS), []) || [];

    if (!abiertas.length) return { evaluadas: 0 };

    const res = { evaluadas: 0, aciertos: 0, falsosNegativos: 0, sinVerdad: 0 };

    for (const p of abiertas) {
      const { hubo, evidencia } = huboProblema(db, p.fecha);
      const alto = /ALTO|MEDIO/i.test(String(p.nivel_predicho));

      /* La tabla de verdad. Ver la cabecera de este archivo para el motivo del
         caso NULL — no es pereza, es que no hay verdad que registrar. */
      let correcto;
      if (hubo) correcto = alto ? 1 : 0;
      else correcto = alto ? null : 1;

      safe(() => db.prepare(`
        UPDATE prediction_log
           SET fue_correcto = ?, hubo_problema = ?, evidencia = ?,
               ciclo_id = COALESCE(ciclo_id, ?), evaluado_en = datetime('now')
         WHERE id = ?`
      ).run(correcto, hubo ? 1 : 0, evidencia || null, cicloId || null, p.id));

      res.evaluadas++;
      if (correcto === 1) res.aciertos++;
      else if (correcto === 0) res.falsosNegativos++;
      else res.sinVerdad++;
    }
    return res;
  } catch { return { evaluadas: 0 }; }
  finally { safe(() => db.close()); }
}

/* ── el informe ────────────────────────────────────────────────────────────── */

function precision(root) {
  const db = openDB(root, { write: false });
  if (!db) return { error: 'sin memoria.db' };
  try {
    const t = safe(() => db.prepare('SELECT COUNT(*) n FROM prediction_log').get().n, 0);
    const evaluadas = safe(() => db.prepare(
      'SELECT COUNT(*) n FROM prediction_log WHERE evaluado_en IS NOT NULL').get().n, 0);
    const conVerdad = safe(() => db.prepare(
      'SELECT COUNT(*) n FROM prediction_log WHERE fue_correcto IS NOT NULL').get().n, 0);
    const aciertos = safe(() => db.prepare(
      'SELECT COUNT(*) n FROM prediction_log WHERE fue_correcto = 1').get().n, 0);
    const falsosNeg = safe(() => db.prepare(
      'SELECT COUNT(*) n FROM prediction_log WHERE fue_correcto = 0').get().n, 0);
    const sinVerdad = safe(() => db.prepare(
      "SELECT COUNT(*) n FROM prediction_log WHERE evaluado_en IS NOT NULL AND fue_correcto IS NULL").get().n, 0);

    const porNivel = safe(() => db.prepare(`
      SELECT nivel_predicho nivel,
             COUNT(*) total,
             SUM(CASE WHEN hubo_problema = 1 THEN 1 ELSE 0 END) con_problema
        FROM prediction_log WHERE evaluado_en IS NOT NULL
       GROUP BY nivel_predicho ORDER BY total DESC`).all(), []) || [];

    return {
      total: t, evaluadas, conVerdad, aciertos, falsosNegativos: falsosNeg, sinVerdad,
      /* Sobre las que TIENEN verdad conocida. Meter las NULL en el
         denominador haría bajar el número por avisos que funcionaron. */
      acierto: conVerdad ? Math.round((aciertos / conVerdad) * 100) : null,
      porNivel,
    };
  } finally { safe(() => db.close()); }
}

const listar = (root, n = 10) => {
  const db = openDB(root, { write: false });
  if (!db) return [];
  try {
    return safe(() => db.prepare(`
      SELECT prediccion_id, tarea, modulo, nivel_predicho, hubo_problema,
             fue_correcto, evidencia, fecha
        FROM prediction_log ORDER BY id DESC LIMIT ?`).all(n), []) || [];
  } finally { safe(() => db.close()); }
};

/* ── CLI ───────────────────────────────────────────────────────────────────── */

if (require.main === module) {
  const cmd = process.argv[2] || 'precision';
  const root = process.cwd();

  if (cmd === 'listar') {
    const filas = listar(root, Number(process.argv[3]) || 10);
    if (!filas.length) { console.log('  Sin predicciones registradas todavía.'); process.exit(0); }
    for (const f of filas) {
      const veredicto = f.evaluado_en === null && f.fue_correcto === undefined ? '' :
        f.fue_correcto === 1 ? '✅ acertó'
        : f.fue_correcto === 0 ? '🔴 FALSO NEGATIVO'
        : f.hubo_problema === null ? '⏳ sin evaluar' : '➖ sin verdad conocida';
      console.log(`  ${String(f.fecha).slice(0, 16)}  [${String(f.nivel_predicho).padEnd(5)}] ` +
        `${veredicto.padEnd(20)} ${String(f.tarea || '').slice(0, 54)}`);
      if (f.evidencia) console.log(`      └ ${f.evidencia}`);
    }
    process.exit(0);
  }

  const p = precision(root);
  if (p.error) { console.log('  ' + p.error); process.exit(0); }

  console.log('');
  console.log('  PRECISIÓN DE LA PREDICCIÓN');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  predicciones apuntadas      ${p.total}`);
  console.log(`  ya calificadas              ${p.evaluadas}`);
  console.log('');
  if (!p.conVerdad) {
    console.log('  Todavía no hay ninguna con verdad conocida.');
    console.log('  Hace falta que se cierren ciclos: la calificación sale de comparar');
    console.log('  lo que se predijo con lo que registraron los controles.');
  } else {
    console.log(`  aciertos                    ${p.aciertos}`);
    console.log(`  FALSOS NEGATIVOS            ${p.falsosNegativos}   ← el único número que se puede exigir que baje`);
    console.log(`  sin verdad conocida         ${p.sinVerdad}   (avisó y no pasó nada: puede ser que funcionara)`);
    console.log('');
    console.log(`  acierto sobre lo comprobable   ${p.acierto}%`);
  }
  if (p.porNivel.length) {
    console.log('');
    console.log('  por nivel predicho:');
    for (const n of p.porNivel) {
      console.log(`    ${String(n.nivel).padEnd(6)} ${String(n.total).padStart(4)} ciclo(s), ` +
        `${n.con_problema} con problema real`);
    }
  }
  console.log('');
  console.log('  Un falso negativo es el sistema diciendo "tranquilo" y rompiéndose algo.');
  console.log('  Es el único caso sin interpretación posible.');
  console.log('');
  process.exit(0);
}

module.exports = {
  registrarPrediccion, evaluarPendientes, precision, listar,
  huboProblema, asegurarEsquema, VENTANA_HORAS,
};
