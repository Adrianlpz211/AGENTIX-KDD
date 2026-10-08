'use strict';
/**
 * TEAMS v4 — el canal. Lee y escribe `.legion/AUDITORIA-CURSOR.md`, el archivo que ya usa el protocolo manual.
 *
 * Principios (del protocolo del dueño, no se negocian):
 *   · Un solo canal, un solo archivo. Si no está escrito aquí, no pasó.
 *   · Este módulo OBSERVA y ayuda a escribir; no decide ni frena nada. Nada de máquinas de estados.
 *   · Tolera el archivo tal como lo dejó una persona o un modelo: secciones por encabezado `## `, elementos por
 *     `### ` (o viñetas), "resuelto" por la marca `✅ RESUELTO`. Un canal de la plantilla vieja se lee igual.
 *   · Escribe con lock + relectura + renombrado atómico: dos agentes escribiendo no se pisan.
 *
 * Es solo mecánica de archivo: leer secciones, listar elementos, añadir bloques, marcar. La lógica de ronda,
 * omisiones y avance vive en teams.cjs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = '.legion';
const ARCHIVO = 'AUDITORIA-CURSOR.md';
const rutaCanal = (root) => path.join(root, DIR, ARCHIVO);
const dirEstado = (root) => path.join(root, '.agentic', '_teams');

const quitarAcentos = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => quitarAcentos(s).toLowerCase().trim();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const SECCIONES = [
  ['correcciones', /^correcciones pendientes/],
  ['tareas', /^tareas para/],
  ['reporte', /^reporte de/],
  ['auditoria', /^auditoria del director/],
  ['decisiones', /^decisiones/],
];
const claveSeccion = (titulo) => { const n = norm(titulo); const s = SECCIONES.find(([, re]) => re.test(n)); return s ? s[0] : null; };

const RESUELTO = /✅\s*RESUELTO/i;
const HECHO = /✅\s*HECHO/i;
const ACEPTADA = /✅\s*ACEPTAD[AO]/i;
const HEREDADA = /✔\s*HEREDAD[AO]/i;
const CANCELADA = /(?:❌|✖)\s*CANCELAD[AO]/i;
const AHORA = () => new Date();
const sello = (d = AHORA()) => {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};

// ───────────────────────────── lectura ──────────────────────────────────────

/** Blanquea los comentarios HTML conservando la numeración de líneas (las plantillas traen texto con palabras clave dentro). */
function sinComentarios(lineas) {
  let dentro = false;
  return lineas.map((l) => {
    let out = ''; let i = 0;
    while (i < l.length) {
      if (dentro) { const f = l.indexOf('-->', i); if (f < 0) { i = l.length; } else { dentro = false; i = f + 3; } }
      else { const a = l.indexOf('<!--', i); if (a < 0) { out += l.slice(i); i = l.length; } else { out += l.slice(i, a); dentro = true; i = a + 4; } }
    }
    return out;
  });
}

function leerTexto(root) {
  try { return fs.readFileSync(rutaCanal(root), 'utf8'); } catch { return null; }
}

function analizar(texto) {
  const crlf = /\r\n/.test(texto);
  const lineas = texto.replace(/\r\n/g, '\n').split('\n');
  const limpias = sinComentarios(lineas);
  const secciones = {};
  let actual = null;
  for (let i = 0; i < limpias.length; i++) {
    const m = /^##\s+(.*)$/.exec(limpias[i]);
    if (m && !/^###/.test(limpias[i])) {
      if (actual) actual.fin = i;
      const clave = claveSeccion(m[1]);
      const primera = clave && !secciones[clave];
      actual = { clave: primera ? clave : null, titulo: m[1].trim(), ini: i, fin: limpias.length };
      if (primera) secciones[clave] = actual;
    }
  }
  if (actual) actual.fin = limpias.length;
  const estado = (() => { const m = /ESTADO DEL CANAL:\s*\**\s*(ACTIVO|CERRADO|PAUSADO|PREPARADO)/i.exec(texto); return m ? m[1].toUpperCase() : 'ACTIVO'; })();
  const mec = /MEC[ÁA]NICA:\s*(BASE|INVERTIDA|INDIVIDUAL|POR DEFINIR)/i.exec(texto);
  return { crlf, lineas, limpias, secciones, estado, texto, mecanica: mec ? mec[1].toUpperCase() : null };
}

