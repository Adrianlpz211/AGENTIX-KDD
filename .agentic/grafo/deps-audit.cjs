'use strict';

/**
 * Dependencias con vulnerabilidades conocidas — el A06 de OWASP.
 *
 * EL HUECO QUE CIERRA
 * -------------------
 * Agentix no comprobaba esto en ningún sitio. Lo único que había era
 * `npm audit signatures` en el workflow de publicación, que verifica las firmas
 * del registro de npm — **no busca vulnerabilidades**.
 *
 * Y A06 es de las categorías más explotadas del mundo real precisamente porque
 * no requiere habilidad: alguien escanea, ve una versión vulnerable de una
 * librería, y el exploit ya está publicado.
 *
 * POR QUÉ ESTE SÍ ES DETERMINISTA
 * -------------------------------
 * A diferencia del detector de SQL, aquí no hay heurística: `npm audit` consulta
 * una base de datos de vulnerabilidades con su CVE. O el paquete está en la
 * lista o no está. Cero falsos positivos por construcción.
 *
 * POR QUÉ NO CORRE EN CADA COMMIT
 * -------------------------------
 * Porque **las dependencias no cambian en cada commit** — cambian cuando
 * alguien instala algo. Correrlo siempre sería redescubrir lo mismo mil veces,
 * gastando una consulta de red cada vez. Quien lo llama (el post-cycle) solo lo
 * hace si `package.json` o el lock están en el cambio: en la práctica, una vez
 * cada tantos días, exactamente el día que importa.
 *
 *   node .agentic/grafo/deps-audit.cjs           informa
 *   node .agentic/grafo/deps-audit.cjs --si-cambio <archivos...>
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/* Los archivos cuyo cambio hace que valga la pena mirar. */
const ES_DEPENDENCIA = /(^|[\\/])(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/i;

const hayCambioDeDependencias = (archivos) =>
  (archivos || []).some((f) => ES_DEPENDENCIA.test(String(f)));

/**
 * Corre npm audit y devuelve el recuento por severidad.
 *
 * Fail-soft de verdad: sin red, sin lock, o con npm devolviendo algo que no es
 * JSON, se sale con `disponible: false` y sin ruido. Un proyecto no puede
 * quedarse sin cerrar su ciclo porque el registro de npm esté caído.
 */
const LOCKS = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const PERIODO_MS = 24 * 60 * 60 * 1000;   // sin cambio de deps, se vuelve a mirar una vez al día

/** Hash del lock: si no cambió y la consulta es reciente, se reutiliza. */
function huellaLock(raiz) {
  const crypto = require('crypto');
  for (const f of LOCKS) {
    try {
      const txt = fs.readFileSync(path.join(raiz, f));
      return f + ':' + crypto.createHash('sha256').update(txt).digest('hex').slice(0, 32);
    } catch { /* siguiente */ }
  }
  return null;
}

const rutaCache = (raiz) => path.join(raiz, '.agentic', '_cache', 'deps-audit.json');

function leerCache(raiz, huella, ahora) {
  if (!huella) return null;
  try {
    const c = JSON.parse(fs.readFileSync(rutaCache(raiz), 'utf8'));
    if (c.huella === huella && ahora - Date.parse(c.fecha) < CACHE_TTL_MS && c.resultado && c.resultado.status !== 'ERROR') {
      return Object.assign({}, c.resultado, { cache: { fecha: c.fecha, huella } });
    }
  } catch { /* sin caché */ }
  return null;
}

function guardarCache(raiz, huella, resultado, ahora) {
  if (!huella || resultado.status === 'ERROR') return;
  try {
    fs.mkdirSync(path.dirname(rutaCache(raiz)), { recursive: true });
    fs.writeFileSync(rutaCache(raiz), JSON.stringify({ huella, fecha: new Date(ahora).toISOString(), resultado }));
  } catch { /* la caché es un plus */ }
}

const error = (motivo, reason_code) => ({ disponible: false, status: 'ERROR', reason_code, motivo });

/** Corre `npm audit --json`. Devuelve {stdout, code, timedOut}. */
function correrNpmAudit(raiz, timeoutMs) {
  try {
    const stdout = execSync('npm audit --json', {
      cwd: raiz, timeout: timeoutMs, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout, code: 0, timedOut: false };
  } catch (e) {
    return {
      stdout: (e && e.stdout) ? String(e.stdout) : '',
      code: e && typeof e.status === 'number' ? e.status : null,
      timedOut: !!(e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM')),
    };
  }
}

/**
 * Resultado:
 *   PASS   respuesta válida sin vulnerabilidades
 *   FAIL   respuesta válida con vulnerabilidades (cualquier severidad)
 *   ERROR  ENOAUDIT, sin red, timeout, basura o formato desconocido — nunca "0"
 */
function auditar(raiz, { timeoutMs = 45000, ejecutar, ahora = Date.now(), usarCache = true } = {}) {
  raiz = raiz || process.cwd();

  if (!fs.existsSync(path.join(raiz, 'package.json'))) {
    return { disponible: false, status: 'SKIP', reason_code: 'NO_PACKAGE_JSON', motivo: 'el proyecto no tiene package.json' };
  }

  const huella = huellaLock(raiz);
  if (usarCache && !ejecutar) {
    const c = leerCache(raiz, huella, ahora);
    if (c) return c;
  }
  let previo = null;
  try { previo = JSON.parse(fs.readFileSync(rutaCache(raiz), 'utf8')); } catch { /* primera vez */ }

  /* npm audit sale con código 1 cuando ENCUENTRA vulnerabilidades: el código
     de salida solo no dice nada. Se valida la forma de la respuesta. */
  const r = (ejecutar || correrNpmAudit)(raiz, timeoutMs);
  if (r.timedOut) return error('npm audit no respondió a tiempo', 'TIMEOUT');
  const salida = String(r.stdout || '');
  if (!salida.trim()) return error('npm audit no devolvió nada (¿sin red o sin lock?)', 'SIN_SALIDA');

  let json;
  try { json = JSON.parse(salida); } catch {
    return error('npm audit devolvió algo que no es JSON', 'SALIDA_INVALIDA');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return error('npm audit devolvió un JSON sin la forma esperada', 'SALIDA_INVALIDA');
  }
  if (json.error) {
    const code = (json.error && json.error.code) || 'NPM_ERROR';
    return error('npm audit falló (' + code + ')', code);
  }

  const meta = (json.metadata && json.metadata.vulnerabilities) || null;
  if (!meta && !json.vulnerabilities && !json.advisories) {
    return error('npm audit devolvió un formato desconocido', 'FORMATO_DESCONOCIDO');
  }
  if (r.code !== null && r.code !== 0 && r.code !== 1) {
    return error('npm audit terminó con código ' + r.code, 'EXIT_' + r.code);
  }
  const res = construir(json, meta, exposiciones(raiz));
  /* Lo que importa del escaneo periódico: un aviso que aparece con el MISMO
     lock. Nadie tocó las dependencias y aun así hay algo nuevo. */
  if (previo && previo.resultado && Array.isArray(previo.resultado.advisories)) {
    const antes = new Set(previo.resultado.advisories);
    res.nuevos = res.advisories.filter((a) => !antes.has(a));
    res.lock_igual = previo.huella === huella;
  }
  guardarCache(raiz, huella, res, ahora);
  return res;
}

/** prod | dev | optional por paquete, según el lock (npm v7+). Sin lock: desconocida. */
function exposiciones(raiz) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(raiz, 'package-lock.json'), 'utf8'));
    const out = {};
    for (const [ruta, p] of Object.entries(lock.packages || {})) {
      if (!ruta) continue;
      const nombre = ruta.slice(ruta.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const exp = p.dev ? 'dev' : p.devOptional ? 'dev' : p.optional ? 'optional' : 'prod';
      const rango = { prod: 3, optional: 2, dev: 1 };
      if (!out[nombre] || rango[exp] > rango[out[nombre]]) out[nombre] = exp;
    }
    return out;
  } catch { return {}; }
}

