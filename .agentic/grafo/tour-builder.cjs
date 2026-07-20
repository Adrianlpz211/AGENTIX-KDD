/**
 * Agentic KDD — Tour Builder v2.0 (Pieza 5 del plan Understand-Anything — la
 * "visita guiada"). Última pieza del plan, a propósito: consume lo que las
 * piezas 3 (descripciones en lenguaje natural) y 4 (impacto/contratos) ya
 * construyeron.
 *
 * v2 (18/07/2026, feedback real probando v1 en Lumo: 307 paradas 1-a-1 era
 * inmanejable): en vez de una parada POR ARCHIVO, cada parada es un MÓDULO
 * (carpeta) — junta lo que sus archivos hacen en un resumen, no una lista de
 * 15 descripciones sueltas. Reduce el recorrido de cientos de paradas a
 * decenas. Además se separa en dos recorridos — Frontend y Backend — usando
 * la MISMA clasificación que ya existe en el dashboard para la "coraza"
 * (stack-profile.cjs → esFront), no una regla nueva inventada.
 *
 * Orden: topológico A NIVEL DE MÓDULO (si algún archivo del módulo A importa
 * un archivo del módulo B, A depende de B) — ciclos rotos por PageRank total
 * del módulo, igual filosofía que v1 mantenía a nivel de archivo.
 *
 * Regla dura de redacción heredada de la Pieza 3: cero lenguaje técnico salvo
 * nombres de archivo.
 *
 * Uso:
 *   node tour-builder.cjs [área] [--limit=40]
 *   → imprime el recorrido en Markdown (front y back por separado) y escribe
 *     .agentic/tour.json con la misma separación, para el panel del dashboard.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

function resolveDbPath(projectRoot) {
  const candidates = [
    path.join(projectRoot, '.agentic', 'memoria.db'),
    path.join(projectRoot, '.agentic', 'grafo', 'memoria.db'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

function openDB(projectRoot) {
  const dbPath = resolveDbPath(projectRoot);
  if (!fs.existsSync(dbPath)) return null;
  try { return new (require('better-sqlite3'))(dbPath, { readonly: true }); }
  catch { try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch { return null; } }
}

const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
function tableExists(db, name) {
  return !!safe(() => db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

// ─── MÓDULO (misma heurística usada en el resto del dashboard) ───────────────

function deriveModulo(file) {
  const parts = String(file).split(/[\\/]/).filter(Boolean);
  parts.pop();
  if (!parts.length) return 'raíz';
  // Un nivel más de profundidad para CUALQUIER carpeta raíz, no solo 'src' —
  // bug real encontrado probando esto: 'public/' quedaba como un solo módulo
  // de 38 archivos (CSS+JS+vistas todo junto) mientras 'src/X' sí se separaba,
  // por tener la regla escrita solo para 'src'. Pareja para todas.
  if (parts.length > 1) return parts[0] + '/' + parts[1];
  return parts[0];
}

// ─── FRONT/BACK (misma fuente de verdad que la coraza del dashboard) ─────────

function loadFrontClassifier(projectRoot) {
  try {
    const sp = require('./stack-profile.cjs');
    const profile = safe(() => sp.loadProfile(projectRoot));
    return (file) => sp.esFront(file, profile);
  } catch {
    // Degradación exacta a la heurística vieja si stack-profile no está disponible.
    return (file) => {
      const f = String(file || '').replace(/\\/g, '/');
      return f.startsWith('public/') || /\.(jsx|tsx)$/i.test(f);
    };
  }
}

// ─── ORDEN TOPOLÓGICO A NIVEL DE MÓDULO ───────────────────────────────────────

function topoOrderModules(modules, moduleEdges, pagerankByModule) {
  const inMods = new Set(modules);
  const deps = new Map();
  modules.forEach(m => deps.set(m, new Set()));
  moduleEdges.forEach(([from, to]) => {
    if (!inMods.has(from) || !inMods.has(to) || from === to) return;
    deps.get(from).add(to);
  });

  const order = [];
  const cycleBreaks = [];
  const remaining = new Set(modules);
  const rank = m => pagerankByModule.get(m) || 0;

  while (remaining.size) {
    let ready = [...remaining].filter(m => ![...deps.get(m)].some(d => remaining.has(d)));
    if (!ready.length) {
      const pick = [...remaining].sort((a, b) => rank(b) - rank(a))[0];
      cycleBreaks.push(pick);
      ready = [pick];
    }
    ready.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
    for (const m of ready) { order.push(m); remaining.delete(m); }
  }
  return { order, cycleBreaks };
}

// ─── MEMORIA / CONTRATOS por módulo (agregado de todos sus archivos) ─────────

function memoriaForModulo(db, modulo) {
  if (!tableExists(db, 'nodos')) return [];
  const needle = modulo.toLowerCase().split('/').pop();
  const rows = safe(() => db.prepare(`
    SELECT tipo, titulo, area, confianza FROM nodos
    WHERE estado = 'ACTIVO' AND area IS NOT NULL AND area != 'global'
  `).all()) || [];
  const seen = new Set();
  return rows.filter(r => {
    const area = String(r.area || '').toLowerCase();
    if (!area || !(area.includes(needle) || needle.includes(area))) return false;
    if (seen.has(r.titulo)) return false;
    seen.add(r.titulo);
    return true;
  }).slice(0, 4);
}

function contractsForFiles(db, files) {
  const fileSet = new Set(files);
  const out = [];
  if (tableExists(db, 'verified_contracts')) {
    (safe(() => db.prepare(`SELECT module, name, status, source_files FROM verified_contracts WHERE status IN ('verified','protected')`).all()) || [])
      .forEach(r => {
        let fs2 = []; try { fs2 = JSON.parse(r.source_files || '[]'); } catch {}
        if (fs2.some(f => fileSet.has(String(f).replace(/\//g, '\\')))) out.push({ module: r.module, name: r.name });
      });
  }
  if (tableExists(db, 'protected_behaviors')) {
    (safe(() => db.prepare(`SELECT module, description, related_files FROM protected_behaviors WHERE status != 'deprecated'`).all()) || [])
      .forEach(r => {
        let fs2 = []; try { fs2 = JSON.parse(r.related_files || '[]'); } catch {}
        if (fs2.some(f => fileSet.has(String(f).replace(/\//g, '\\')))) out.push({ module: r.module, name: r.description });
      });
  }
  // dedup por module+name
  const seen = new Set();
  return out.filter(c => { const k = c.module + '|' + c.name; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ─── RESUMEN DE MÓDULO (sintetiza los summaries de sus archivos) ─────────────

function summarizeModule(files, codeSummaries, projectRoot) {
  const withSummary = [];
  for (const f of files) {
    const s = codeSummaries ? safe(() => codeSummaries.getFresh(f, projectRoot)) : null;
    if (s) withSummary.push({ file: f, summary: s });
  }
  if (!withSummary.length) return null;
  // No inventa una síntesis con IA aquí (esto corre por CLI, sin llamar al
  // asistente) — concatena las descripciones reales ya escritas, hasta 3,
  // como "lo que hacen los archivos principales de esta carpeta".
  return withSummary.slice(0, 3).map(w => w.summary).join(' ');
}

// ─── BUILD ────────────────────────────────────────────────────────────────────

function build(projectRoot, area = null, limit = 40) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);
  if (!db) return { error: 'DB unavailable' };
  if (!tableExists(db, 'ast_symbols')) return { error: 'sin índice AST — corre: akdd ast' };

  let codeSummaries = null;
  try { codeSummaries = require('./code-summaries.cjs'); } catch {}
  const isFront = loadFrontClassifier(projectRoot);

  let files = (safe(() => db.prepare(`
    SELECT DISTINCT file, MAX(pagerank) as pagerank FROM ast_symbols GROUP BY file
  `).all()) || []);
  if (area) {
    const needle = String(area).toLowerCase();
    files = files.filter(f => f.file.toLowerCase().split(/[\\/]/).some(seg => seg === needle));
  }
  if (!files.length) { safe(() => db.close()); return { error: area ? `sin archivos indexados para "${area}"` : 'sin archivos indexados' }; }

  // Agrupar archivos por módulo
  const filesByModule = new Map();
  files.forEach(f => {
    const m = deriveModulo(f.file);
    if (!filesByModule.has(m)) filesByModule.set(m, []);
    filesByModule.get(m).push(f);
  });

  const modules = [...filesByModule.keys()];
  const pagerankByModule = new Map(modules.map(m => [m, filesByModule.get(m).reduce((s, f) => s + (f.pagerank || 0), 0)]));

  const fileToModule = new Map();
  files.forEach(f => fileToModule.set(f.file, deriveModulo(f.file)));

  const rawEdges = safe(() => db.prepare(`
    SELECT DISTINCT from_file, to_file FROM ast_edges WHERE kind IN ('IMPORTS','EXTENDS') AND to_file IS NOT NULL
  `).all()) || [];
  const moduleEdgeSet = new Set();
  const moduleEdges = [];
  rawEdges.forEach(e => {
    const mf = fileToModule.get(e.from_file), mt = fileToModule.get(e.to_file);
    if (!mf || !mt || mf === mt) return;
    const key = mf + '→' + mt;
    if (moduleEdgeSet.has(key)) return;
    moduleEdgeSet.add(key);
    moduleEdges.push([mf, mt]);
  });

  const { order, cycleBreaks } = topoOrderModules(modules, moduleEdges, pagerankByModule);

  const depsOfModule = m => moduleEdges.filter(([f]) => f === m).map(([, t]) => t);
  const dependentsOfModule = m => moduleEdges.filter(([, t]) => t === m).map(([f]) => f);

  const buildStops = (moduleList) => moduleList.map((m, i) => {
    const modFiles = filesByModule.get(m).map(f => f.file);
    const isFrontModule = modFiles.some(isFront);
    return {
      order: i + 1,
      modulo: m,
      fileCount: modFiles.length,
      topFiles: [...modFiles].sort((a, b) => {
        const pa = filesByModule.get(m).find(f => f.file === a).pagerank || 0;
        const pb = filesByModule.get(m).find(f => f.file === b).pagerank || 0;
        return pb - pa;
      }).slice(0, 6),
      summary: summarizeModule(modFiles, codeSummaries, projectRoot),
      needs: [...new Set(depsOfModule(m))].slice(0, 6),
      usedBy: [...new Set(dependentsOfModule(m))].slice(0, 6),
      memoria: memoriaForModulo(db, m),
      contratos: contractsForFiles(db, modFiles),
      isFront: isFrontModule,
      cycleBreak: cycleBreaks.includes(m),
    };
  });

  const orderedFront = order.filter(m => filesByModule.get(m).some(f => isFront(f.file)));
  const orderedBack = order.filter(m => !filesByModule.get(m).some(f => isFront(f.file)));

  // OJO: buildStops() todavía consulta la DB (memoria, contratos) — cerrarla
  // antes de invocarlo (bug real encontrado probando esto mismo: el cierre
  // vivía aquí, pero buildStops() se llamaba DESPUÉS dentro del literal de
  // `tour`, así que corría con la conexión ya cerrada y todo salía vacío en
  // silencio) rompería memoria/contratos sin ningún error visible.
  const front = buildStops(orderedFront.slice(0, limit));
  const back = buildStops(orderedBack.slice(0, limit));
  safe(() => db.close());

  const tour = {
    version: '2.0',
    generatedAt: new Date().toISOString(),
    area: area || null,
    totalFiles: files.length,
    totalModules: modules.length,
    cycleBreaksCount: cycleBreaks.length,
    front,
    back,
    frontTruncated: orderedFront.length > limit,
    backTruncated: orderedBack.length > limit,
  };

  const outPath = path.join(projectRoot, '.agentic', 'tour.json');
  try { fs.writeFileSync(outPath, JSON.stringify(tour, null, 2), 'utf8'); }
  catch (e) { return { error: `no se pudo escribir ${outPath}: ${e.message}` }; }

  return { ok: true, tour, outPath };
}

// ─── MARKDOWN ─────────────────────────────────────────────────────────────────

function stopsToMarkdown(stops, label) {
  if (!stops.length) return `_(sin módulos de ${label})_\n`;
  const lines = [];
  stops.forEach(s => {
    lines.push(`## ${label} ${s.order} de ${stops.length}: ${s.modulo}${s.cycleBreak ? ' 🔁' : ''}`);
    lines.push(`*(${s.fileCount} archivo(s) — principales: ${s.topFiles.map(f => f.split(/[\\/]/).pop()).join(', ')})*`);
    lines.push('');
    lines.push(s.summary || 'Todavía no hay descripciones escritas para los archivos de este módulo — pide "akdd describe".');
    if (s.needs.length) lines.push(`\nPara funcionar, esta carpeta usa: ${s.needs.join(', ')}.`);
    if (s.usedBy.length) lines.push(`Otras carpetas que dependen de esta: ${s.usedBy.join(', ')}.`);
    if (s.memoria.length) {
      lines.push(`\n🧠 Lo que el proyecto recuerda de esta zona:`);
      s.memoria.forEach(m => lines.push(`  - ${m.titulo}`));
    }
    if (s.contratos.length) lines.push(`\n🛡️ Protegido por ${s.contratos.length} prueba(s) que no se pueden romper en silencio.`);
    lines.push('\n---\n');
  });
  return lines.join('\n');
}

function toMarkdown(tour) {
  const lines = [];
  lines.push(`# Visita guiada${tour.area ? ` — ${tour.area}` : ''}`);
  lines.push('');
  lines.push(`${tour.totalModules} módulo(s) de ${tour.totalFiles} archivo(s), separados en Frontend y Backend.`);
  lines.push('');
  lines.push('# 🖼️ Frontend\n');
  lines.push(stopsToMarkdown(tour.front, 'Módulo'));
  lines.push('# ⚙️ Backend\n');
  lines.push(stopsToMarkdown(tour.back, 'Módulo'));
  return lines.join('\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const area = args.find(a => !a.startsWith('--')) || null;
  const limit = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '40', 10);

  const r = build(process.cwd(), area, limit);
  if (r.error) { console.log(`❌ ${r.error}`); process.exit(1); }
  console.log(toMarkdown(r.tour));
  console.log(`\n(Guardado en ${path.relative(process.cwd(), r.outPath)} — ábrelo en el dashboard: pestaña Code Structure → 🧭 Visita guiada)`);
}

module.exports = { build, toMarkdown, topoOrderModules, deriveModulo };