const esPlaceholder = (l) => /^\s*_.*_\s*$/.test(l) && !/^\s*_{2,}/.test(l);

/** Elementos de una sección: bloques `### …`; si no hay, viñetas/numeradas de primer nivel. */
function elementos(c, clave) {
  const s = c.secciones[clave];
  if (!s) return [];
  const idx = [];
  for (let i = s.ini + 1; i < s.fin; i++) if (/^###\s+/.test(c.limpias[i])) idx.push(i);
  let modo = 'h3';
  if (!idx.length) {
    modo = 'vineta';
    for (let i = s.ini + 1; i < s.fin; i++) if (/^(?:[-*]|\d+[.)])\s+\S/.test(c.limpias[i]) && !esPlaceholder(c.limpias[i])) idx.push(i);
  }
  const out = [];
  idx.forEach((ini, k) => {
    const fin = k + 1 < idx.length ? idx[k + 1] : s.fin;
    let f = fin; while (f > ini + 1 && !c.limpias[f - 1].trim()) f--;
    const lineasBloque = c.limpias.slice(ini, f);
    const crudo = c.lineas.slice(ini, f);
    const tituloCrudo = lineasBloque[0].replace(/^###\s+|^(?:[-*]|\d+[.)])\s+/, '').trim();
    const idm = /\[([A-Za-z]{1,4}-[\w.]+)\]/.exec(tituloCrudo);
    const id = idm ? idm[1] : 'H-' + sha(tituloCrudo).slice(0, 6);
    const titulo = tituloCrudo.replace(/^\[[A-Za-z]{1,4}-[\w.]+\]\s*/, '');
    const texto = lineasBloque.join('\n');
    const casillas = [...texto.matchAll(/^\s*[-*]\s*\[( |x|X)\]/gm)];
    out.push({
      id, titulo, ini, fin: f, modo, texto, crudo: crudo.join('\n'),
      casillas: { total: casillas.length, hechas: casillas.filter((m) => m[1] !== ' ').length },
      resuelto: RESUELTO.test(texto), hecho: HECHO.test(texto), aceptada: ACEPTADA.test(texto), cancelada: CANCELADA.test(texto), heredada: HEREDADA.test(texto),
      generado: !idm,
    });
  });
  return out;
}

function severidad(titulo) {
  const m = /(BLOQUEANTE|HALLAZGO|NOTA|DUDA)/i.exec(titulo);
  return m ? m[1].toUpperCase() : 'HALLAZGO';
}

/** Detalle que sigue a la marca `✅ RESUELTO` (para detectar «resuelto» sin decir qué se hizo). */
function detalleResuelto(texto) {
  let mejor = '';
  for (const m of String(texto).matchAll(/✅\s*RESUELTO[^\n]*/gi)) {
    const d = m[0].replace(/✅\s*RESUELTO/i, '').replace(/\[[^\]]*\]/g, '').replace(/^[\s—–:-]+/, '').replace(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?\s*[—–:-]?\s*/, '').trim();
    if (d.length > mejor.length) mejor = d;
  }
  return mejor;
}

const ID_TAREA = /\b(T-[\w.]+)\b/g;
const ESTADO_REPORTE = /\b(HECHO|PARCIAL|NO[_ ]HECHO|BLOQUEADO)\b/i;

