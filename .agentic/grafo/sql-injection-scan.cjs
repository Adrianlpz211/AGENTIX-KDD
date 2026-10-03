'use strict';

/**
 * SQL armado pegando datos — el A03 de OWASP.
 *
 * EL HUECO QUE CIERRA
 * -------------------
 * El security-gate revisaba secretos, fugas entre inquilinos y bypass de JWT.
 * Sobre inyección SQL tenía CERO comprobaciones — medido el 05/09/2026, en un
 * ecosistema de proyectos escritos con SQL crudo. Es el riesgo más cercano y el
 * que menos habilidad requiere para explotar: basta escribir en un buscador.
 *
 *     `SELECT * FROM paciente WHERE nombre = '${req.query.q}'`
 *
 * Alguien teclea «' OR 1=1--» y ve la ficha de TODOS los pacientes. O peor:
 * «'; DROP TABLE paciente--».
 *
 * POR QUÉ AVISA Y NUNCA BLOQUEA
 * -----------------------------
 * Esto es una HEURÍSTICA. Una llave privada en el código ES una llave privada, y
 * por eso el gate bloquea con eso. Pero interpolar en SQL puede ser legítimo, y
 * un bloqueo falso es lo único de lo que un control así no se recupera: se
 * desactiva, y con él se pierden los deterministas que sí funcionaban.
 *
 * Regla de la casa: **determinista puede frenar, heurístico solo avisa.**
 *
 * LAS DOS VECES QUE ESTA HEURÍSTICA ESTUVO MAL
 * --------------------------------------------
 * Se anotan porque explican cada decisión de abajo:
 *
 * 1 · Buscaba NOMBRES de variable (`nombre`, `filtro`, `valor`). Sobre el código
 *     real de salud360 dio **48 falsos positivos en 40 archivos**, todos por
 *     `WHERE ${where}` — donde `where` es un fragmento que el propio código
 *     compone con parámetros y ata con `.input(...)`. Código correcto, acusado.
 *     → Ahora se exige un CAMINO de petición (`req.`, `body.`), no un nombre.
 *     → Y se mira si el archivo parametriza: quien tiene ese hábito, al
 *       interpolar está componiendo SQL propio, no pegando datos de nadie.
 *
 * 2 · Miraba una ventana de cuatro líneas alrededor de la consulta. Sobre los
 *     propios módulos de Agentix dio **57 falsos positivos**: acusaba plantillas
 *     que no eran SQL solo por estar cerca de una (`${s.kind}:${s.symbol_name}`),
 *     y no reconocía el estilo `?` de node:sqlite como parametrización.
 *     → Ahora las interpolaciones se buscan DENTRO de la plantilla que contiene
 *       el SQL, y el estilo `?` cuenta como parametrizar.
 *
 * Resultado medido: 0 hallazgos en 183 archivos de salud360 y en los 76 módulos
 * de Agentix, sin perder ninguno de los agujeros de verdad.
 *
 *   node .agentic/grafo/sql-injection-scan.cjs src/a.ts src/b.js
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;

/* Se exige un VERBO y una CLÁUSULA, para no marcar prosa que diga "from". */
const VERBO_SQL = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/i;
const CLAUSULA_SQL = /\b(FROM|WHERE|SET|VALUES|JOIN|ORDER\s+BY|GROUP\s+BY|HAVING)\b/i;

/**
 * Un dato de FUERA, alcanzado por su camino.
 * Se exige el punto: `req.query.q` sí; una variable llamada `nombre` que quizá
 * los tiene, no. Ver el fallo nº1 de la cabecera.
 */
const CAMINO_DE_USUARIO =
  /\b(req|request|ctx|event)\s*\.|(?:^|[^\w.])(body|params|searchParams|formData|queryParams)\s*[.[]|\.\s*(?:get|getAll)\s*\(\s*["'`]/i;

/* Lo que se interpola y no viene de fuera: constantes en MAYÚSCULAS, números,
   literales de cadena, y la lista de interrogantes de una consulta preparada. */
const INTERPOLACION_INOCUA =
  /^(\s*[A-Z][A-Z0-9_]{2,}\s*|\s*\d+\s*|\s*'[^']*'\s*|\s*"[^"]*"\s*|\s*['"]\?['"]\s*)$/;

/* Señales de parametrización dentro de la propia consulta. */
const PARECE_PARAMETRIZADA = /(@[a-zA-Z_]\w*|\$\d+|\?\s*[,)\]]|:[a-zA-Z_]\w*\s*[,)\]])/;

