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
  return safe(() => require('./db-adapter.cjs').openReadOnly(dbPath));
}

function openDBWrite(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return null;
  return safe(() => require('./db-adapter.cjs').openWrite(dbPath));
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
  const r = require('child_process').spawnSync('git', ['show', 'HEAD:' + String(fileRel).replace(/\\/g, '/')], {
    cwd: projectRoot, timeout: 10000, maxBuffer: 32 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout.toString('utf8') : null;
}

function scan(projectRoot, { staged = true, files = null, readContent = null, readBase = null, deleted = [], renamed = {} } = {}) {
  const findings = [];
  const borrados = new Set(deleted);
  let cambiados = files ? [...files, ...deleted] : files;
  if (!cambiados) {
    const diffFiles = safe(() => execSync(`git diff ${staged ? '--cached' : 'HEAD'} --name-only`, {
      cwd: projectRoot, stdio: 'pipe', timeout: 15000,
    }).toString(), '');
    cambiados = diffFiles.split('\n').map(s => s.trim()).filter(Boolean);
  }
  const testFiles = cambiados.filter(f => TEST_FILE_RE.test(f));
  if (!testFiles.length) return { findings, scanned: false };

  const db = openDB(projectRoot);
  const leerBase = readBase || ((rel) => contenidoAnterior(projectRoot, rel));
  const sinBase = [];
  let gitOk = null;

  for (const fileRel of testFiles) {
    const abs = path.isAbsolute(fileRel) ? fileRel : path.join(projectRoot, fileRel);
    const nuevo = borrados.has(fileRel) ? ''
      : readContent ? readContent(fileRel) : safe(() => fs.readFileSync(abs, 'utf8'), null);
    if (nuevo == null) continue;
    const viejo = leerBase(renamed[fileRel] || fileRel);
    if (viejo == null) {
      // Sin git no se distingue "archivo nuevo" de "no pude leer la versión anterior".
      if (!readBase && gitOk === null) gitOk = gitDisponible(projectRoot);
      if (!readBase && !gitOk) sinBase.push(fileRel);
      continue;
    }

    const titulosViejos = extraerTitulos(viejo);
    const titulosNuevos = extraerTitulos(nuevo);
    const desaparecidos = [...titulosViejos].filter(t => !titulosNuevos.has(t));
    if (!desaparecidos.length) continue;

    const proteccion = esTestProtegido(db, fileRel) || (renamed[fileRel] ? esTestProtegido(db, renamed[fileRel]) : null);
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
  return { findings, scanned: true, sinBase };
}

function gitDisponible(projectRoot) {
  const r = require('child_process').spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectRoot, timeout: 10000 });
  return r.status === 0;
}

/**
 * Resultado de gate para el controlador: FAIL si desapareció un test que
 * protege un nodo ALTA o cualquier título sin decisión registrada; UNVERIFIED
 * si no hay versión anterior con qué comparar; PASS si no se debilitó nada.
 */
function evaluar(projectRoot, { files = [], deleted = [], renamed = {}, readBase = null, readContent = null, subject_hash = null } = {}) {
  const { POLICY_ID } = require('./escenarios.cjs');
  const execution_id = require('crypto').randomUUID();
  const base = { gate: 'test-integrity', policy_id: POLICY_ID, execution_id, subject_hash };
  let res;
  try { res = scan(projectRoot, { staged: false, files, deleted, renamed, readBase, readContent }); }
  catch (e) { return Object.assign(base, { status: 'ERROR', reason_code: 'ESCANEO_FALLIDO', message: e.message }); }
  if (!res.scanned) return Object.assign(base, { status: 'PASS', reason_code: 'SIN_TESTS_TOCADOS', findings: [] });
  if (res.findings.length) {
    const criticos = res.findings.filter((f) => f.nivel === 'CRITICAL');
    return Object.assign(base, { status: 'FAIL', reason_code: criticos.length ? 'TEST_PROTEGIDO_REMOVIDO' : 'TITULO_DE_TEST_DESAPARECIDO', findings: res.findings });
  }
  if (res.sinBase && res.sinBase.length) return Object.assign(base, { status: 'UNVERIFIED', reason_code: 'SIN_VERSION_ANTERIOR', sin_base: res.sinBase, findings: [] });
  return Object.assign(base, { status: 'PASS', findings: [] });
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

module.exports = { scan, evaluar, formatear, extraerTitulos, contarAserciones };
