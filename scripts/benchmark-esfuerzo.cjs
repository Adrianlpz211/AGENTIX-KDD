#!/usr/bin/env node
/**
 * Benchmark de esfuerzo proporcional (02-esfuerzo-y-tokens / 03-BENCHMARK).
 *
 * 15 fixtures (5 LOW, 5 MEDIUM, 5 HIGH), mismo estado base, sin producción.
 * Compara lo que Agentix hace cargar y ejecutar con el pipeline anterior
 * (todo aa: leía config, trabajo, errores, patrones y los agentes 01-05, y
 * corría el mismo set de gates con suite completa) contra el router nuevo
 * (núcleo + referencias por rol/tier + paquete de contexto + gates del tier).
 *
 * Mide BYTES REALES de archivos y paquetes, pasos (roles + gates) y
 * ejecuciones de tests. NO mide tokens del host: no hay dato, se reporta
 * NO_VERIFICADO. CLAUDE.md lo carga el host en ambos casos: se reporta como
 * constante aparte, no se resta ni se suma al ahorro.
 *
 * UMBRAL (fijado antes de correr, no se ajusta al resultado):
 *   · LOW: mediana de bytes aportados y de pasos ≥ 30 % menor que el anterior.
 *   · HIGH: conserva tdd, preservation, qa y reviewer (ningún gate perdido).
 *   · Todos: los 4 mínimos (scope, protected-files, security, leases) presentes.
 *
 * Uso: node scripts/benchmark-esfuerzo.cjs [--json]
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const router = require(path.join(REPO, '.agentic/grafo/effort-router.cjs'));
const cp = require(path.join(REPO, '.agentic/grafo/context-pack.cjs'));

const UMBRAL_LOW = 0.30;
const HIGH_CONSERVA = ['tdd', 'preservation', 'qa'];

const FIXTURES = [
  { clase: 'LOW', id: 'low-texto', intent: 'cambia el texto del botón Guardar a Enviar', paths: ['src/components/Boton.tsx'], type: 'LOCAL_TEXT_CHANGE' },
  { clase: 'LOW', id: 'low-estilo', intent: 'ajusta el color del encabezado al gris de la marca', paths: ['src/styles/header.css'], type: 'STYLE_CHANGE' },
  { clase: 'LOW', id: 'low-rename', intent: 'renombra la variable local tmp a total en la vista de resumen', paths: ['src/views/resumen.js'], type: 'SAFE_RENAME' },
  { clase: 'LOW', id: 'low-bug-obvio', intent: 'corrige el typo en el mensaje de bienvenida', paths: ['src/pages/home.html'], type: 'LOCAL_TEXT_CHANGE' },
  { clase: 'LOW', id: 'low-test', intent: 'agrega un caso al test localizado del formateador de fechas', paths: ['test/fecha.test.js'], type: 'LOCAL_TEST' },
  { clase: 'MEDIUM', id: 'med-bug', intent: 'arregla el bug del total del carrito con descuentos', paths: ['src/cart/total.ts'], type: 'BOUNDED_BUG' },
  { clase: 'MEDIUM', id: 'med-feature', intent: 'agrega el filtro por fecha en el listado de pedidos', paths: ['src/pedidos/listado.ts', 'src/components/FiltroFecha.tsx'] },
  { clase: 'MEDIUM', id: 'med-refactor', intent: 'refactoriza el módulo de reportes para separar el formateo', paths: ['src/reportes/a.ts', 'src/reportes/formato.ts'] },
  { clase: 'MEDIUM', id: 'med-validacion', intent: 'agrega validación de correo al formulario de registro', paths: ['src/forms/registro.ts'] },
  { clase: 'MEDIUM', id: 'med-api', intent: 'agrega paginación a la consulta de productos', paths: ['src/productos/consulta.ts'], type: 'BOUNDED_BUG' },
  { clase: 'HIGH', id: 'high-auth', intent: 'cambia dos líneas en la verificación de permisos', paths: ['src/middleware/permisos.ts'] },
  { clase: 'HIGH', id: 'high-contrato', intent: 'modifica el contrato protegido de facturación', paths: ['src/facturas/emitir.ts'], contracts: { protected: 1 } },
  { clase: 'HIGH', id: 'high-transaccion', intent: 'cambia la transacción de cobro para reintentar el pago', paths: ['src/pagos/cobro.ts'] },
  { clase: 'HIGH', id: 'high-transversal', intent: 'cambio transversal del manejo de errores en todos los módulos', paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts'], type: 'CROSS_CUTTING' },
  { clase: 'HIGH', id: 'high-datos', intent: 'migración de la tabla de clientes para agregar una columna', paths: ['prisma/schema.prisma', 'migrations/002.sql'] },
];

/* Lo que el pipeline anterior hacía leer en cada aa: (agentic.mdc + CLAUDE.md). */
const ANTERIOR_LECTURAS = [
  '.agentic/config.md', '.agentic/memoria/trabajo.md', '.agentic/memoria/errores.md', '.agentic/memoria/patrones.md',
  '.agentic/agentes/01-orquestador.md', '.agentic/agentes/02-analista.md', '.agentic/agentes/03-front.md',
  '.agentic/agentes/04-back.md', '.agentic/agentes/05-qa.md',
];
const ANTERIOR_ROLES = ['analyst', 'builder', 'qa', 'reviewer'];
const ANTERIOR_GATES = ['spec', 'security', 'regression', 'tdd', 'qa', 'preservation', 'review', 'memory', 'post-cycle'];
/* Lo que el nuevo sigue leyendo siempre por CLAUDE.md (pendiente de compactar). */
const NUEVO_SIEMPRE = ['.agentic/config.md', '.agentic/memoria/trabajo.md'];

