'use strict';

/**
 * Error Cure — la solución que ya funcionó, entregada antes de repetir el error.
 *
 * EL PROBLEMA QUE CIERRA
 * ----------------------
 * La memoria KDD guarda cada error con su cura escrita dentro: secciones
 * `Síntoma:`, `Causa:`, `Solución:`, `Prevención:`. En D:\360 había 29 errores
 * y 25 con su `Solución:` redactada. Nadie las leía nunca.
 *
 * El enricher SÍ tenía el código para traer la cura (el mensaje "Cura conocida"
 * estaba escrito), pero nunca disparó por tres cortocircuitos:
 *   1. exigía que el error tuviera "ancla de símbolo" — 0 de 29 la tenían;
 *   2. consultaba relaciones_semanticas.was_fixed_by — 0 filas;
 *   3. solo corría con riesgo ALTO.
 *
 * Y la trampa: los 397 edges `resuelto_por` que SÍ existen son ruido. Cada
 * error está enlazado a los ~27 patrones de su área, todos con peso 1 — un
 * producto cartesiano generado en masa, no una cura. Conectar esa tubería
 * habría inundado el brief con 27 curas falsas por error. Por eso este módulo
 * IGNORA los edges y lee el texto del propio nodo, que es donde alguien
 * escribió de verdad qué lo arregló.
 *
 * CÓMO ELIGE
 * ----------
 * Puntúa por evidencia, de más fuerte a más débil:
 *   · un archivo concreto del error aparece en la tarea      (la señal fuerte)
 *   · el área coincide
 *   · palabras del título/síntoma aparecen en la tarea
 *   · confianza ALTA y estado RESUELTO
 * Solo devuelve errores que tengan una `Solución:` real: un error sin cura no
 * es una cura, es un susto.
 *
 *   node .agentic/grafo/error-cure.cjs "arreglar el import de cotizacion detalle"
 *   node .agentic/grafo/error-cure.cjs --files=src/a.ts,src/b.ts "tarea"
 */

const fs = require('fs');
const path = require('path');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

function openDB(root) {
  const p = path.join(root, '.agentic', 'memoria.db');
  if (!fs.existsSync(p)) return null;
  try { return new (require('better-sqlite3'))(p, { readonly: true }); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(p, { readOnly: true }); } catch {}
  return null;
}

/* Nombres que aparecen en medio proyecto: coinciden siempre y no prueban nada. */
const GENERICOS = new Set([
  'index.js', 'index.ts', 'route.ts', 'page.tsx', 'layout.tsx', 'main.js',
  'app.js', 'utils.js', 'db.ts', 'public/legacy', 'src', 'lib',
]);

const VACIAS = new Set([
  'para', 'como', 'cuando', 'donde', 'porque', 'este', 'esta', 'esto', 'eso',
  'todo', 'toda', 'todos', 'todas', 'hacer', 'hace', 'poner', 'quitar', 'desde',
  'hasta', 'sobre', 'entre', 'tiene', 'estar', 'siendo', 'pero', 'mas', 'menos',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into',
]);

/* Piso de evidencia propia: un archivo concreto (50) o dos palabras del
   síntoma (18). Con una sola palabra la coincidencia es casual, y una cura
   equivocada es peor que ninguna: manda al dev en la dirección contraria. */
const UMBRAL_EVIDENCIA = 18;

const normalizar = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function tokens(texto) {
  return new Set(
    normalizar(texto)
      .split(/[^a-z0-9_.-]+/)
      .filter((t) => t.length >= 4 && !VACIAS.has(t))
  );
}

/**
 * Parte el contenido de un nodo por sus encabezados conocidos.
 * El formato lo escribe el propio pipeline, así que es estable.
 */
function parseSecciones(contenido) {
  const txt = String(contenido || '');
  const campos = {
    error: /(?:^|\n)[ \t]*Error:[ \t]*/i,
    sintoma: /(?:^|\n)[ \t]*S[íi]ntoma:[ \t]*/i,
    causa: /(?:^|\n)[ \t]*Causa:[ \t]*/i,
    solucion: /(?:^|\n)[ \t]*Soluci[óo]n:[ \t]*/i,
    prevencion: /(?:^|\n)[ \t]*Prevenci[óo]n:[ \t]*/i,
    contexto: /(?:^|\n)[ \t]*Contexto:[ \t]*/i,
  };
  /* Se localizan todos los encabezados y cada sección llega hasta el siguiente. */
  const marcas = [];
  for (const [clave, re] of Object.entries(campos)) {
    const m = txt.match(re);
    if (m) marcas.push({ clave, ini: m.index + m[0].length, cab: m.index });
  }
  marcas.sort((a, b) => a.cab - b.cab);

  const out = {};
  marcas.forEach((m, i) => {
    const fin = i + 1 < marcas.length ? marcas[i + 1].cab : txt.length;
    out[m.clave] = txt.slice(m.ini, fin).trim();
  });
  return out;
}

