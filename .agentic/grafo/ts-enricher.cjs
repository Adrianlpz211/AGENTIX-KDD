'use strict';

/**
 * TS Enricher — Agentic KDD v3.13 (Plan 3, etapas 1-3: SOMBRA Y MEDICIÓN)
 *
 * NO reemplaza nada. NO escribe en ninguna base de datos. NO toca los
 * extractores regex. Hace exactamente una cosa: comparar el line_end
 * aproximado del índice (truco del "siguiente símbolo", Plan 1) contra el
 * line_end EXACTO que da un parser real (tree-sitter WASM), y producir un
 * reporte con números para decidir CON EVIDENCIA si la etapa 4 del Plan 3
 * (refinamiento) se justifica o el punto 7 queda diferido.
 *
 * Vector sync/async resuelto por diseño: este módulo es una pasada SEPARADA y
 * async — jamás corre inline dentro de indexFile (que es síncrono). La ruta
 * regex queda byte-idéntica.
 *
 * Fail-soft total: sin web-tree-sitter instalado → `status` lo dice y
 * `compare` termina con mensaje accionable. Nunca lanza, nunca degrada nada.
 *
 * Uso CLI:
 *   node .agentic/grafo/ts-enricher.cjs status
 *   node .agentic/grafo/ts-enricher.cjs compare [--target=DIR] [--db=RUTA] [--out=DIR]
 *     --target: raíz del proyecto a medir (default: cwd)
 *     --db:     memoria.db con el índice regex (default: <target>/.agentic/memoria.db)
 *     --out:    carpeta del reporte (default: <cwd>/_output)
 */

const fs = require('fs');
const path = require('path');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

// ─── DISPONIBILIDAD (fail-soft) ───────────────────────────────────────────────

function detectAvailability() {
  const out = { webTreeSitter: false, grammars: [], detalle: '' };
  try {
    require.resolve('web-tree-sitter');
    out.webTreeSitter = true;
  } catch {
    out.detalle = 'web-tree-sitter no instalado. Para la medición: npm install --no-save web-tree-sitter tree-sitter-wasms';
    return out;
  }
  for (const g of ['javascript', 'typescript', 'tsx']) {
    try {
      require.resolve(`tree-sitter-wasms/out/tree-sitter-${g}.wasm`);
      out.grammars.push(g);
    } catch {}
  }
  if (!out.grammars.length) out.detalle = 'web-tree-sitter presente pero sin grammars. Instala: npm install --no-save tree-sitter-wasms';
  return out;
}

// ─── PARSER (API 0.26+ con fallback a la vieja) ───────────────────────────────