const tam = (root, rel) => { try { return fs.statSync(path.join(root, rel)).size; } catch { return 0; } };
const mediana = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

function base() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-bench-'));
  for (const rel of [...ANTERIOR_LECTURAS, cp.NUCLEO]) {
    const src = path.join(REPO, rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(root, rel));
  }
  fs.copyFileSync(path.join(REPO, '.agentic/effort-policy.json'), path.join(root, '.agentic/effort-policy.json'));
  fs.mkdirSync(path.join(root, '.agentic/specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agentic/specs/global.md'), '# spec activa\n');
  return root;
}

async function correr() {
  const root = base();
  const anteriorBytes = ANTERIOR_LECTURAS.reduce((s, r) => s + tam(root, r), 0);
  const siempreBytes = NUEVO_SIEMPRE.reduce((s, r) => s + tam(root, r), 0);
  const filas = [];
  for (const f of FIXTURES) {
    const t0 = process.hrtime.bigint();
    const d = router.decidirYGuardar(root, { task_id: f.id, intent: f.intent, paths: f.paths, change_type: f.type, contracts: f.contracts, index_coverage: 'COMPLETE', origen: 'benchmark' });
    const frio = await cp.armar(root, { task_id: f.id, objetivo: f.intent, aceptacion: ['criterio de la fixture'], paths: f.paths, decision: d });
    const tibio = await cp.armar(root, { task_id: f.id, objetivo: f.intent, aceptacion: ['criterio de la fixture'], paths: f.paths, decision: d });
    const porRol = d.required_roles.map((r) => cp.paraRol(root, frio, r).bytes);
    const nuevoBytes = siempreBytes + porRol.reduce((a, b) => a + b, 0);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const pasosNuevo = d.required_roles.length + d.required_gates.length;
    const pasosAnterior = ANTERIOR_ROLES.length + ANTERIOR_GATES.length;
    const faltanMinimos = router.MINIMOS.filter((g) => !d.required_gates.includes(g));
    const highPierde = d.tier === 'HIGH' ? [...HIGH_CONSERVA.filter((g) => !d.required_gates.includes(g)), ...(d.required_roles.includes('reviewer') ? [] : ['reviewer'])] : [];
    filas.push({
      id: f.id, clase_esperada: f.clase, tier: d.tier, risk: d.risk, motivos: d.reason_codes,
      bytes_anterior: anteriorBytes, bytes_nuevo: nuevoBytes, reduccion_bytes: 1 - nuevoBytes / anteriorBytes,
      pasos_anterior: pasosAnterior, pasos_nuevo: pasosNuevo, reduccion_pasos: 1 - pasosNuevo / pasosAnterior,
      tests_anterior: 'suite completa', tests_nuevo: d.required_gates.includes('tdd') ? 'suite completa' : d.required_gates.includes('affected-tests') ? 'dirigidos' : 'check relevante',
      cache_tibio_reutilizado: tibio.reutilizado, ms: Math.round(ms * 10) / 10,
      escalo: f.clase !== d.tier, faltan_minimos: faltanMinimos, high_pierde: highPierde,
    });
  }
  const low = filas.filter((x) => x.tier === 'LOW');
  const medLowBytes = mediana(low.map((x) => x.reduccion_bytes));
  const medLowPasos = mediana(low.map((x) => x.reduccion_pasos));
  const verdicto = {
    umbral_low: UMBRAL_LOW,
    low_mediana_reduccion_bytes: medLowBytes,
    low_mediana_reduccion_pasos: medLowPasos,
    low_cumple: medLowBytes !== null && medLowBytes >= UMBRAL_LOW && medLowPasos >= UMBRAL_LOW,
    minimos_intactos: filas.every((x) => !x.faltan_minimos.length),
    high_conserva: filas.every((x) => !x.high_pierde.length),
    outliers: filas.filter((x) => x.escalo).map((x) => ({ id: x.id, esperado: x.clase_esperada, tier: x.tier, motivos: x.motivos })),
    tokens_host: 'NO_VERIFICADO — sin dato del proveedor; bytes/pasos son proxy',
    claude_md_constante_bytes: tam(REPO, 'CLAUDE.md'),
    compactacion_claude_md: 'PENDIENTE — CLAUDE.md lo carga el host igual en ambos pipelines; nucleo-reglas.md existe pero CLAUDE.md no se recortó',
    instalacion_indexacion: 'excluida (costo de primera vez, se mide aparte)',
  };
  fs.rmSync(root, { recursive: true, force: true });
  return { fecha: new Date().toISOString(), node: process.version, plataforma: process.platform, policy_version: 1, filas, verdicto };
}

