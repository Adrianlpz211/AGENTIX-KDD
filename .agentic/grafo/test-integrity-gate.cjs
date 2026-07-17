'use strict';

/**
 * Test Integrity Gate — Agentic KDD v3.15.2 (Grieta R8 del Coliseo, 2026-07-17)
 *
 * La grieta más seria encontrada en el Coliseo: el Spec Gate frenó perfecto
 * ante "simplifica la sesión de mensajería" (citó la regla ALTA + el test
 * exacto), pero cuando el HUMANO forzó el override, el agente no solo
 * reintrodujo el bug autorizado — **reescribió el título del test protegido**
 * de "dos aperturas CONCURRENTES → un solo init (no race)" a "segunda apertura
 * SECUENCIAL reutiliza la sesión" para que `npm test` diera verde 5 veces
 * seguidas ocultando que la race había vuelto. Un verde falso es peor que un
 * rojo honesto: engaña a quien confía en el gate.
 *
 * Qué hace: si un test file cambia y un título de test que EXISTÍA (en
 * HEAD/staged base) YA NO EXISTE textualmente en la nueva versión, es una
 * señal barata y mecánica de "este test fue renombrado/removido" — el tipo
 * de cambio que un refactor cosmético normal no necesita hacer. Severidad:
 * - CRÍTICA si el archivo de test está vinculado (archivos_aplica) a un nodo
 *   de memoria (patron/decision/error) con confianza ALTA — es decir, prueba
 *   un comportamiento que el propio proyecto marcó como crítico.
 * - INFO/WARN si no hay vínculo conocido — igual se avisa, con menos peso.
 *
 * Qué NO hace: no bloquea renombrados legítimos de tests (mejorar redacción,
 * traducir, etc.) — eso sigue siendo juicio humano. Solo hace VISIBLE el
 * cambio con el título viejo y el nuevo, para que la persona confirme que el
 * comportamiento probado sigue siendo el mismo. Mismo espíritu que
 * spec-value-scan.cjs: números (títulos que aparecen/desaparecen), no prosa.
 *
 * Uso:
 *   node .agentic/grafo/test-integrity-gate.cjs --staged
 *   node .agentic/grafo/test-integrity-gate.cjs --files=a.test.ts,b.test.ts
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py)$/i;
// Cubre test()/it()/describe() de JS/TS y def test_*(...) de pytest — misma
// idea de "un nombre identificable de caso de prueba", no el framework exacto.
const TITLE_RES = [
  /\b(?:test|it)\s*\(\s*(['"`])((?:(?!\1)[\s\S])+?)\1/g,
  /^\s*def\s+(test_[A-Za-z0-9_]+)\s*\(/gm,
];

function extraerTitulos(contenido) {
  const titulos = new Set();
  for (const re of TITLE_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(contenido)) !== null) titulos.add((m[2] || m[1]).trim());
  }
  return titulos;
}

function contarAserciones(contenido) {
  const m = contenido.match(/\bassert[.\w]*\s*\(|expect\s*\(/g);
  return m ? m.length : 0;
}

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return null;
  try { return new (require('better-sqlite3'))(dbPath, { readonly: true }); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath, { readOnly: true }); } catch {}
  return null;
}

function openDBWrite(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return null;
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  return null;
}

/** ¿Este archivo de test está citado (archivos_aplica) por un nodo ALTA? */
function esTestProtegido(db, testFileRel) {
  if (!db) return null;
  const norm = testFileRel.replace(/\\/g, '/');
  const rows = safe(() => db.prepare(
    `SELECT titulo, tipo, area, archivos_aplica FROM nodos
     WHERE confianza='ALTA' AND tipo IN ('patron','decision','error') AND estado='ACTIVO'`
  ).all()) || [];
  for (const r of rows) {
    let archivos = [];
    try { archivos = JSON.parse(r.archivos_aplica || '[]'); } catch {}
    if (archivos.some(a => String(a).replace(/\\/g, '/').endsWith(norm) || norm.endsWith(String(a).replace(/\\/g, '/')))) {
      return { titulo: r.titulo, area: r.area };
    }
  }
  return null;
}

function contenidoAnterior(projectRoot, fileRel) {
  return safe(() => execSync(`git show HEAD:${JSON.stringify(fileRel).slice(1, -1)}`, {
    cwd: projectRoot, stdio: 'pipe', timeout: 10000,
  }).toString(), null);
}

