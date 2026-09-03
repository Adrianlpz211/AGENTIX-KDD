'use strict';

/**
 * UI Layout Memory — la decisión de diseño se guarda sola y se defiende sola.
 *
 * EL CASO REAL
 * ------------
 * El panel de "visita guiada" se reposicionó porque el dev lo pidió. Esa
 * decisión no quedaba en ningún lado: si otra sesión, otro modelo o un merge
 * lo devolvía a su sitio viejo, nada lo detectaba. Es el síntoma "el select
 * volvió a su lugar viejo".
 *
 * POR QUÉ LA v1 NO SIRVIÓ (03/09/2026)
 * ------------------------------------
 * La v1 solo vigilaba lo que alguien registrara A MANO con `record`. En un
 * proyecto real con meses de trabajo: CERO registros. La tabla no llegó a
 * existir. El post-cycle lo invocaba puntualmente — eso estaba bien — pero
 * corría, no encontraba nada registrado, y no comprobaba nada. Protegía cero.
 *
 * Pedirle a alguien que documente cada decisión de diseño a mano es pedirle
 * que no la documente. Lo mismo que pasó con el reloj de la línea de tiempo:
 * si depende de que alguien se acuerde, no ocurre.
 *
 * QUÉ HACE AHORA
 * --------------
 * `autocapture` lee los archivos de front del changeset y registra SOLO lo que
 * ve: valores de diseño de elementos con `id` y de reglas CSS de un solo
 * selector. Sin comandos, sin que nadie escriba nada.
 *
 * Y lo que lo hace usable en vez de insoportable: **solo avisa de regresiones,
 * nunca de cambios nuevos.** Un valor distinto es trabajo normal y se registra
 * en silencio. Solo se avisa cuando:
 *   · un valor VUELVE a uno que ya se había abandonado  (casi siempre sin querer)
 *   · una propiedad DESAPARECE del elemento             (el bug `right`→`left`)
 * Por eso puede capturar mucho sin volverse ruido: capturar es barato, avisar
 * es caro, y solo avisa de lo que casi seguro es un error.
 *
 *   node .agentic/grafo/ui-layout-memory.cjs guard --files=a.css,b.html
 *   node .agentic/grafo/ui-layout-memory.cjs list [--id=<selector>]
 *   node .agentic/grafo/ui-layout-memory.cjs record --id=x --prop=right --value=12px --reason="..."
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

/* ── propiedades vigiladas ──────────────────────────────────────────────────
   Desde el detalle más pequeño (letter-spacing) hasta el de más peso
   (position, display). Se listan a propósito en vez de aceptar cualquier
   propiedad: `content`, `transition` o `cursor` cambian por mil razones
   legítimas y ensuciarían el historial sin proteger nada. */
const PROPS = new Set([
  'top', 'right', 'bottom', 'left', 'position', 'z-index', 'float', 'clear',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'display', 'flex', 'flex-direction', 'flex-wrap', 'justify-content',
  'align-items', 'align-self', 'gap', 'row-gap', 'column-gap', 'order',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  'font-size', 'font-weight', 'font-family', 'line-height', 'letter-spacing',
  'text-align', 'text-transform', 'white-space', 'vertical-align',
  'color', 'background', 'background-color', 'opacity',
  'border', 'border-radius', 'border-color', 'border-width', 'border-style',
  'border-top', 'border-right', 'border-bottom', 'border-left',
  'box-shadow', 'overflow', 'overflow-x', 'overflow-y', 'transform',
]);

const ES_FRONT = /\.(html?|css|scss|js|jsx|ts|tsx|cjs|mjs|vue|svelte)$/i;

/* ── base de datos ─────────────────────────────────────────────────────────── */

function openDB(projectRoot, { write = false } = {}) {
  const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    const BS3 = require('better-sqlite3');
    return write ? new BS3(dbPath) : new BS3(dbPath, { readonly: true });
  } catch {}
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(dbPath, write ? {} : { readOnly: true });
  } catch {}
  return null;
}