/** Líneas del Reporte que hablan de una tarea → {estado, detalle, archivos, mencionada}. La más reciente (más arriba) gana. */
function reportes(c) {
  const s = c.secciones.reporte;
  const out = {};
  if (!s) return out;
  let fechaRonda = null; // hora (ms) de la última cabecera «### Ronda N — AAAA-MM-DD HH:MM» vista más arriba
  for (let i = s.ini + 1; i < s.fin; i++) {
    const l = c.limpias[i];
    if (!l.trim() || esPlaceholder(l)) continue;
    const cab = /^###\s+Ronda\s+\d+\s+—\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(l);
    if (cab) { const t = Date.parse(cab[1] + 'T' + cab[2] + ':00'); fechaRonda = Number.isNaN(t) ? null : t; continue; }
    const ids = [...l.matchAll(ID_TAREA)].map((m) => m[1]);
    if (!ids.length) continue;
    const e = ESTADO_REPORTE.exec(l);
    const arch = /Archivos?:\s*([^\n]*?)(?:\.\s*(?:Verificaci[óo]n|$)|$)/i.exec(l);
    for (const id of new Set(ids)) {
      if (out[id]) continue;
      const detalle = l.replace(/^[-*\s]+/, '').replace(/\[?T-[\w.]+\]?/, '').replace(ESTADO_REPORTE, '').replace(/^[\s:—–|-]+/, '').trim();
      out[id] = { estado: e ? e[1].toUpperCase().replace(' ', '_') : null, detalle, archivos: arch ? arch[1].split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean) : [], linea: i, at: fechaRonda };
    }
  }
  return out;
}

/** Ids de tarea aceptados por el director en su sección (o con la marca dentro del bloque de la tarea). */
function aceptadas(c) {
  const ids = new Set();
  const s = c.secciones.auditoria;
  if (s) for (let i = s.ini + 1; i < s.fin; i++) if (ACEPTADA.test(c.limpias[i])) for (const m of c.limpias[i].matchAll(ID_TAREA)) ids.add(m[1]);
  for (const t of elementos(c, 'tareas')) if (t.aceptada) ids.add(t.id);
  return ids;
}

function leer(root) {
  const texto = leerTexto(root);
  if (texto == null) return null;
  const c = analizar(texto);
  c.root = root; c.texto = texto; c.ruta = rutaCanal(root);
  return c;
}

// ───────────────────────────── escritura (lock + atómica) ───────────────────

function conLock(root, fn) {
  const lock = path.join(dirEstado(root), 'canal.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const inicio = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmdirSync(lock); continue; } } catch { /* otro lo soltó */ }
      if (Date.now() - inicio > 8000) { try { fs.rmdirSync(lock); } catch { /* sigue */ } }
      const fin = Date.now() + 40; while (Date.now() < fin) { /* espera corta */ }
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* ya soltado */ } }
}

/** En Windows un renombrado puede fallar un instante si otro proceso está leyendo el archivo: se reintenta. */
function renombrarConReintento(a, b) {
  const inicio = Date.now();
  for (;;) {
    try { fs.renameSync(a, b); return; } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || Date.now() - inicio > 5000) { try { fs.rmSync(a, { force: true }); } catch { /* sin temporal */ } throw e; }
      const fin = Date.now() + 25; while (Date.now() < fin) { /* espera corta */ }
    }
  }
}

/** Relee, aplica fn(lineasCrudas, analisis) → lineasNuevas, y guarda atómico respetando CRLF. */
function mutar(root, fn) {
  return conLock(root, () => {
    const texto = leerTexto(root);
    if (texto == null) throw Object.assign(new Error('No existe ' + path.join(DIR, ARCHIVO) + ': ejecuta `teams: activar` primero'), { code: 'SIN_CANAL' });
    const c = analizar(texto);
    const nuevas = fn(c.lineas.slice(), c);
    if (!nuevas) return false;
    const salida = nuevas.join('\n').replace(/\n/g, c.crlf ? '\r\n' : '\n');
    const f = rutaCanal(root); const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, salida);
    renombrarConReintento(tmp, f);
    guardarInstantanea(root, salida);
    return true;
  });
}