function md(r) {
  const pct = (x) => (x === null ? 'sin dato' : Math.round(x * 100) + ' %');
  const l = [`# Benchmark de esfuerzo — ${r.fecha.slice(0, 10)}`, '',
    `node ${r.node} · ${r.plataforma} · política v${r.policy_version}. Bytes = archivos y paquetes que Agentix hace cargar (proxy). Tokens del host: **NO_VERIFICADO**.`, '',
    '| fixture | esperado | tier | bytes ant → nuevo | Δ bytes | pasos ant → nuevo | tests | tibio reutiliza |', '|---|---|---|---|---|---|---|---|'];
  for (const f of r.filas) l.push(`| ${f.id} | ${f.clase_esperada} | ${f.tier} | ${f.bytes_anterior} → ${f.bytes_nuevo} | ${pct(f.reduccion_bytes)} | ${f.pasos_anterior} → ${f.pasos_nuevo} | ${f.tests_nuevo} | ${f.cache_tibio_reutilizado ? 'sí' : 'no'} |`);
  const v = r.verdicto;
  l.push('', '## Veredicto (umbral fijado antes de correr)', '',
    `- LOW: mediana de reducción de bytes ${pct(v.low_mediana_reduccion_bytes)}, de pasos ${pct(v.low_mediana_reduccion_pasos)} — umbral ${pct(v.umbral_low)} → **${v.low_cumple ? 'CUMPLE' : 'NO CUMPLE'}**`,
    `- Mínimos (scope, protected-files, security, leases) en las 15: **${v.minimos_intactos ? 'sí' : 'NO'}**`,
    `- HIGH conserva tdd, preservation, qa y reviewer: **${v.high_conserva ? 'sí' : 'NO'}**`,
    `- Tareas que escalaron respecto a lo esperado: ${v.outliers.length ? v.outliers.map((o) => `${o.id} (${o.esperado}→${o.tier}: ${o.motivos.join(', ')})`).join('; ') : 'ninguna'}`,
    `- CLAUDE.md (${v.claude_md_constante_bytes} B) se carga igual en ambos: ${v.compactacion_claude_md}.`,
    `- Instalación/indexación: ${v.instalacion_indexacion}.`,
    '', 'Estos números miden cuánto contexto y cuántos pasos se piden, no la calidad del resultado.');
  return l.join('\n') + '\n';
}

if (require.main === module) {
  correr().then((r) => {
    const out = path.join(REPO, '_output');
    fs.mkdirSync(out, { recursive: true });
    const f = path.join(out, `benchmark-esfuerzo-${r.fecha.slice(0, 10)}.md`);
    fs.writeFileSync(f, md(r));
    if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else process.stdout.write(md(r) + `\n→ ${path.relative(REPO, f)}\n`);
    process.exitCode = r.verdicto.minimos_intactos && r.verdicto.high_conserva ? 0 : 1;
  }).catch((e) => { console.error(e); process.exitCode = 2; });
}

module.exports = { correr, FIXTURES, UMBRAL_LOW };