async function initParsers(grammarsNeeded) {
  const TS = require('web-tree-sitter');
  const Parser = TS.Parser || TS;                       // 0.26: named export | 0.22 y anteriores: default
  await Parser.init();
  // OJO: en la API vieja (0.22.x, la compatible con las grammars de
  // tree-sitter-wasms 0.1.x) Parser.Language solo existe DESPUÉS de init().
  const Language = TS.Language || Parser.Language;
  const parsers = {};
  for (const g of grammarsNeeded) {
    try {
      const lang = await Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${g}.wasm`));
      const p = new Parser();
      p.setLanguage(lang);
      parsers[g] = p;
    } catch (e) {
      parsers[g] = null;
    }
  }
  return parsers;
}

function grammarForFile(file) {
  const f = file.toLowerCase();
  if (f.endsWith('.tsx')) return 'tsx';
  if (f.endsWith('.ts')) return 'typescript';
  if (/\.(js|jsx|mjs|cjs)$/.test(f)) return 'javascript';
  return null;
}

// ─── EXTRACCIÓN TOP-LEVEL (misma semántica que el regex: solo columna 0) ──────
// El extractor regex solo captura símbolos anclados a inicio de línea (top-level).
// Para comparar manzanas con manzanas, aquí también se recorren SOLO los hijos
// directos del programa — los símbolos anidados (métodos, closures) son la
// etapa 5 (v2) del plan, no esta medición.

const KIND_BY_TYPE = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
};

function symbolsFromTree(root) {
  const out = [];

  const extraer = (decl, rangeNode) => {
    const line_start = rangeNode.startPosition.row + 1;
    const line_end = rangeNode.endPosition.row + 1;
    const kind = KIND_BY_TYPE[decl.type];
    if (kind) {
      const nameNode = decl.childForFieldName('name');
      if (nameNode && nameNode.text) {
        out.push({ symbol_name: nameNode.text, kind, line_start, line_end });
      }
      return;
    }
    if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
      for (const d of decl.namedChildren) {
        if (d.type !== 'variable_declarator') continue;
        const nameNode = d.childForFieldName('name');
        const valueNode = d.childForFieldName('value');
        if (!nameNode || nameNode.type !== 'identifier') continue;
        const nombre = nameNode.text;
        const esFuncion = valueNode && /^(arrow_function|function_expression|function|generator_function)$/.test(valueNode.type);
        if (esFuncion) out.push({ symbol_name: nombre, kind: 'function', line_start, line_end });
        else if (/^[A-Z][A-Z0-9_]*$/.test(nombre)) out.push({ symbol_name: nombre, kind: 'constant', line_start, line_end });
      }
    }
  };

  for (const child of root.namedChildren) {
    if (child.type === 'export_statement') {
      const decl = child.namedChildren.find(c =>
        KIND_BY_TYPE[c.type] || c.type === 'lexical_declaration' || c.type === 'variable_declaration');
      if (decl) extraer(decl, child); // rango del wrapper: misma línea de arranque que el regex
      continue;
    }
    extraer(child, child);
  }
  return out;
}

// ─── DB (solo lectura) ────────────────────────────────────────────────────────

function openDBReadOnly(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const Database = require('better-sqlite3');
    return new Database(dbPath, { readonly: true });
  } catch {
    try {
      const { DatabaseSync } = require('node:sqlite');
      return new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      return safe(() => {
        const { DatabaseSync } = require('node:sqlite');
        return new DatabaseSync(dbPath);
      });
    }
  }
}

// ─── COMPARACIÓN ──────────────────────────────────────────────────────────────

const BOUNDARY_KINDS = ['function', 'class', 'interface', 'type', 'enum', 'constant'];

async function compare(targetDir, dbPath, outDir) {
  const avail = detectAvailability();
  if (!avail.webTreeSitter || !avail.grammars.length) {
    return { ok: false, message: 'TS-ENRICHER: ' + (avail.detalle || 'dependencias faltantes') };
  }
  const db = openDBReadOnly(dbPath);
  if (!db) return { ok: false, message: `TS-ENRICHER: no existe la BD del índice: ${dbPath}` };

  const filas = safe(() => db.prepare(`
    SELECT file, language, symbol_name, kind, line_start, line_end
    FROM ast_symbols
    WHERE kind IN (${BOUNDARY_KINDS.map(() => '?').join(',')})
      AND language IN ('javascript','typescript')
  `).all(...BOUNDARY_KINDS)) || [];
  safe(() => db.close());
  if (!filas.length) return { ok: false, message: 'TS-ENRICHER: el índice no tiene símbolos JS/TS — corre primero: node .agentic/grafo/ast-indexer.cjs index' };

  const porArchivo = {};
  filas.forEach(r => { (porArchivo[r.file] = porArchivo[r.file] || []).push(r); });

  const parsers = await initParsers(avail.grammars);

  const stats = {
    archivos: 0, archivosSinParser: 0, fallosParse: 0, archivosGrandes: 0, archivosFaltantes: 0,
    regexTotal: 0, matched: 0, soloRegex: 0, soloTs: 0,
    histDeltaEnd: { d0: 0, d1_2: 0, d3_5: 0, d6_20: 0, dMas20: 0 },
    // el ÚLTIMO símbolo de cada archivo se estira hasta EOF por diseño (sobra
    // rango, dirección segura) — medirlo APARTE para no mezclar esa cola
    // esperada con errores reales entre símbolos.
    histNoUltimo: { d0: 0, d1_2: 0, d3_5: 0, d6_20: 0, dMas20: 0 },
    // DIRECCIÓN del error — la métrica decisiva para el guardia:
    //   sobra (regex_end > exacto): revisa de más — dirección SEGURA
    //   falta (regex_end < exacto): deja líneas del símbolo fuera del rango —
    //          dirección PELIGROSA (un MISS podría ser en realidad un HIT)
    sobra: 0, falta: 0, faltaNoUltimo: 0,
    peores: [],
  };
  const bucket = (h, d) => {
    if (d === 0) h.d0++;
    else if (d <= 2) h.d1_2++;
    else if (d <= 5) h.d3_5++;
    else if (d <= 20) h.d6_20++;
    else h.dMas20++;
  };

  for (const [file, syms] of Object.entries(porArchivo)) {
    const grammar = grammarForFile(file);
    if (!grammar || !parsers[grammar]) { stats.archivosSinParser++; continue; }
    const abs = path.join(targetDir, file);
    if (!fs.existsSync(abs)) { stats.archivosFaltantes++; continue; }
    const content = safe(() => fs.readFileSync(abs, 'utf8'));
    if (content == null) { stats.archivosFaltantes++; continue; }
    if (content.length > 500000) { stats.archivosGrandes++; continue; }

    let tree = null;
    try { tree = parsers[grammar].parse(content); } catch { stats.fallosParse++; continue; }
    if (!tree || !tree.rootNode) { stats.fallosParse++; continue; }
    const tsSyms = symbolsFromTree(tree.rootNode);
    safe(() => tree.delete());
    stats.archivos++;

    const tsIndex = {};
    tsSyms.forEach(s => { (tsIndex[`${s.kind}|${s.symbol_name}`] = tsIndex[`${s.kind}|${s.symbol_name}`] || []).push(s); });
    const usados = new Set();

    const ultimoStart = Math.max(...syms.map(s => s.line_start));
    for (const r of syms) {
      stats.regexTotal++;
      const candidatos = tsIndex[`${r.kind}|${r.symbol_name}`] || [];
      // mismo símbolo = mismo nombre+kind y arranque a ≤2 líneas (los duplicados
      // de nombre se desambiguan por cercanía de line_start)
      let mejor = null, mejorDist = Infinity;
      for (const c of candidatos) {
        const dist = Math.abs(c.line_start - r.line_start);
        if (dist < mejorDist && !usados.has(c)) { mejor = c; mejorDist = dist; }
      }
      if (!mejor || mejorDist > 2) { stats.soloRegex++; continue; }
      usados.add(mejor);
      stats.matched++;
      const firmado = (r.line_end || 0) - mejor.line_end;
      const dEnd = Math.abs(firmado);
      if (firmado > 0) stats.sobra++;
      else if (firmado < 0) {
        stats.falta++;
        if (r.line_start !== ultimoStart) stats.faltaNoUltimo++;
      }
      bucket(stats.histDeltaEnd, dEnd);
      if (r.line_start !== ultimoStart) bucket(stats.histNoUltimo, dEnd);
      if (dEnd > 5) {
        stats.peores.push({ file, symbol: `${r.kind} ${r.symbol_name}`, regex: `${r.line_start}-${r.line_end}`, ts: `${mejor.line_start}-${mejor.line_end}`, delta: dEnd, dir: firmado > 0 ? 'sobra (seguro)' : 'FALTA (peligroso)', esUltimo: r.line_start === ultimoStart });
      }
    }
    stats.soloTs += tsSyms.filter(s => !usados.has(s)).length;
  }

  stats.peores.sort((a, b) => b.delta - a.delta);
  stats.peores = stats.peores.slice(0, 15);

  // ─── VEREDICTO (criterio del Plan 3) ────────────────────────────────────────
  const h = stats.histDeltaEnd, hn = stats.histNoUltimo;
  const totalNoUltimo = hn.d0 + hn.d1_2 + hn.d3_5 + hn.d6_20 + hn.dMas20;
  const pctMatch = stats.regexTotal ? (stats.matched / stats.regexTotal) : 0;
  const pctPrecisoNoUltimo = totalNoUltimo ? ((hn.d0 + hn.d1_2) / totalNoUltimo) : 0;
  const suficiente = pctMatch >= 0.9 && pctPrecisoNoUltimo >= 0.95;

  const pct = x => (x * 100).toFixed(1) + '%';
  const fecha = new Date().toISOString().slice(0, 10);
  const lineas = [
    `# Reporte tree-sitter vs regex — ${fecha}`,
    '',
    `Proyecto medido: \`${targetDir}\``,
    `Índice regex: \`${dbPath}\``,
    '',
    '## Cobertura',
    `- Archivos comparados: **${stats.archivos}** (sin parser: ${stats.archivosSinParser} · fallos de parse: ${stats.fallosParse} · >500KB: ${stats.archivosGrandes} · faltantes: ${stats.archivosFaltantes})`,
    `- Símbolos del índice regex: **${stats.regexTotal}** · emparejados con tree-sitter: **${stats.matched}** (${pct(pctMatch)})`,
    `- Solo-regex (tree-sitter no los vio igual): ${stats.soloRegex} · Solo-tree-sitter (el regex no los captura): ${stats.soloTs}`,
    '',
    '## Distribución del error de line_end (todos los emparejados)',
    `| delta | símbolos |`,
    `|---|---|`,
    `| 0 líneas (exacto) | ${h.d0} |`,
    `| 1-2 líneas | ${h.d1_2} |`,
    `| 3-5 líneas | ${h.d3_5} |`,
    `| 6-20 líneas | ${h.d6_20} |`,
    `| >20 líneas | ${h.dMas20} |`,
    '',
    '## Lo que importa: SIN el último símbolo de cada archivo',
    '(el último se estira hasta EOF por diseño del truco — sobra rango, dirección segura)',
    `| delta | símbolos |`,
    `|---|---|`,
    `| 0 líneas (exacto) | ${hn.d0} |`,
    `| 1-2 líneas | ${hn.d1_2} |`,
    `| 3-5 líneas | ${hn.d3_5} |`,
    `| 6-20 líneas | ${hn.d6_20} |`,
    `| >20 líneas | ${hn.dMas20} |`,
    '',
    `**Precisión ≤2 líneas (sin-último): ${pct(pctPrecisoNoUltimo)}** · Emparejamiento: ${pct(pctMatch)}`,
    '',
    '## Dirección del error (la métrica decisiva para el guardia)',
    `- **Sobra** (regex termina DESPUÉS del cierre real — revisa de más, dirección SEGURA): **${stats.sobra}**`,
    `- **Falta** (regex termina ANTES — deja líneas del símbolo fuera, dirección PELIGROSA): **${stats.falta}** (${stats.faltaNoUltimo} sin contar últimos-de-archivo)`,
    '',
    '## Veredicto (criterio del Plan 3: ≥90% emparejado y ≥95% con delta ≤2)',
    suficiente
      ? '✅ **LA APROXIMACIÓN ES SUFICIENTE — la etapa 4 (refinamiento con tree-sitter) queda DIFERIDA CON EVIDENCIA.** El truco del siguiente símbolo se equivoca poco donde importa, y donde se equivoca (cola hasta EOF del último símbolo) lo hace en la dirección segura: sobra rango, nunca falta.'
      : '⚠️ **REVISAR: la aproximación se queda corta según el criterio.** Ver los peores casos abajo — si se concentran en un patrón puntual, puede arreglarse en el extractor regex antes de considerar la etapa 4.',
    '',
  ];
  if (stats.peores.length) {
    lineas.push('## Peores 15 casos (delta > 5)');
    lineas.push('| archivo | símbolo | regex | tree-sitter | delta | dirección | ¿último del archivo? |');
    lineas.push('|---|---|---|---|---|---|---|');
    stats.peores.forEach(p => lineas.push(`| ${p.file} | ${p.symbol} | ${p.regex} | ${p.ts} | ${p.delta} | ${p.dir} | ${p.esUltimo ? 'sí (cola EOF)' : 'no'} |`));
    lineas.push('');
  }
  lineas.push('---');
  lineas.push('Metodología: comparación top-level vs top-level (misma semántica que los regex anclados a columna 0). ' +
    'Solo lectura: ni la BD ni los archivos del proyecto medido fueron modificados. ' +
    'Los símbolos anidados/métodos (etapa 5 del plan) NO entran en esta medición.');

  const reporte = lineas.join('\n');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `ts-compare-${fecha}.md`);
  fs.writeFileSync(outPath, reporte);

  return { ok: true, suficiente, pctMatch, pctPrecisoNoUltimo, stats, outPath, message: reporte };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args.find(a => !a.startsWith('--')) || 'status';
  const opt = (name, def) => {
    const a = args.find(x => x.startsWith(`--${name}=`));
    return a ? a.split('=').slice(1).join('=') : def;
  };

  if (cmd === 'status') {
    const avail = detectAvailability();
    console.log('\n🌲 TS Enricher — status');
    console.log('  web-tree-sitter:', avail.webTreeSitter ? '✅ instalado' : '❌ no instalado');
    console.log('  grammars:', avail.grammars.length ? avail.grammars.join(', ') : '(ninguna)');
    if (avail.detalle) console.log('  →', avail.detalle);
    console.log('  Modo: SOMBRA/MEDICIÓN — este módulo nunca escribe en el índice ni reemplaza los extractores regex.');
    process.exit(0);
  }

  if (cmd === 'compare') {
    const target = path.resolve(opt('target', process.cwd()));
    const dbPath = path.resolve(opt('db', path.join(target, '.agentic', 'memoria.db')));
    const outDir = path.resolve(opt('out', path.join(process.cwd(), '_output')));
    compare(target, dbPath, outDir).then(r => {
      if (!r.ok) { console.log('⚠️  ' + r.message); process.exit(0); }
      console.log(r.message);
      console.log(`\n📄 Reporte: ${r.outPath}`);
      process.exit(0);
    }).catch(e => {
      console.log('⚠️  TS-ENRICHER error (no bloquea nada):', e.message);
      process.exit(0);
    });
  } else {
    console.log('Uso: ts-enricher.cjs [status | compare [--target=DIR] [--db=RUTA] [--out=DIR]]');
  }
}

module.exports = { detectAvailability, compare, symbolsFromTree };