// ───────────────── instantánea: lo último que ESCRIBIÓ Agentix, para detectar escrituras pisadas ─────────────────
// Caso real (medinet, 2 veces): la tarea T-034 quedó en el estado de TEAMS pero NO en el archivo del canal — el editor del
// constructor guardó una copia vieja encima de nuestra escritura. El bloqueo de canal.lock solo protege entre procesos de Agentix.
// Cada escritura nuestra deja una copia; si después falta un bloque (tarea/corrección/decisión) que esa copia tenía, se repone.
const instantaneaPath = (root) => path.join(dirEstado(root), 'canal-ultimo.md');
function guardarInstantanea(root, texto) {
  try { fs.mkdirSync(dirEstado(root), { recursive: true }); fs.writeFileSync(instantaneaPath(root), texto); } catch { /* es una red de seguridad: sin ella todo sigue igual */ }
}
/** Un canal nuevo (activar) no hereda bloques del anterior. */
function olvidarInstantanea(root) { try { fs.rmSync(instantaneaPath(root), { force: true }); } catch { /* ya no está */ } }

/** Repone en el canal los bloques de tareas/correcciones/decisiones que la última escritura de Agentix tenía y ahora faltan. Devuelve los ids repuestos. */
function recuperarPerdidos(root) {
  const repuestos = [];
  try {
    if (!fs.existsSync(instantaneaPath(root))) return repuestos;
    const previo = analizar(fs.readFileSync(instantaneaPath(root), 'utf8').split(/\r?\n/).join('\n'));
    mutar(root, (lineas, c) => {
      const faltan = [];
      for (const clave of ['tareas', 'correcciones', 'decisiones']) {
        if (!previo.secciones[clave]) continue;
        const ids = new Set(elementos(c, clave).map((x) => x.id));
        for (const el of elementos(previo, clave)) if (!el.generado && !ids.has(el.id)) faltan.push({ clave, el });
      }
      if (!faltan.length) return null;
      const titulos = { tareas: 'Tareas para el constructor', correcciones: 'Correcciones pendientes', decisiones: 'Decisiones' };
      let L = lineas.slice();
      for (const { clave, el } of faltan) {
        L = asegurarSeccion(L, clave, titulos[clave]);
        L = quitarPlaceholder(L, clave);
        const { fin } = finDeSeccion(L, clave);
        L.splice(fin, 0, '', ...String(el.crudo).split(/\r?\n/));
        repuestos.push(el.id);
      }
      return L;
    });
  } catch { /* la recuperación nunca rompe un comando */ }
  return repuestos;
}

/** Garantiza que exista la sección (la añade al final si el canal es de una plantilla anterior). */
function asegurarSeccion(lineas, clave, titulo) {
  const c = analizar(lineas.join('\n'));
  if (c.secciones[clave]) return lineas;
  const sal = lineas.slice();
  while (sal.length && !sal[sal.length - 1].trim()) sal.pop();
  sal.push('', '## ' + titulo, '');
  return sal;
}

function finDeSeccion(lineas, clave) {
  const c = analizar(lineas.join('\n'));
  const s = c.secciones[clave];
  let f = s.fin; while (f > s.ini + 1 && !lineas[f - 1].trim()) f--;
  return { s, fin: f, c };
}

/** Primera línea de la sección fuera del comentario de plantilla (para insertar «lo más reciente arriba»). */
function inicioDeSeccion(lineas, clave) {
  const c = analizar(lineas.join('\n'));
  const s = c.secciones[clave];
  let i = s.ini + 1;
  while (i < s.fin && (!lineas[i].trim() || !c.limpias[i].trim())) i++; // blancos y comentarios de plantilla
  return { s, pos: i, c };
}

function quitarPlaceholder(lineas, clave) {
  const c = analizar(lineas.join('\n'));
  const s = c.secciones[clave];
  if (!s) return lineas;
  const sal = lineas.slice();
  for (let i = s.fin - 1; i > s.ini; i--) if (esPlaceholder(c.limpias[i]) && c.limpias[i].trim()) sal.splice(i, 1);
  return sal;
}