/** Arreglo que npm puede aplicar sin cambio mayor. Uno mayor nunca con --force a ciegas. */
function tipoArreglo(fix) {
  if (fix === true) return 'compatible';
  if (fix && typeof fix === 'object') return fix.isSemVerMajor ? 'solo_mayor' : 'compatible';
  return 'sin_arreglo';
}

/** ¿Toca auditar? Si cambiaron las dependencias o la última consulta ya venció. */
function tocaRevisar(raiz, archivos, { ahora = Date.now(), periodoMs = PERIODO_MS } = {}) {
  if (hayCambioDeDependencias(archivos)) return { revisar: true, motivo: 'cambio de dependencias' };
  try {
    const c = JSON.parse(fs.readFileSync(rutaCache(raiz), 'utf8'));
    if (ahora - Date.parse(c.fecha) < periodoMs) return { revisar: false, motivo: 'revisado hace menos de ' + Math.round(periodoMs / 3600000) + ' h' };
  } catch { /* nunca se revisó */ }
  return { revisar: true, motivo: 'revisión periódica' };
}

function construir(json, meta, expo = {}) {
  const conteo = meta
    ? {
        critical: meta.critical || 0, high: meta.high || 0,
        moderate: meta.moderate || 0, low: meta.low || 0, info: meta.info || 0,
      }
    : contarAMano(json);

  const total = Object.values(conteo).reduce((a, b) => a + b, 0);

  /* Los paquetes concretos, para que el aviso sea accionable y no un número. */
  const paquetes = [];
  const advisories = new Set();
  const vulns = json.vulnerabilities || {};
  for (const [nombre, v] of Object.entries(vulns)) {
    if (!v) continue;
    for (const x of (Array.isArray(v.via) ? v.via : [])) if (x && typeof x === 'object' && x.url) advisories.add(x.url);
    if (!/^(critical|high)$/i.test(String(v.severity || ''))) continue;
    const arreglo = tipoArreglo(v.fixAvailable);
    paquetes.push({
      nombre,
      severidad: String(v.severity).toLowerCase(),
      exposicion: expo[nombre] || 'desconocida',
      directo: !!v.isDirect,
      via: (Array.isArray(v.via) ? v.via : [])
        .map((x) => (typeof x === 'string' ? x : (x && x.title) || ''))
        .filter(Boolean)[0] || null,
      fuentes: (Array.isArray(v.via) ? v.via : []).filter((x) => x && x.url).map((x) => x.url),
      arreglo,
      arreglable: arreglo === 'compatible',
    });
  }
  paquetes.sort((a, b) => (a.severidad === 'critical' ? -1 : 1) - (b.severidad === 'critical' ? -1 : 1));

  return {
    disponible: true, status: total ? 'FAIL' : 'PASS', conteo, total, paquetes,
    graves: conteo.critical + conteo.high,
    advisories: [...advisories].sort(),
  };
}

