'use strict';

/**
 * Madurez Lint — Agentic KDD v3.15 (Plan 7, T4)
 *
 * La frontera de complejidad como REGLA MECÁNICA, no como intención:
 *   core         → solo puede CARGAR con core
 *   stable       → puede cargar con core + stable
 *   experimental → puede cargar con lo que sea
 *
 * La frontera aplica a los requires DE CARGA (columna 0: "no puedo ni cargar
 * sin ti" — si la dependencia crashea al cargar, el módulo cae con ella).
 * Los requires PEREZOSOS (indentados, dentro de funciones/try fail-soft) SÍ
 * pueden invocar hacia arriba: el módulo carga y funciona igual si la
 * dependencia falla — es exactamente la arquitectura "es un plus" que el
 * motor ya usa en todas partes (verificado: las 11 invocaciones core→superior
 * existentes eran perezosas salvo 2, que se corrigieron). Un cliente con un
 * módulo experimental roto conserva un core funcional — esa es la promesa.
 *
 * Lee los require('./x.cjs') REALES de cada módulo (regex sobre el código —
 * el motor no se auto-indexa) y falla si un require de carga cruza la
 * frontera. Sin mover carpetas: el manifiesto es datos (.agentic/MADUREZ.json),
 * el lint es hierro.
 *
 * Uso: node .agentic/grafo/madurez-lint.cjs   (exit 1 si hay violaciones)
 */

const fs = require('fs');
const path = require('path');

const GRAFO = __dirname;
// El manifiesto vive DENTRO de grafo/: describe módulos del motor y así viaja
// solo con cada `akdd update` (update.js solo re-copia .agentic/grafo/).
const MANIFIESTO = path.join(GRAFO, 'MADUREZ.json');

const RANGO = { core: 0, stable: 1, experimental: 2 };

function cargarNiveles() {
  let m = { core: [], stable: [], experimental: [] };
  try { m = JSON.parse(fs.readFileSync(MANIFIESTO, 'utf8')); } catch {}
  const nivelDe = {};
  ['core', 'stable', 'experimental'].forEach(nivel =>
    (m[nivel] || []).forEach(mod => { nivelDe[mod] = nivel; }));
  return nivelDe;
}

function requiresDe(archivo) {
  const contenido = fs.readFileSync(path.join(GRAFO, archivo), 'utf8');
  const hard = new Set(); // require de CARGA: la línea empieza en columna 0
  const lazy = new Set(); // require perezoso: indentado (dentro de función/try)
  const RE = [
    /require\(\s*['"]\.\/([\w.-]+\.cjs)['"]\s*\)/g,
    /require\(\s*(?:require\(['"]path['"]\)|path)\.join\(\s*__dirname\s*,\s*['"]([\w.-]+\.cjs)['"]\s*\)\s*\)/g,
  ];
  for (const linea of contenido.split('\n')) {
    for (const re of RE) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(linea)) !== null) {
        (/^\S/.test(linea) ? hard : lazy).add(m[1]);
      }
    }
  }
  return { hard: [...hard], lazy: [...lazy] };
}

function lint() {
  const nivelDe = cargarNiveles();
  const modulos = fs.readdirSync(GRAFO).filter(f => f.endsWith('.cjs'));
  const violaciones = [];
  let cruces = 0; // perezosos que cruzan hacia arriba (permitidos, contados)

  for (const mod of modulos) {
    const nivel = nivelDe[mod] || 'stable'; // no listado = stable (conservador)
    let deps = { hard: [], lazy: [] };
    try { deps = requiresDe(mod); } catch { continue; }
    for (const dep of deps.hard) {
      if (!modulos.includes(dep)) continue;
      const nivelDep = nivelDe[dep] || 'stable';
      if (RANGO[nivelDep] > RANGO[nivel]) {
        violaciones.push({ mod, nivel, dep, nivelDep });
      }
    }
    for (const dep of deps.lazy) {
      if (!modulos.includes(dep)) continue;
      if (RANGO[nivelDe[dep] || 'stable'] > RANGO[nivel]) cruces++;
    }
  }
  return { violaciones, total: modulos.length, crucesPerezosos: cruces };
}

if (require.main === module) {
  const r = lint();
  if (!r.violaciones.length) {
    console.log(`✅ MADUREZ LINT — ${r.total} módulos, cero violaciones de frontera de carga (core carga solo con core; stable con core+stable). ${r.crucesPerezosos} invocación(es) perezosa(s) hacia arriba — permitidas por diseño (fail-soft).`);
    process.exit(0);
  }
  console.log(`🛑 MADUREZ LINT — ${r.violaciones.length} violación(es) de frontera de carga:`);
  r.violaciones.forEach(v =>
    console.log(`  ✗ ${v.mod} (${v.nivel}) CARGA con ${v.dep} (${v.nivelDep}) — si ${v.dep} crashea al cargar, tumba a ${v.mod}`));
  console.log('  → O vuelve el require perezoso (muévelo dentro de la función, con try/catch), o sube la madurez de la dependencia en .agentic/MADUREZ.json (si lo merece).');
  process.exit(1);
}

module.exports = { lint, cargarNiveles, requiresDe };