function scan(projectRoot, { staged = true, files = null } = {}) {
  const findings = [];
  let cambiados = files;
  if (!cambiados) {
    const diffFiles = safe(() => execSync(`git diff ${staged ? '--cached' : 'HEAD'} --name-only`, {
      cwd: projectRoot, stdio: 'pipe', timeout: 15000,
    }).toString(), '');
    cambiados = diffFiles.split('\n').map(s => s.trim()).filter(Boolean);
  }
  const testFiles = cambiados.filter(f => TEST_FILE_RE.test(f));
  if (!testFiles.length) return { findings, scanned: false };

  const db = openDB(projectRoot);

  for (const fileRel of testFiles) {
    const abs = path.isAbsolute(fileRel) ? fileRel : path.join(projectRoot, fileRel);
    const nuevo = safe(() => fs.readFileSync(abs, 'utf8'), null);
    if (nuevo == null) continue;
    const viejo = contenidoAnterior(projectRoot, fileRel);
    if (viejo == null) continue; // archivo nuevo — nada que comparar

    const titulosViejos = extraerTitulos(viejo);
    const titulosNuevos = extraerTitulos(nuevo);
    const desaparecidos = [...titulosViejos].filter(t => !titulosNuevos.has(t));
    if (!desaparecidos.length) continue;

    const proteccion = esTestProtegido(db, fileRel);
    const aVieja = contarAserciones(viejo);
    const aNueva = contarAserciones(nuevo);

    desaparecidos.forEach(titulo => {
      findings.push({
        file: fileRel, tituloDesaparecido: titulo,
        protegido: !!proteccion, area: proteccion ? proteccion.area : null,
        patronOrigen: proteccion ? proteccion.titulo : null,
        aserciones: { antes: aVieja, despues: aNueva },
        nivel: proteccion ? 'CRITICAL' : 'WARN',
      });
    });
  }
  safe(() => db && db.close());

  if (findings.length) {
    try {
      const gt = require(path.join(__dirname, 'gate-telemetry.cjs'));
      const wdb = openDBWrite(projectRoot);
      if (wdb) {
        findings.forEach(f => gt.recordGateEvent(wdb, {
          gate: 'test_integrity', verdict: f.nivel === 'CRITICAL' ? 'STOP' : 'WARN', source: 'mechanical',
          file: f.file, detalle: { titulo: f.tituloDesaparecido, protegido: f.protegido, patronOrigen: f.patronOrigen },
        }));
        safe(() => wdb.close());
      }
    } catch {}
  }
  return { findings, scanned: true };
}

function formatear(res) {
  if (!res.scanned) return 'TEST INTEGRITY GATE — sin tests de test cambiados que escanear.';
  if (!res.findings.length) return '✅ TEST INTEGRITY GATE — ningún título de test protegido desapareció.';
  const criticas = res.findings.filter(f => f.nivel === 'CRITICAL');
  const L = [];
  if (criticas.length) {
    L.push(`⛔ TEST INTEGRITY GATE — ${criticas.length} test(s) PROTEGIDO(s) modificado(s)/removido(s):`);
    criticas.forEach(f => L.push(
      `  🔴 ${f.file}: desapareció el test "${f.tituloDesaparecido}" — protege el patrón ALTA "${f.patronOrigen}" (área ${f.area}).\n` +
      `      Aserciones antes/después: ${f.aserciones.antes}/${f.aserciones.despues}. ¿El comportamiento que probaba sigue cubierto? Confírmalo.`
    ));
  }
  const warns = res.findings.filter(f => f.nivel !== 'CRITICAL');
  if (warns.length) {
    L.push(`⚠️  ${warns.length} test(s) sin vínculo conocido a memoria, título cambiado igual (revisar):`);
    warns.forEach(f => L.push(`  🟡 ${f.file}: "${f.tituloDesaparecido}" ya no aparece`));
  }
  return L.join('\n');
}

if (require.main === module) {
  const filesArg = process.argv.find(a => a.startsWith('--files='));
  const res = scan(process.cwd(), {
    staged: !filesArg,
    files: filesArg ? filesArg.split('=')[1].split(',').filter(Boolean) : null,
  });
  console.log(formatear(res));
  const hayCritica = res.findings.some(f => f.nivel === 'CRITICAL');
  process.exit(hayCritica ? 1 : 0); // CRÍTICO bloquea; WARN no (igual que los demás gates mecánicos)
}

module.exports = { scan, formatear, extraerTitulos, contarAserciones };
