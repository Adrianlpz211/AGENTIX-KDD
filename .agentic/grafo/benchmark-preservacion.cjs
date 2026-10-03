#!/usr/bin/env node
'use strict';

/**
 * Benchmark de preservación (P19, 02-BENCHMARK). Un conjunto FINITO de casos,
 * inventariado antes de medir. Cada caso apunta a las pruebas ejecutables que
 * siembran ese fallo (o el cambio sano) y comprueban que el control lo
 * detecta (o lo deja pasar). Un caso sin prueba sigue en el denominador.
 *
 *   cobertura   casos con prueba ejecutable / casos inventariados
 *   detección   mutantes detectados / mutantes ejecutados
 *   falsos neg. mutantes que sobrevivieron / mutantes ejecutados
 *   falsa alarma sanos bloqueados / sanos ejecutados
 *   vigencia    casos con prueba corrida ahora sobre este sujeto / casos cubiertos
 *   enforcement vías con control previo verificado / vías inventariadas
 *
 * Cada número con su denominador y por separado: no hay promedio compuesto
 * que esconda un cero. Un SKIP no es detección. Con 0 ejecutados: no medible.
 * El 100% vale solo para ESTE catálogo, nunca es "seguridad completa".
 *
 * CLI: node benchmark-preservacion.cjs [--salida=_output] [--solo=B,F,S]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const P = (archivo, patron) => ({ archivo, patron });
const SIN = (arreglo) => ({ pruebas: [], arreglo });

/* ─── inventario ─────────────────────────────────────────────────────────── */