function archivosDe(nodo) {
  const raw = nodo.archivos_aplica;
  if (!raw) return [];
  const arr = safe(() => JSON.parse(raw), null);
  if (Array.isArray(arr)) return arr.map(String);
  return String(raw).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Busca curas conocidas para una tarea.
 * @returns [{titulo, area, confianza, solucion, sintoma, causa, archivos, score, porque}]
 */
function findCures(db, { task = '', areas = [], files = [], limit = 3 } = {}) {
  if (!db) return [];

  const filas = safe(() => db.prepare(
    `SELECT id, titulo, area, confianza, contenido, archivos_aplica, estado
       FROM nodos
      WHERE tipo = 'error' AND contenido IS NOT NULL`
  ).all(), []) || [];

  const tTarea = tokens(task);
  const textoBusqueda = normalizar(task + ' ' + files.join(' '));
  const areasNorm = [...new Set(areas.map(normalizar))].filter(Boolean);

  const candidatos = [];

  for (const n of filas) {
    const sec = parseSecciones(n.contenido);
    /* Sin solución escrita no hay cura que ofrecer. */
    if (!sec.solucion || sec.solucion.length < 8) continue;

    /* EVIDENCIA vs DESEMPATE — la distinción que evita el ruido.
       Compartir área no es evidencia de nada: "compras" tiene 27 errores y
       todos comparten área con cualquier tarea de compras. Si el área contara
       como evidencia, el brief volvería a inundarse igual que con los edges
       `resuelto_por`. Solo cuentan como evidencia el archivo y las palabras;
       el área y la confianza ordenan lo que ya entró. */
    let evidencia = 0;
    let desempate = 0;
    const porque = [];

    /* 1. Archivo concreto — la evidencia más fuerte que existe aquí. */
    for (const a of archivosDe(n)) {
      const base = a.split(/[\\/]/).pop();
      if (!base || base.length < 5) continue;
      const generico = GENERICOS.has(a) || GENERICOS.has(base);
      if (textoBusqueda.includes(normalizar(base))) {
        if (generico) desempate += 8;
        else { evidencia += 50; porque.push(`toca ${base}`); }
      }
    }

    /* 2. Palabras compartidas con el título y el síntoma — así entran los 20
          errores que no tienen archivos declarados. */
    const tNodo = tokens(n.titulo + ' ' + (sec.sintoma || '') + ' ' + (sec.error || ''));
    let comunes = 0;
    for (const t of tTarea) if (tNodo.has(t)) comunes++;
    if (comunes) {
      evidencia += Math.min(comunes * 9, 45);
      porque.push(`${comunes} palabra${comunes > 1 ? 's' : ''} en común`);
    }

    /* Sin evidencia propia no entra, por muy ALTA que sea su confianza. */
    if (evidencia < UMBRAL_EVIDENCIA) continue;

    /* 3. Desempates: el área y lo confirmado ordenan, no admiten. */
    const areaN = normalizar(n.area);
    if (areaN && areasNorm.some((a) => areaN.includes(a) || a.includes(areaN))) {
      desempate += 20;
      porque.push(`misma área (${n.area})`);
    }
    if (String(n.confianza).toUpperCase() === 'ALTA') desempate += 12;
    if (/RESUELTO/i.test(String(n.estado || '') + String(n.contenido || ''))) desempate += 6;

    const score = evidencia + desempate;

    candidatos.push({
      titulo: n.titulo,
      area: n.area,
      confianza: n.confianza,
      solucion: sec.solucion,
      sintoma: sec.sintoma || null,
      causa: sec.causa || null,
      prevencion: sec.prevencion || null,
      archivos: archivosDe(n),
      score, evidencia,
      porque,
    });
  }

  candidatos.sort((a, b) => b.score - a.score);
  return candidatos.slice(0, limit);
}

/** Líneas compactas para el brief del enricher. */
function lineasParaBrief(curas) {
  const out = [];
  for (const c of curas) {
    out.push(`💊 Esto ya pasó: "${String(c.titulo).slice(0, 72)}" [${c.confianza}] — ${c.porque.join(', ')}`);
    out.push(`   ↳ Se arregló así: ${String(c.solucion).replace(/\s+/g, ' ').slice(0, 260)}`);
    if (c.prevencion) out.push(`   ↳ Para que no vuelva: ${String(c.prevencion).replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return out;
}

/** Áreas de la memoria que la tarea menciona — para el CLI a secas. */
function inferirAreas(db, task) {
  const areasDB = safe(() => db.prepare(
    "SELECT DISTINCT area FROM nodos WHERE area IS NOT NULL AND area <> ''"
  ).all().map((r) => r.area), []) || [];
  const t = normalizar(task);
  return areasDB.filter((a) => t.includes(normalizar(a)));
}

function main() {
  const args = process.argv.slice(2);
  let files = [];
  const resto = [];
  for (const a of args) {
    if (a.startsWith('--files=')) files = a.slice(8).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--')) { /* ignorar banderas desconocidas */ }
    else resto.push(a);
  }
  const task = resto.join(' ');
  const db = openDB(process.cwd());
  if (!db) { console.log('ERROR CURE — sin memoria.db.'); return; }

  const curas = findCures(db, { task, areas: inferirAreas(db, task), files, limit: 5 });
  safe(() => db.close());

  if (!curas.length) {
    console.log('ERROR CURE — ningún error previo con solución escrita coincide con esta tarea.');
    return;
  }
  console.log(`ERROR CURE — ${curas.length} cura(s) conocida(s):\n`);
  console.log(lineasParaBrief(curas).join('\n'));
}

if (require.main === module) main();

module.exports = { findCures, parseSecciones, lineasParaBrief, inferirAreas, openDB };