const ES_CODIGO = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|php|go|java|cs)$/i;

/* Los tests declaran SQL malo a propósito para comprobar que se detecta. */
const ES_TEST = /(^|[\\/])(test|tests|spec|__tests__|e2e|fixtures?)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$/i;

const recortar = (s) => String(s || '').trim().slice(0, 110);

/**
 * ¿Este archivo tiene el hábito de parametrizar?
 *
 * La distinción que salva las falsas alarmas. Un archivo que ata sus datos con
 * `.input(...)`, `@parametros` o interrogantes está haciéndolo bien: cuando
 * además interpola, lo que interpola es SQL que él mismo compuso —un `WHERE`
 * armado por partes, un `ORDER BY`, la lista de interrogantes de un `IN`— no el
 * dato de nadie.
 *
 * En un archivo que NUNCA parametriza, la misma interpolación sí es el agujero:
 * no hay ninguna otra vía por la que el dato pudiera estar pasando seguro.
 */
function parametriza(contenido) {
  return /\.\s*input\s*\(|\baddParameter\s*\(|\bbindAll\s*\(/.test(contenido)
    || /@[a-zA-Z_]\w*\s*(?:,|\)|\s|$)/.test(contenido)
    || /\$\d+\s*[,)\]]/.test(contenido)
    /* Estilo `?` — el de node:sqlite y better-sqlite3. No reconocerlo fue el
       fallo nº2: los propios módulos de Agentix disparaban 57 falsas alarmas. */
    || /map\s*\(\s*\(\s*\)\s*=>\s*['"]\?['"]\s*\)/.test(contenido)
    || /\(\s*\?\s*[,)]/.test(contenido)
    || /=\s*\?|\bIN\s*\(\s*\?/i.test(contenido);
}

/** En qué línea (1-indexada) cae una posición del texto. */
const lineaEn = (texto, pos) => texto.slice(0, pos).split(/\r?\n/).length;

const ES_ALMOHADILLA = /\.(py|rb)$/i;

/**
 * Los comentarios pasan a espacios (los saltos de línea se conservan, así las
 * posiciones y los números de línea no se mueven). Se recorre el texto con sus
 * cadenas y expresiones regulares: un `//` dentro de una cadena no es un
 * comentario, y un ejemplo de SQL malo dentro de un comentario no es código.
 */
function sinComentarios(contenido, archivo) {
  const s = String(contenido);
  const out = s.split('');
  const almohadilla = ES_ALMOHADILLA.test(String(archivo || ''));
  const borrar = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  let i = 0;
  let previo = '';
  while (i < s.length) {
    const c = s[i];
    const d = s[i + 1];
    if (almohadilla && c === '#') {
      const fin = s.indexOf('\n', i);
      const hasta = fin === -1 ? s.length : fin;
      borrar(i, hasta); i = hasta; continue;
    }
    if (!almohadilla && c === '/' && d === '/') {
      const fin = s.indexOf('\n', i);
      const hasta = fin === -1 ? s.length : fin;
      borrar(i, hasta); i = hasta; continue;
    }
    if (!almohadilla && c === '/' && d === '*') {
      const fin = s.indexOf('*/', i + 2);
      const hasta = fin === -1 ? s.length : fin + 2;
      borrar(i, hasta); i = hasta; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < s.length && s[j] !== c) {
        if (s[j] === '\\') j++;
        else if (c !== '`' && s[j] === '\n') break;
        j++;
      }
      i = j + 1; previo = c; continue;
    }
    if (!almohadilla && c === '/' && (previo === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(previo))) {
      let j = i + 1;
      let clase = false;
      while (j < s.length && s[j] !== '\n') {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '[') clase = true;
        else if (s[j] === ']') clase = false;
        else if (s[j] === '/' && !clase) break;
        j++;
      }
      i = j + 1; previo = '/'; continue;
    }
    if (!/\s/.test(c)) previo = c;
    i++;
  }
  return out.join('');
}

/**
 * Nombres locales que llevan un dato de la petición: `const q = req.query.q`,
 * `const { q } = req.body`, y las copias de esos (`const f = q.trim()`).
 * Es flujo local por nombre dentro del mismo archivo, no un análisis completo.
 */
function nombresContaminados(codigo) {
  const sucios = new Set();
  const tocaSucio = (expr) => CAMINO_DE_USUARIO.test(expr)
    || [...sucios].some((n) => new RegExp('(^|[^\\w$.])' + n.replace(/\$/g, '\\$') + '\\b').test(expr));
  for (let vuelta = 0; vuelta < 3; vuelta++) {
    const antes = sucios.size;
    for (const m of codigo.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
      if (tocaSucio(m[2])) sucios.add(m[1]);
    }
    for (const m of codigo.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*([^;\n]+)/g)) {
      if (!tocaSucio(m[2])) continue;
      for (const parte of m[1].split(',')) {
        const p = parte.split('=')[0].trim();
        const nombre = (p.includes(':') ? p.split(':')[1] : p).replace(/^\.\.\./, '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(nombre)) sucios.add(nombre);
      }
    }
    if (sucios.size === antes) break;
  }
  return sucios;
}

const raizDe = (expr) => (String(expr).trim().match(/^([A-Za-z_$][\w$]*)/) || [])[1] || null;

/**
 * Encuentra las consultas que se arman pegando datos.
 * @returns [{type, severity, message, line, sample, file}]
 */
function escanear(contenido, archivo) {
  const hallazgos = [];
  if (!contenido || contenido.length > MAX_BYTES) return hallazgos;
  if (contenido.indexOf('\0') !== -1) return hallazgos;   // binario

  const original = contenido;
  const lineas = original.split(/\r?\n/);
  contenido = sinComentarios(original, archivo);
  const tieneHabito = parametriza(contenido);
  const sucios = nombresContaminados(contenido);

  /* Un aviso por expresión: sin esto, una consulta multilínea con la misma
     variable repetida produce varios avisos del mismo agujero. */
  const yaAvisado = new Set();

  /* ── 1 · plantillas que SON una consulta ────────────────────────────────────
     Se delimita por la propia plantilla, no por líneas de alrededor: eso es lo
     que evitaba acusar a `${s.kind}:${s.symbol_name}` por estar cerca. */
  for (const pl of contenido.matchAll(/`(?:[^`\\]|\\[\s\S])*`/g)) {
    const texto = pl[0];
    if (!VERBO_SQL.test(texto) || !CLAUSULA_SQL.test(texto)) continue;

    for (const m of texto.matchAll(/\$\{([^}]{1,120})\}/g)) {
      const dentro = m[1].trim();
      if (INTERPOLACION_INOCUA.test(dentro)) continue;

      const alias = sucios.has(raizDe(dentro)) ? raizDe(dentro) : null;
      const deUsuario = CAMINO_DE_USUARIO.test(dentro) || !!alias;

      /* Se avisa en dos casos, y solo en dos:
           a) lo interpolado alcanza el dato de fuera por su camino — es un
              agujero, da igual lo bien escrito que esté el resto;
           b) el archivo no parametriza en ningún sitio. */
      if (!deUsuario && tieneHabito) continue;
      if (!deUsuario && PARECE_PARAMETRIZADA.test(texto)) continue;

      const clave = 'interp:' + dentro;
      if (yaAvisado.has(clave)) continue;
      yaAvisado.add(clave);

      const linea = lineaEn(contenido, pl.index + m.index);
      hallazgos.push({
        type: 'SQL_INTERPOLADO',
        severity: 'HIGH',
        message: deUsuario
          ? 'SQL armado con `' + dentro.slice(0, 40) + '`, que viene de la petición' +
            (alias && !CAMINO_DE_USUARIO.test(dentro) ? ' (a través de `' + alias + '`)' : '') + '. ' +
            "Escribir «' OR 1=1--» en ese campo devolvería TODAS las filas. Usar parámetros."
          : 'SQL armado por interpolación con `' + dentro.slice(0, 40) + '`, y este ' +
            'archivo no parametriza en ningún sitio. Si ese valor puede venir de ' +
            'fuera, es una inyección.',
        line: linea,
        sample: recortar(lineas[linea - 1]),
        file: archivo,
      });
    }
  }

  /* ── 2 · concatenación con + sobre una cadena que es SQL ────────────────────
     No se exime a los archivos que parametrizan: sumar cadenas para armar un
     WHERE es la forma clásica del agujero y no tiene versión buena. */
  const reConcat = /["'][^"'\n]*\b(?:WHERE|VALUES|SET|FROM)\b[^"'\n]*["']\s*\+\s*([A-Za-z_$][\w.$]{0,60})/gi;
  for (const m of contenido.matchAll(reConcat)) {
    const expr = m[1];
    if (INTERPOLACION_INOCUA.test(expr)) continue;
    const clave = 'concat:' + expr;
    if (yaAvisado.has(clave)) continue;
    yaAvisado.add(clave);

    const linea = lineaEn(contenido, m.index);
    hallazgos.push({
      type: 'SQL_CONCATENADO',
      severity: 'HIGH',
      message: 'SQL armado sumando cadenas con `' + expr + '`. ' +
        'Es la forma clásica de la inyección — usar parámetros.',
      line: linea,
      sample: recortar(lineas[linea - 1]),
      file: archivo,
    });
  }

  hallazgos.sort((a, b) => a.line - b.line);
  return hallazgos;
}

/** Los archivos del lote que merece la pena mirar. */
const filtrarArchivos = (archivos) =>
  (archivos || []).filter((f) => ES_CODIGO.test(f) && !ES_TEST.test(f));

function escanearArchivos(archivos, raiz) {
  raiz = raiz || process.cwd();
  const out = [];
  for (const rel of filtrarArchivos(archivos)) {
    const abs = path.isAbsolute(rel) ? rel : path.join(raiz, rel);
    let txt = null;
    try { txt = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    out.push(...escanear(txt, rel));
  }
  return out;
}

/**
 * Igual que escanearArchivos, pero dice qué NO pudo mirar. Un archivo ilegible,
 * binario o demasiado grande queda UNKNOWN: no revisado no es limpio.
 * Cobertura: plantillas y concatenación con SQL, y alias locales del dato de la
 * petición. No es un SAST completo: no sigue el dato entre funciones ni archivos.
 */
function escanearConCobertura(archivos, raiz) {
  raiz = raiz || process.cwd();
  const findings = [];
  const unknown = [];
  const revisados = [];
  for (const rel of filtrarArchivos(archivos)) {
    const abs = path.isAbsolute(rel) ? rel : path.join(raiz, rel);
    let txt;
    try { txt = fs.readFileSync(abs, 'utf8'); } catch (e) { unknown.push({ file: rel, reason: 'ILEGIBLE' }); continue; }
    if (txt.length > MAX_BYTES) { unknown.push({ file: rel, reason: 'DEMASIADO_GRANDE' }); continue; }
    if (txt.indexOf('\0') !== -1) { unknown.push({ file: rel, reason: 'BINARIO' }); continue; }
    revisados.push(rel);
    findings.push(...escanear(txt, rel));
  }
  const status = findings.length ? 'WARN' : (unknown.length ? 'UNVERIFIED' : 'PASS');
  return { status, findings, unknown, revisados, cobertura: COBERTURA };
}

const COBERTURA = 'plantillas y concatenación con SQL; alias locales del dato de la petición; sin flujo entre funciones ni archivos';

function formatear(hallazgos) {
  if (!hallazgos.length) {
    return '✅ SQL INJECTION SCAN — ninguna consulta armada pegando datos.';
  }
  const L = ['⚠️  SQL INJECTION SCAN — ' + hallazgos.length +
             ' consulta(s) armada(s) pegando datos:'];
  for (const h of hallazgos.slice(0, 15)) {
    L.push('  · ' + h.file + ':' + h.line + ' — ' + h.message);
    if (h.sample) L.push('      ' + h.sample);
  }
  if (hallazgos.length > 15) L.push('  … y ' + (hallazgos.length - 15) + ' más.');
  L.push('');
  L.push('  Solo avisa, nunca frena: es una heurística, y un bloqueo falso');
  L.push('  hace que se desactive el control entero. Revisa y decide.');
  return L.join('\n');
}

if (require.main === module) {
  const archivos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!archivos.length) {
    console.log('Uso: node sql-injection-scan.cjs <archivo> [archivo...]');
    process.exit(0);
  }
  console.log(formatear(escanearArchivos(archivos, process.cwd())));
  process.exit(0);   // WARN-only, siempre
}

module.exports = {
  escanear, escanearArchivos, escanearConCobertura, formatear, filtrarArchivos, parametriza,
  sinComentarios, nombresContaminados, COBERTURA,
  VERBO_SQL, CLAUSULA_SQL, CAMINO_DE_USUARIO, INTERPOLACION_INOCUA,
};