const CASOS = [
  // Backend — matriz mínima adversa (20)
  { id: 'B01', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'API cambia status/tipo/error', pruebas: [P('contratos-backend.test.cjs', 'P07: sembrar status HTTP')] },
  { id: 'B02', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'validación de frontera falla', pruebas: [P('contratos-backend.test.cjs', 'P07: sembrar tipos')] },
  { id: 'B03', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'autorización ausente', pruebas: [P('contratos-backend.test.cjs', 'P07: sembrar permisos')] },
  { id: 'B04', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'tenant cruzado', pruebas: [P('contratos-backend.test.cjs', 'P07: sembrar tenant cruzado')] },
  { id: 'B05', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'redondeo/dinero', pruebas: [P('contratos-backend.test.cjs', 'P07: sembrar redondeo')] },
  { id: 'B06', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'transacción parcial', pruebas: [P('efectos.test.cjs', 'P08: un lote con un efecto inválido'), P('update-transaccional.test.cjs', 'H25: fallo a mitad revierte')] },
  { id: 'B07', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'doble ejecución no idempotente', pruebas: [P('contratos-backend.test.cjs', 'P07: sembrar duplicación')] },
  { id: 'B08', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'carrera concurrente', pruebas: [P('contratos-backend.test.cjs', 'P07: sembrar carrera')] },
  { id: 'B09', lado: 'backend', tipo: 'mutante', criticidad: 'ALTA', caso: 'dependencia transitiva cambia', pruebas: [P('preservacion-escenarios.test.cjs', 'P04: cambiar un archivo importado'), P('blast-radius.test.cjs', 'H29: A')] },
  { id: 'B10', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'test eliminado o filtrado', pruebas: [P('politica-gates.test.cjs', 'P02: test-integrity'), P('preservacion-escenarios.test.cjs', 'P01: si solo corri')] },
  { id: 'B11', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'exit no cero con texto passed', pruebas: [P('preservacion-escenarios.test.cjs', 'P01: vac'), P('meta-gates.test.cjs', 'P20 GATE-EXIT')] },
  { id: 'B12', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'evidencia vacía, vieja o de otra fuente', pruebas: [P('preservacion-escenarios.test.cjs', 'P01: verifyAfterTDD'), P('preservacion-p14-c10.test.cjs', 'C08: TEAMS no acepta'), P('meta-gates.test.cjs', 'P20 GATE-EVIDENCIA-AJENA')] },
  { id: 'B13', lado: 'backend', tipo: 'mutante', criticidad: 'ALTA', caso: 'configuración o schema cambia', pruebas: [P('effort-router.test.cjs', '02: cambio de import o de lock'), P('preservacion-escenarios.test.cjs', 'P06: leer una base sin tablas'), P('meta-gates.test.cjs', 'P20 GATE-CACHE-VIEJA')] },
  { id: 'B14', lado: 'backend', tipo: 'mutante', criticidad: 'ALTA', caso: 'runner o driver ausente', pruebas: [P('preservacion-escenarios.test.cjs', 'P01: vac'), P('preservacion-p14-c10.test.cjs', 'C10: Node viejo')] },
  { id: 'B15', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'protected_file tocado', pruebas: [P('zip-mejoras.test.cjs', '03 guardia: edici'), P('preservacion-p14-c10.test.cjs', 'P16: la guardia')] },
  { id: 'B16', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'restore con efecto externo', pruebas: [P('efectos.test.cjs', 'P08: restore con efecto externo')] },
  { id: 'B17', lado: 'backend', tipo: 'mutante', criticidad: 'ALTA', caso: 'replay o promoción duplicada', pruebas: [P('preservacion-escenarios.test.cjs', 'P05: un replay'), P('meta-gates.test.cjs', 'P20 GATE-REPLAY'), P('teams.test.cjs', 'mensaje duplicado o reordenado')] },
  { id: 'B18', lado: 'backend', tipo: 'mutante', criticidad: 'ALTA', caso: 'ruta con espacios o renombre', pruebas: [P('preservacion-escenarios.test.cjs', 'P03: renombrar'), P('preservacion-p14-c10.test.cjs', 'C09: instalar usa ruta')], limite: 'rutas Unicode no tienen mutante propio' },
  { id: 'B19', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'baseline antes de submit', pruebas: [P('teams-baseline-rollback.test.cjs', 'P18: el host escribe al recibir'), P('meta-gates.test.cjs', 'P20 GATE-RESTORE-HASH')] },
  { id: 'B20', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'fallo del propio gate', pruebas: [P('preservacion-escenarios.test.cjs', 'P05: un escenario HIGH sin poder'), P('meta-gates.test.cjs', 'P20 GATE-PAYLOAD')] },

  // Frontend — matriz mínima adversa (30)
  { id: 'F01', lado: 'frontend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'handler de botón ausente', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F01'), P('politica-gates.test.cjs', 'P02: TDD verde con bot')] },
  { id: 'F02', lado: 'frontend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'submit no llega a la API', pruebas: [P('baseline-visual.test.cjs', 'P09/P10/P11/P12: navegador real')] },
  { id: 'F03', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'validación perdida', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F03')] },
  { id: 'F04', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'respuesta o error mostrados incorrectos', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F04')] },
  { id: 'F05', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'loading infinito', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F05')] },
  { id: 'F06', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'botón cubierto por overlay', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F06')] },
  { id: 'F07', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'select inutilizable', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F07')] },
  { id: 'F08', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'modal no cierra', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F08')] },
  { id: 'F09', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'foco no retorna', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F09:')] },
  { id: 'F10', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'teclado bloqueado (trampa)', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F10')] },
  { id: 'F11', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'ruta o refresh rota', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F11')] },
  { id: 'F12', lado: 'frontend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'permiso o rol incorrecto en UI', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F12')] },
  { id: 'F13', lado: 'frontend', tipo: 'mutante', criticidad: 'MEDIA', caso: 'responsive fuera de pantalla', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F13')] },
  { id: 'F14', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'token CSS compartido rompe otra pantalla', pruebas: [P('preservacion-p14-c10.test.cjs', 'P15: texto local no abre')] },
  { id: 'F15', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'misma vista en otra ruta', pruebas: [P('baseline-visual.test.cjs', 'P09/P10/P11/P12: navegador real')] },
  { id: 'F16', lado: 'frontend', tipo: 'mutante', criticidad: 'MEDIA', caso: 'assets o fuentes 404', pruebas: [P('baseline-visual.test.cjs', 'P09/P10/P11/P12: navegador real')] },
  { id: 'F17', lado: 'frontend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'captura nueva autoaceptada', pruebas: [P('baseline-visual.test.cjs', 'P10: capturar deja candidato'), P('baseline-visual.test.cjs', 'P09/P10/P11/P12: navegador real')] },
  { id: 'F18', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'cambio pequeño en región crítica', pruebas: [P('baseline-visual.test.cjs', 'P10: m')] },
  { id: 'F19', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'consola o promesa rechazada', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F19')] },
  { id: 'F20', lado: 'frontend', tipo: 'mutante', criticidad: 'MEDIA', caso: 'traducción crítica o estado vacío', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F20')] },
  { id: 'F21', lado: 'frontend', tipo: 'mutante', criticidad: 'BAJA', caso: 'reduced-motion ignorado', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F21')] },
  { id: 'F22', lado: 'frontend', tipo: 'mutante', criticidad: 'MEDIA', caso: 'tema o viewport distinto', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F22')] },
  { id: 'F23', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'caché o resumen viejo', pruebas: [P('recall-presupuesto.test.cjs', 'H32: cach'), P('preservacion-p14-c10.test.cjs', 'P14: la cach')] },
  { id: 'F24', lado: 'frontend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'XSS en un dato', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-F24')] },
  { id: 'F25', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'cámara o diseño del grafo alterado', pruebas: [P('dashboard-preservacion.test.cjs', 'DASH-BASE: las 7 vistas siguen idénticas')] },
  { id: 'F26', lado: 'frontend', tipo: 'mutante', criticidad: 'MEDIA', caso: 'tour requiere comando externo', pruebas: [P('tour-servicio.test.cjs', 'tour: se arma al abrir')] },
  { id: 'F27', lado: 'frontend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'prueba UI omitida (skip)', pruebas: [P('preservacion-escenarios.test.cjs', 'P01: un archivo con solo tests omitidos')] },
  { id: 'F28', lado: 'frontend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'navegador ausente', pruebas: [P('politica-gates.test.cjs', 'P02: TDD verde con bot'), P('browser-objetivo.test.cjs', 'H27: sin URL')] },
  { id: 'F29', lado: 'frontend', tipo: 'mutante', criticidad: 'ALTA', caso: 'dato no disponible mostrado como 0 o 100%', pruebas: [P('costo-uso.test.cjs', 'H31: usage ausente es null')], limite: 'en el dashboard se cierra con D01–D26' },
  { id: 'F30', lado: 'frontend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'contrato front/back incompatible', pruebas: [P('contratos-backend.test.cjs', 'P07: DTO p')] },

  // Controles sanos: deben pasar sin bloqueo injustificado
  { id: 'S01', lado: 'ambos', tipo: 'sano', caso: 'texto local', pruebas: [P('benchmark-front-mutantes.test.cjs', 'BENCH-SANO'), P('effort-router.test.cjs', '02: texto localizado sigue LOW')] },
  { id: 'S02', lado: 'backend', tipo: 'sano', caso: 'refactor equivalente', pruebas: [P('contratos-backend.test.cjs', 'P07: un cambio interno equivalente')] },
  { id: 'S03', lado: 'ambos', tipo: 'sano', caso: 'cambio intencional aprobado', pruebas: [P('preservacion-escenarios.test.cjs', 'P05: un cambio intencional'), P('baseline-visual.test.cjs', 'P10: aprobar exige aprobador')] },
  { id: 'S04', lado: 'backend', tipo: 'sano', caso: 'dependencia no afectada', pruebas: [P('blast-radius.test.cjs', 'H29: una subcadena no inventa')] },
  { id: 'S05', lado: 'ambos', tipo: 'sano', caso: 'documentación', pruebas: [P('canario-gate.test.cjs', 'un cambio que no toca')] },
  { id: 'S06', lado: 'ambos', tipo: 'sano', caso: 'escenario alternativo válido (copia sin mutar)', pruebas: [P('meta-gates.test.cjs', 'P20 GATE-')], limite: 'la copia sana y la mutada comparten prueba: un FAIL aquí puede ser sobreviviente, se lee junto a B11–B20' },
  { id: 'S07', lado: 'frontend', tipo: 'sano', caso: 'estilos fuera de región protegida', pruebas: [P('ui-layout-autocapture.test.cjs', 'un cambio nuevo NO molesta')] },
];

/* ─── ejecución ──────────────────────────────────────────────────────────── */

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

function sujeto(root) {
  const partes = [];
  for (const d of ['.agentic/grafo', 'test']) {
    const dir = path.join(root, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /\.c?js$/.test(x)).sort()) partes.push([d + '/' + f, sha(fs.readFileSync(path.join(dir, f)))]);
  }
  return sha(JSON.stringify(partes)).slice(0, 16);
}

/** Títulos y resultado por prueba con el reporter TAP (ok / not ok / # SKIP). */
function correrArchivo(root, archivo, patrones) {
  const env = Object.assign({}, process.env);
  delete env.NODE_TEST_CONTEXT;
  const args = ['--test', '--test-reporter=tap', ...patrones.map((p) => `--test-name-pattern=${esc(p)}`), path.join('test', archivo)];
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 600000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const resultados = [];
  for (const l of String(r.stdout || '').split(/\r?\n/)) {
    const m = /^\s*(not ok|ok) \d+ - (.*?)(\s+#\s+(SKIP|TODO).*)?$/.exec(l);
    if (m) { resultados.push({ titulo: m[2].replace(/\\#/g, '#'), status: m[3] ? 'SKIP' : (m[1] === 'ok' ? 'PASS' : 'FAIL') }); continue; }
    // Un archivo cuyo proceso hijo reenvía el reporter spec llega como comentario.
    const s = /^\s*#\s*([✔✖﹣])\s+(.*?)(\s+\([\d.]+m?s\))?(\s+#\s+(SKIP|TODO).*)?$/.exec(l);
    if (s) resultados.push({ titulo: s[2], status: s[4] || s[1] === '﹣' ? 'SKIP' : (s[1] === '✔' ? 'PASS' : 'FAIL') });
  }
  return { archivo, exit: r.status, ms: Date.now() - t0, resultados, error: r.error ? String(r.error.message) : null };
}

function existe(root, archivo) { return fs.existsSync(path.join(root, 'test', archivo)); }

function ejecutar(root, { solo, casos: catalogo } = {}) {
  const casos = (catalogo || CASOS).filter((c) => !solo || solo.includes(c.id[0]));
  const porArchivo = new Map();
  for (const c of casos) for (const p of c.pruebas) {
    if (!existe(root, p.archivo)) continue;
    if (!porArchivo.has(p.archivo)) porArchivo.set(p.archivo, new Set());
    porArchivo.get(p.archivo).add(p.patron);
  }
  const corridas = new Map();
  for (const [archivo, pats] of porArchivo) corridas.set(archivo, correrArchivo(root, archivo, [...pats]));

  const execution_id = 'bench-' + Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 6);
  const subject_hash = sujeto(root);
  const filas = casos.map((c) => {
    if (!c.pruebas.length) return { case_id: c.id, lado: c.lado, tipo: c.tipo, criticidad: c.criticidad || null, caso: c.caso, estado: 'SIN_PRUEBA', detected: null, arreglo: c.arreglo };
    const vistas = c.pruebas.map((p) => {
      if (!existe(root, p.archivo)) return { ...p, status: 'SIN_ARCHIVO' };
      const run = corridas.get(p.archivo);
      const m = run.resultados.filter((x) => x.titulo.startsWith(p.patron) || x.titulo.includes(p.patron));
      if (!m.length) return { ...p, status: 'NO_SELECCIONADA' };
      return { ...p, status: m.some((x) => x.status === 'FAIL') ? 'FAIL' : (m.every((x) => x.status === 'SKIP') ? 'SKIP' : 'PASS'), titulos: m.map((x) => x.titulo) };
    });
    const ejecutadas = vistas.filter((v) => v.status === 'PASS' || v.status === 'FAIL');
    let estado;
    // Toda prueba asignada debe correr: una omitida o no seleccionada no se descuenta en silencio.
    if (ejecutadas.length < vistas.length && !ejecutadas.some((v) => v.status === 'FAIL')) estado = 'NO_EJECUTADA';
    else estado = ejecutadas.every((v) => v.status === 'PASS') ? (c.tipo === 'sano' ? 'PASA' : 'DETECTADO') : (c.tipo === 'sano' ? 'FALSA_ALARMA' : 'SOBREVIVIO');
    return {
      case_id: c.id, lado: c.lado, tipo: c.tipo, criticidad: c.criticidad || null, caso: c.caso, estado,
      expected: c.tipo === 'sano' ? 'PASA' : 'DETECTADO', detected: c.tipo === 'sano' ? null : estado === 'DETECTADO',
      gate: 'prueba-negativa', pruebas: vistas, subject_hash, execution_id, limite: c.limite || null,
    };
  });
  return { execution_id, subject_hash, node: process.version, plataforma: process.platform, filas, corridas: [...corridas.values()].map(({ archivo, exit, ms, error }) => ({ archivo, exit, ms, error })) };
}

/* ─── métricas ───────────────────────────────────────────────────────────── */

const frac = (n, d) => ({ n, d, pct: d ? Math.round((n / d) * 1000) / 10 : null, texto: d ? `${n}/${d}` : 'no medible (0 observaciones)' });

function metricas(filas, { enforcement } = {}) {
  const out = {};
  for (const lado of ['backend', 'frontend']) {
    const m = filas.filter((f) => f.tipo === 'mutante' && f.lado === lado);
    const cubiertos = m.filter((f) => f.estado !== 'SIN_PRUEBA');
    const ejecutados = m.filter((f) => f.estado === 'DETECTADO' || f.estado === 'SOBREVIVIO');
    const criticos = m.filter((f) => f.criticidad === 'CRITICA');
    const sanos = filas.filter((f) => f.tipo === 'sano' && (f.lado === lado || f.lado === 'ambos') && (f.estado === 'PASA' || f.estado === 'FALSA_ALARMA'));
    out[lado] = {
      cobertura: frac(cubiertos.length, m.length),
      deteccion: frac(ejecutados.filter((f) => f.estado === 'DETECTADO').length, ejecutados.length),
      falsos_negativos: frac(ejecutados.filter((f) => f.estado === 'SOBREVIVIO').length, ejecutados.length),
      falsa_alarma: frac(sanos.filter((f) => f.estado === 'FALSA_ALARMA').length, sanos.length),
      vigencia: frac(ejecutados.length, cubiertos.length),
      criticos_detectados: frac(criticos.filter((f) => f.estado === 'DETECTADO').length, criticos.length),
      sin_prueba: m.filter((f) => f.estado === 'SIN_PRUEBA').map((f) => ({ id: f.case_id, caso: f.caso, arreglo: f.arreglo })),
      sobrevivientes: m.filter((f) => f.estado === 'SOBREVIVIO').map((f) => f.case_id),
      no_ejecutados: m.filter((f) => f.estado === 'NO_EJECUTADA').map((f) => f.case_id),
    };
  }
  if (enforcement) out.enforcement = frac(enforcement.filas.filter((f) => f.estado === 'CUBIERTO').length, enforcement.filas.length);
  out.nota = 'Cada número va con su denominador y por separado; no hay promedio compuesto. 100% vale solo para este catálogo.';
  return out;
}

function informe(root, opts = {}) {
  const r = ejecutar(root, opts);
  let enforcement = null;
  try { enforcement = require('./host-hooks.cjs').cobertura(root); } catch { /* sin hooks */ }
  return Object.assign(r, { metricas: metricas(r.filas, { enforcement }), enforcement: enforcement ? { estado: enforcement.enforcement, huecos: enforcement.huecos } : null });
}

module.exports = { CASOS, ejecutar, metricas, informe, frac };

if (require.main === module) {
  const opt = Object.fromEntries(process.argv.slice(2).map((a) => /^--([^=]+)=(.*)$/.exec(a)).filter(Boolean).map((m) => [m[1], m[2]]));
  const root = process.cwd();
  const rep = informe(root, { solo: opt.solo ? opt.solo.split(',') : null });
  const dir = path.resolve(root, opt.salida || '_output');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `benchmark-preservacion-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(f, JSON.stringify(rep, null, 2));
  const M = rep.metricas;
  for (const lado of ['backend', 'frontend']) {
    const x = M[lado];
    console.log(`${lado}: cobertura ${x.cobertura.texto} · detección ${x.deteccion.texto} · falsos negativos ${x.falsos_negativos.texto} · falsa alarma ${x.falsa_alarma.texto} · vigencia ${x.vigencia.texto} · críticos detectados ${x.criticos_detectados.texto}`);
    if (x.sobrevivientes.length) console.log(`  sobrevivientes: ${x.sobrevivientes.join(', ')}`);
    if (x.no_ejecutados.length) console.log(`  no ejecutados: ${x.no_ejecutados.join(', ')}`);
    if (x.sin_prueba.length) console.log(`  sin prueba: ${x.sin_prueba.map((s) => s.id).join(', ')}`);
  }
  if (M.enforcement) console.log(`enforcement: ${M.enforcement.texto} vías con control previo (${rep.enforcement.estado})`);
  console.log(`informe: ${path.relative(root, f)} · execution_id ${rep.execution_id} · sujeto ${rep.subject_hash}`);
  if (Object.values(M).some((x) => x && x.sobrevivientes && x.sobrevivientes.length)) process.exitCode = 1;
}