function anadirAlFinal(root, clave, tituloSiFalta, bloque) {
  return mutar(root, (lineas) => {
    let L = asegurarSeccion(lineas, clave, tituloSiFalta);
    L = quitarPlaceholder(L, clave);
    const { fin } = finDeSeccion(L, clave);
    L.splice(fin, 0, '', ...bloque);
    return L;
  });
}

function anadirArriba(root, clave, tituloSiFalta, bloque) {
  return mutar(root, (lineas) => {
    let L = asegurarSeccion(lineas, clave, tituloSiFalta);
    L = quitarPlaceholder(L, clave);
    const { pos } = inicioDeSeccion(L, clave);
    L.splice(pos, 0, ...bloque, '');
    return L;
  });
}

/** Añade una línea al final del bloque de un elemento (por id). */
function anadirLineaAlElemento(root, clave, id, linea) {
  let hallado = false;
  mutar(root, (lineas, c) => {
    const el = elementos(c, clave).find((e) => e.id === id);
    if (!el) return null;
    hallado = true;
    lineas.splice(el.fin, 0, linea);
    return lineas;
  });
  return hallado;
}

/** Siguiente id con prefijo (T-, C-, D-): el mayor número visto en TODO el archivo + 1. */
function siguienteId(texto, prefijo) {
  let max = 0;
  for (const m of texto.matchAll(new RegExp('\\b' + prefijo + '-(\\d+)\\b', 'g'))) max = Math.max(max, Number(m[1]));
  return prefijo + '-' + String(max + 1).padStart(3, '0');
}

// ───────────────────────────── cabecera / estado del canal ──────────────────

function fijarEstado(root, estado, nota) {
  return mutar(root, (lineas) => {
    const marca = '**ESTADO DEL CANAL: ' + estado + '**' + (nota ? ' — ' + nota : '');
    const i = lineas.findIndex((l) => /ESTADO DEL CANAL:/i.test(l));
    if (i >= 0) { if (lineas[i] === marca) return null; lineas[i] = marca; return lineas; }
    // tras el título (primera línea `# `) y su línea en blanco
    const t = lineas.findIndex((l) => /^#\s+/.test(l));
    lineas.splice(t >= 0 ? t + 1 : 0, 0, '', marca);
    return lineas;
  });
}

// ───────────────────────────── lint ─────────────────────────────────────────

const ESPERA_AUDITORIA = /\b(espera(?:r)?(?:\s+a\s+que)?|no\s+(?:avances?|sigas?|empieces?|contin[uú]es?)\s+(?:hasta|sin))\b[^.\n]{0,60}\b(termine|se\s+audite|auditor[ií]a|aprobaci[oó]n|auditen|verifique|revise)/i;
/** Frases que convierten la auditoría en un freno. Solo avisa: la decisión es del Director (y un BLOQUEANTE real es válido). */
function lintTexto(texto) {
  const avisos = [];
  for (const l of String(texto).split(/\r?\n/)) if (ESPERA_AUDITORIA.test(l)) avisos.push('«' + l.trim().slice(0, 100) + '» parece hacer esperar a la auditoría: la auditoría NUNCA gatea el avance (solo un BLOQUEANTE real: datos, seguridad, producción)');
  return avisos;
}

module.exports = {
  DIR, ARCHIVO, rutaCanal, dirEstado, norm, sha, sello, leer, analizar, elementos, severidad, detalleResuelto, reportes, aceptadas,
  mutar, conLock, recuperarPerdidos, olvidarInstantanea, guardarInstantanea, renombrarConReintento, anadirAlFinal, anadirArriba, anadirLineaAlElemento, siguienteId, fijarEstado, lintTexto,
  RESUELTO, HECHO, ACEPTADA, CANCELADA, esPlaceholder,
  __asegurar: asegurarSeccion, __quitarPlaceholder: quitarPlaceholder, __finSeccion: (l, k) => finDeSeccion(l, k).fin, __inicioSeccion: (l, k) => inicioDeSeccion(l, k).pos,
};