function contarAMano(json) {
  const c = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
  for (const v of Object.values(json.vulnerabilities || {})) {
    const s = String((v && v.severity) || '').toLowerCase();
    if (s in c) c[s]++;
  }
  return c;
}

function formatear(r) {
  if (!r.disponible) return 'DEPS AUDIT — ' + r.motivo + '.';
  if (!r.total) return '✅ DEPS AUDIT — ninguna dependencia con vulnerabilidad conocida.';

  const L = [];
  const cabecera = r.graves
    ? `⚠️  DEPS AUDIT — ${r.conteo.critical} crítica(s) y ${r.conteo.high} alta(s) de ${r.total} en total:`
    : `DEPS AUDIT — ${r.total} vulnerabilidad(es), ninguna grave ` +
      `(${r.conteo.moderate} moderada(s), ${r.conteo.low} baja(s)).`;
  L.push(cabecera);

  for (const p of r.paquetes.slice(0, 10)) {
    const arreglo = p.arreglo || (p.arreglable ? 'compatible' : 'sin_arreglo');
    L.push(`  · ${p.severidad.toUpperCase().padEnd(8)} ${p.nombre}${p.exposicion ? ` (${p.exposicion}${p.directo ? ', directa' : ''})` : ''}` +
      (p.via ? ` — ${String(p.via).slice(0, 70)}` : '') +
      (arreglo === 'compatible' ? '   [npm audit fix lo arregla]'
        : arreglo === 'solo_mayor' ? '   [solo con cambio mayor: revisar a mano, nunca --force]'
        : '   [sin arreglo disponible: mitigar y documentar]'));
  }
  if (r.nuevos && r.nuevos.length) {
    L.push('');
    L.push(`  ${r.nuevos.length} aviso(s) NUEVO(s)${r.lock_igual ? ' sin que cambiara el lock' : ''}:`);
    for (const a of r.nuevos.slice(0, 5)) L.push('    ' + a);
  }
  if (r.paquetes.length > 10) L.push(`  … y ${r.paquetes.length - 10} más.`);

  if (r.graves) {
    L.push('');
    L.push('  Esto NO es heurística: cada una tiene su CVE publicado. Si hay');
    L.push('  exploit conocido, no hace falta habilidad para usarlo.');
  }
  return L.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--si-cambio');
  if (i !== -1) {
    const archivos = args.slice(i + 1);
    if (!hayCambioDeDependencias(archivos)) {
      console.log('DEPS AUDIT — sin cambios en las dependencias, no hay nada que revisar.');
      process.exit(0);
    }
  }
  console.log(formatear(auditar(process.cwd())));
  process.exit(0);   // WARN-only, siempre
}

module.exports = { auditar, formatear, hayCambioDeDependencias, tocaRevisar, exposiciones, tipoArreglo, ES_DEPENDENCIA, huellaLock, CACHE_TTL_MS, PERIODO_MS };