/**
 * Crea la tabla y añade las columnas nuevas si faltan.
 * Tolera una conexión de solo lectura: `list` abría readonly y llamaba aquí,
 * y el CREATE TABLE reventaba con "attempt to write a readonly database" —
 * o sea que el comando de consulta fallaba siempre.
 */
function ensureSchema(db) {
  const ok = safe(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS ui_layout_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      element_id TEXT NOT NULL,
      property   TEXT NOT NULL,
      value      TEXT NOT NULL,
      reason     TEXT,
      superseded INTEGER DEFAULT 0,
      decided_at TEXT DEFAULT (datetime('now'))
    )`);
    return true;
  }, false);
  if (!ok) return false;
  /* Columnas añadidas en la v2. ALTER falla si ya existen: se ignora. */
  for (const col of ['origen TEXT', 'archivo TEXT']) {
    safe(() => db.exec(`ALTER TABLE ui_layout_decisions ADD COLUMN ${col}`));
  }
  return true;
}

/** ¿Existe ya la tabla? Para consultar sin intentar escribir. */
const tablaExiste = (db) => !!safe(() => db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='ui_layout_decisions'"
).get(), null);

/* ── extracción de valores de diseño ────────────────────────────────────────
   Un solo extractor para las dos caras del trabajo: capturar lo nuevo y
   comparar lo que hay. Si fueran dos, se desincronizarían. */

/** `tour-panel` y `#tour-panel` son el mismo elemento. */
function normSel(s) {
  const t = String(s || '').trim();
  if (!t) return t;
  return /^[.#]/.test(t) ? t : '#' + t;
}

/* Separador de clave del mapa. No aparece jamás dentro de un selector
   ni en un nombre de propiedad: un selector CSS de un solo token y un nombre
   de propiedad nunca llevan espacios, así que no hay colisión posible. */
const SEP = ' ';
const claveDe = (selector, prop) => selector + SEP + prop;

const normVal = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();

function declaraciones(bloque) {
  const out = new Map();
  for (const trozo of String(bloque).split(';')) {
    const i = trozo.indexOf(':');
    if (i < 1) continue;
    const prop = trozo.slice(0, i).trim().toLowerCase();
    const val = trozo.slice(i + 1).trim();
    if (!PROPS.has(prop) || !val) continue;
    out.set(prop, val);
  }
  return out;
}

/**
 * Valores de diseño declarados en un archivo.
 * @returns Map<"selector|prop", {selector, prop, valor, origen}>
 */
function extraerValores(contenido) {
  const encontrados = new Map();
  const ambiguos = new Set();

  const guardar = (selector, prop, valor, origen) => {
    const clave = claveDe(selector, prop);
    if (encontrados.has(clave) && normVal(encontrados.get(clave).valor) !== normVal(valor)) {
      /* El mismo selector declara la propiedad dos veces con valores distintos
         (típico: la regla base y su variante dentro de un @media). No hay forma
         de saber cuál es "la" decisión, así que no se registra ninguna: una
         regresión falsa es peor que una vigilancia que falta. */
      ambiguos.add(clave);
      return;
    }
    encontrados.set(clave, { selector, prop, valor, origen });
  };

  /* 1. Estilos en línea sobre elementos con id.
        Se recorren las etiquetas de apertura; sirve igual para HTML suelto que
        para el HTML dentro de un template literal de JS. */
  const tags = String(contenido).matchAll(/<([a-zA-Z][\w-]*)\b([^<>]*)>/g);
  for (const t of tags) {
    const attrs = t[2];
    const mId = attrs.match(/\bid\s*=\s*["']([^"'${}]+)["']/);
    const mSt = attrs.match(/\bstyle\s*=\s*["']([^"']*)["']/);
    if (!mId || !mSt) continue;
    const sel = normSel(mId[1]);
    for (const [prop, val] of declaraciones(mSt[1])) guardar(sel, prop, val, 'inline');
  }

  /* 2. Reglas CSS de un solo selector (#id o .clase).
        Los selectores compuestos (`.a .b:hover > c`) se dejan fuera a
        propósito: son demasiados y su valor cambia por motivos legítimos. */
  const reglas = String(contenido).matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const r of reglas) {
    /* Dentro de un @media el capturado arrastra la cabecera; nos quedamos con
       la última línea, que es el selector real. */
    const crudo = r[1].split('\n').pop().trim();
    if (!crudo || crudo.startsWith('@') || crudo.startsWith('/*')) continue;
    for (const parte of crudo.split(',')) {
      const sel = parte.trim();
      if (!/^[.#][A-Za-z_][\w-]*$/.test(sel)) continue;
      for (const [prop, val] of declaraciones(r[2])) guardar(sel, prop, val, 'css');
    }
  }

  for (const clave of ambiguos) encontrados.delete(clave);
  return encontrados;
}

/* ── memoria ────────────────────────────────────────────────────────────────── */

function currentDecision(db, elementId, property) {
  return safe(() => db.prepare(
    `SELECT value, reason, decided_at FROM ui_layout_decisions
     WHERE element_id = ? AND property = ? AND superseded = 0
     ORDER BY id DESC LIMIT 1`
  ).get(normSel(elementId), property));
}

function history(db, elementId, property) {
  return safe(() => db.prepare(
    `SELECT value, reason, decided_at FROM ui_layout_decisions
     WHERE element_id = ? AND property = ? AND superseded = 1
     ORDER BY id DESC`
  ).all(normSel(elementId), property)) || [];
}

/** Registra una decisión; marca la anterior (mismo selector+prop) como superada. */
function escribirDecision(db, { elementId, property, value, reason, origen, archivo }) {
  const sel = normSel(elementId);
  safe(() => db.prepare(
    `UPDATE ui_layout_decisions SET superseded = 1
      WHERE element_id = ? AND property = ? AND superseded = 0`
  ).run(sel, property));
  return safe(() => {
    db.prepare(
      `INSERT INTO ui_layout_decisions (element_id, property, value, reason, origen, archivo)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sel, property, String(value), reason || null, origen || 'manual', archivo || null);
    return true;
  }, false);
}

/** API pública histórica: registro manual desde el CLI. */
function recordDecision(projectRoot, { elementId, property, value, reason }) {
  const db = openDB(projectRoot, { write: true });
  if (!db) return { ok: false, reason: 'sin memoria.db' };
  if (!ensureSchema(db)) { safe(() => db.close()); return { ok: false, reason: 'no se pudo preparar la tabla' }; }
  try {
    const ok = escribirDecision(db, { elementId, property, value, reason, origen: 'manual' });
    return { ok, reason: ok ? null : 'no se pudo escribir' };
  } finally { safe(() => db.close()); }
}

/* ── el paso completo: comparar y capturar ─────────────────────────────────── */

function archivosDelCommit(projectRoot) {
  const out = safe(() => execSync('git diff-tree --no-commit-id --name-only -r HEAD', {
    cwd: projectRoot, stdio: 'pipe', timeout: 15000,
  }).toString(), '');
  const lista = out.split('\n').map((s) => s.trim()).filter((f) => f && ES_FRONT.test(f));
  if (lista.length) return lista;

  /* Sin git no hay changeset, y sin changeset esto no capturaria nunca nada.
     Ocurre de verdad: D:\360 es un proyecto real sin versionar. En ese caso se
     miran los archivos de front tocados en las ultimas horas, que es la mejor
     aproximacion disponible a "lo que se acaba de cambiar". Con un tope,
     porque sin git tampoco hay forma de acotar por commit. */
  return frontRecientes(projectRoot);
}

const DIRS_FRONT = ['public', 'src', 'app', 'assets', 'components', 'views', 'pages', 'styles'];
const HORAS_RECIENTE = 8;

function frontRecientes(projectRoot, { horas = HORAS_RECIENTE, tope = 60 } = {}) {
  const corte = Date.now() - horas * 3600 * 1000;
  const out = [];

  const recorrer = (dir, prof) => {
    if (prof > 6 || out.length >= tope) return;
    for (const e of safe(() => fs.readdirSync(dir, { withFileTypes: true }), []) || []) {
      if (out.length >= tope) return;
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { recorrer(abs, prof + 1); continue; }
      if (!ES_FRONT.test(e.name)) continue;
      const st = safe(() => fs.statSync(abs), null);
      if (st && st.mtimeMs >= corte) out.push(path.relative(projectRoot, abs).split(path.sep).join('/'));
    }
  };

  for (const d of DIRS_FRONT) {
    const abs = path.join(projectRoot, d);
    if (fs.existsSync(abs)) recorrer(abs, 0);
  }
  return out;
}

function motivoDelCommit(projectRoot) {
  const s = safe(() => execSync('git log -1 --format=%h %s', {
    cwd: projectRoot, stdio: 'pipe', timeout: 10000,
  }).toString().trim(), '');
  return s ? `capturado del commit ${s.slice(0, 90)}` : 'capturado automáticamente';
}

/**
 * Compara los archivos contra la memoria y registra lo que vea.
 * El orden importa: primero comparar (con la memoria vieja), luego escribir.
 *
 * @returns {findings, capturados, revisados, scanned}
 */
function guard(projectRoot, { files = null, capturar = true, motivo = null } = {}) {
  const lista = (files && files.length ? files : archivosDelCommit(projectRoot))
    .filter((f) => ES_FRONT.test(f));
  if (!lista.length) return { findings: [], capturados: 0, revisados: 0, scanned: false, reason: 'sin archivos de front' };

  const db = openDB(projectRoot, { write: true });
  if (!db) return { findings: [], capturados: 0, revisados: 0, scanned: false, reason: 'sin memoria.db' };
  if (!ensureSchema(db)) { safe(() => db.close()); return { findings: [], capturados: 0, revisados: 0, scanned: false, reason: 'memoria.db de solo lectura' }; }

  const razon = motivo || motivoDelCommit(projectRoot);
  const findings = [];
  const pendientes = [];
  let revisados = 0;

  for (const rel of lista) {
    const abs = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
    const contenido = safe(() => fs.readFileSync(abs, 'utf8'), null);
    if (contenido == null) continue;

    const actuales = extraerValores(contenido);
    revisados += actuales.size;

    /* (a) Lo que la memoria vigila para ESTE archivo y ya no aparece. */
    const vigilados = safe(() => db.prepare(
      `SELECT element_id, property, value, reason FROM ui_layout_decisions
        WHERE superseded = 0 AND archivo = ?`
    ).all(rel), []) || [];

    for (const v of vigilados) {
      const clave = claveDe(v.element_id, v.property);
      if (actuales.has(clave)) continue;
      findings.push({
        elementId: v.element_id, property: v.property,
        nuevoValor: '(ausente)', decidido: v.value, razon: v.reason,
        esReversion: false, ausente: true, archivo: rel,
      });
    }

    /* (b) Lo que cambió de valor. */
    for (const [, cur] of actuales) {
      const previa = currentDecision(db, cur.selector, cur.prop);

      if (!previa) { pendientes.push({ cur, rel }); continue; }
      if (normVal(previa.value) === normVal(cur.valor)) continue;

      const pasados = history(db, cur.selector, cur.prop);
      const eraViejo = pasados.find((h) => normVal(h.value) === normVal(cur.valor));

      if (eraViejo) {
        /* La señal fuerte: vuelve a un valor que YA se había abandonado. */
        findings.push({
          elementId: cur.selector, property: cur.prop, nuevoValor: cur.valor,
          decidido: previa.value, razon: previa.reason,
          esReversion: true, razonVieja: eraViejo.reason, archivo: rel,
        });
      }
      /* Un valor nuevo es trabajo normal: no se avisa, se apunta. */
      pendientes.push({ cur, rel });
    }
  }

  let capturados = 0;
  if (capturar) {
    for (const { cur, rel } of pendientes) {
      if (escribirDecision(db, {
        elementId: cur.selector, property: cur.prop, value: cur.valor,
        reason: razon, origen: cur.origen, archivo: rel,
      })) capturados++;
    }
  }

  /* Los hallazgos quedan en la libreta como cualquier otro gate. */
  if (findings.length) {
    safe(() => {
      const gt = require(path.join(__dirname, 'gate-telemetry.cjs'));
      findings.forEach((f) => gt.recordGateEvent(db, {
        gate: 'ui-layout', verdict: f.esReversion ? 'WARN_REVERSION' : 'WARN', source: 'mechanical',
        file: f.archivo,
        detalle: { elementId: f.elementId, property: f.property, nuevo: f.nuevoValor, decidido: f.decidido },
      }));
    });
  }

  safe(() => db.close());
  return { findings, capturados, revisados, scanned: true, archivos: lista.length };
}

/** Compatibilidad: el nombre que ya usaba post-cycle. Ahora también captura. */
function scanDiff(projectRoot, { files = null } = {}) {
  return guard(projectRoot, { files, capturar: true });
}

function formatear(res) {
  if (!res.scanned) return `UI LAYOUT MEMORY — ${res.reason || 'nada que escanear'}.`;
  const base = `${res.revisados} valor(es) de diseño en ${res.archivos} archivo(s); ${res.capturados} registrado(s)`;
  if (!res.findings.length) return `✅ UI LAYOUT MEMORY — ${base}. Ninguna regresión.`;

  const L = [`⚠️  UI LAYOUT MEMORY — ${base}. ${res.findings.length} posible(s) regresión(es):`];
  for (const f of res.findings.slice(0, 20)) {
    if (f.esReversion) {
      L.push(`  🔴 ${f.elementId} ${f.property}: vuelve a "${f.nuevoValor}", un valor que YA se había abandonado (se decidió "${f.decidido}"). Casi siempre es sin querer.`);
    } else {
      L.push(`  🟠 ${f.elementId}: la propiedad "${f.property}" desapareció (valor decidido: "${f.decidido}") en ${f.archivo}. ¿Se movió a otra clase o se perdió?`);
    }
  }
  if (res.findings.length > 20) L.push(`  … y ${res.findings.length - 20} más (ver gate_events).`);
  return L.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  const opts = {};
  for (const a of rest.filter((a) => a.startsWith('--'))) {
    const [k, v] = a.slice(2).split('=');
    opts[k] = v !== undefined ? v : true;
  }
  const root = process.cwd();
  const files = opts.files ? String(opts.files).split(',').filter(Boolean) : null;

  if (cmd === 'record') {
    if (!opts.id || !opts.prop || opts.value === undefined) {
      console.log('Uso: record --id=<selector> --prop=<propiedad> --value=<valor> --reason="..."');
      process.exit(1);
    }
    const r = recordDecision(root, { elementId: opts.id, property: opts.prop, value: opts.value, reason: opts.reason });
    console.log(r.ok ? `✅ Decisión registrada: ${normSel(opts.id)} ${opts.prop} = ${opts.value}` : `⚠️  ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'guard' || cmd === 'check' || cmd === 'autocapture') {
    const res = guard(root, { files, capturar: cmd !== 'check' });
    console.log(formatear(res));
    process.exit(0); // visible, nunca bloqueante — mismo espíritu que spec-value-scan
  }

  if (cmd === 'list') {
    const db = openDB(root);
    if (db && tablaExiste(db)) {
      const rows = opts.id
        ? safe(() => db.prepare('SELECT * FROM ui_layout_decisions WHERE element_id = ? ORDER BY id').all(normSel(opts.id)), [])
        : safe(() => db.prepare('SELECT * FROM ui_layout_decisions WHERE superseded = 0 ORDER BY element_id, property LIMIT 500').all(), []);
      if (!rows.length) console.log('UI LAYOUT MEMORY — sin decisiones registradas todavía.');
      rows.forEach((r) => console.log(
        `${r.element_id} ${r.property} = ${r.value}${r.superseded ? ' (superada)' : ''}` +
        `${r.archivo ? '  · ' + r.archivo : ''}  — "${(r.reason || '').slice(0, 60)}"`));
      safe(() => db.close());
    } else {
      console.log('UI LAYOUT MEMORY — sin decisiones registradas todavía.');
    }
    process.exit(0);
  }

  console.log('Uso: node ui-layout-memory.cjs <guard|list|record> [--files=a,b]');
  process.exit(0);
}

module.exports = {
  recordDecision, scanDiff, guard, formatear, currentDecision, history,
  ensureSchema, extraerValores, normSel, claveDe, frontRecientes, PROPS,
};
