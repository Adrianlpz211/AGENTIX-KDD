'use strict';
/**
 * Privacidad antes de persistir (C01 — "Privacidad antes de persistir").
 *
 * Todo lo que va a la base, a la cola, a la caché, al contexto entregado, a SSE,
 * a un log o a una exportación pasa primero por aquí. Cuatro clases:
 *
 *   authorized   contenido permitido y sin hallazgos            → se guarda tal cual
 *   redacted     se encontró algo sensible y se tapó            → se guarda lo tapado
 *   private      ruta/campo denegado o excluido explícitamente  → solo metadatos permitidos
 *   unknown      no se puede clasificar (binario, ilegible)     → solo metadatos
 *
 * Diseño (y por qué):
 *   · FALLA CERRADO. El redactor de telemetría devolvía el texto íntegro si algo
 *     fallaba (y context-pack.cjs hacía lo mismo en su `catch`). Aquí, si la
 *     redacción lanza, el resultado es '[REDACCION_FALLIDA]', nunca el original.
 *   · Las expresiones regulares NO garantizan detectar todo. Por eso existen la
 *     política por proyecto (rutas y campos denegados, exclusiones explícitas) y
 *     la clase `private`: lo que no debe guardarse no depende de que una regex lo
 *     reconozca.
 *   · Nunca se guarda un hash de un secreto como sustituto de redactarlo: un hash
 *     de un valor de baja entropía se invierte probando candidatos.
 *   · La política vive en `.agentic/privacy-policy.json` (opcional) y solo su
 *     `policy_id` viaja en la evidencia, no su contenido.
 *   · Dos niveles de redacción: `secrets` (siempre) y `pii` (correo/teléfono, solo
 *     para resúmenes: aplicarlo a un log de pruebas destruiría fechas y cifras).
 *
 * Esto NO es un DLP completo: reduce el riesgo, no lo elimina, y lo dice.
 */

const fs = require('fs');
const path = require('path');

const REDACTION_VERSION = 'r1';
const MARCA = '[REDACTADO]';
const FALLO = '[REDACCION_FALLIDA]';

const PATRONES_SECRETOS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
];

/* Pares clave=valor / clave: valor cuyo VALOR se tapa (la clave se conserva). */
const CLAVES_SENSIBLES = '(?:password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|private[_-]?key|authorization|cookie|set-cookie|session[_-]?id|credential|connection[_-]?string|dsn)';
const RE_JSON_CLAVE = new RegExp('("' + CLAVES_SENSIBLES + '"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"', 'gi');
/* Asignación con literal entre comillas: es un secreto escrito a mano en texto o en código. */
const RE_ASIGNACION_COMILLAS = new RegExp('(\\b[\\w.-]*' + CLAVES_SENSIBLES + '[\\w.-]*\\s*[:=]\\s*)(?:"[^"\\n]{4,}"|\'[^\'\\n]{4,}\')', 'gi');
/* Valor sin comillas (logs, .env, cabeceras): NO se tapa si es una llamada (`token = require('x')`),
   porque eso destruiría código legítimo. Solo aplica en modo 'texto'. */
const RE_ASIGNACION_PLANA = new RegExp('(\\b[\\w.-]*' + CLAVES_SENSIBLES + '[\\w.-]*\\s*[:=]\\s*)(?![A-Za-z_$][\\w$.]*\\()[^\\s,;&"\']+', 'gi');
const EXT_CODIGO = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|cs|php|swift|c|h|cc|cpp|hpp|vue|svelte|sh|ps1)$/i;
const RE_CABECERA = /^(\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*).+$/gim;
const RE_ENV = /^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|DSN)[A-Z0-9_]*\s*=\s*).+$/gm;

const PATRON_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PATRON_TELEFONO = /(?<![\d.:-])\+?\d[\d\s().-]{8,}\d(?![\d:-])/g;

/* Rutas que NUNCA se guardan con contenido (clase private). */
const RUTAS_DENEGADAS = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /(^|\/)(secrets?|credentials?)(\.[^/]*)?$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.ssh\//i,
];
const CAMPOS_DENEGADOS_BASE = ['password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'authorization', 'cookie', 'private_key', 'client_secret'];

const normRuta = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');

function globARegex(g) {
  const s = normRuta(g).replace(/[.+^${}()|[\]]/g, (c) => '\\' + c).replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp('(^|/)' + s + '$', 'i');
}

// ─────────────────────────── política por proyecto ──────────────────────────
function politicaDefault() {
  return { policy_id: 'default-r1', deny_paths: [], deny_fields: [], exclude: [], extra_patterns: [], redact_pii_in_summaries: true };
}

/** Lee `.agentic/privacy-policy.json`. Una política ilegible NO relaja nada: se cae a la más estricta (default + aviso). */
function cargarPolitica(root) {
  const base = politicaDefault();
  let crudo;
  try { crudo = fs.readFileSync(path.join(root || process.cwd(), '.agentic', 'privacy-policy.json'), 'utf8'); } catch { return { ...base, origen: 'default' }; }
  try {
    const j = JSON.parse(crudo);
    const lista = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 200) : []);
    const extra = [];
    for (const p of lista(j.extra_patterns)) { try { extra.push(new RegExp(p, 'g')); } catch { /* patrón inválido: se ignora y se avisa abajo */ } }
    return {
      policy_id: String(j.policy_id || 'custom').slice(0, 64),
      deny_paths: lista(j.deny_paths), deny_fields: lista(j.deny_fields), exclude: lista(j.exclude),
      extra_patterns: extra, extra_patterns_declarados: lista(j.extra_patterns).length,
      redact_pii_in_summaries: j.redact_pii_in_summaries !== false,
      origen: 'archivo',
    };
  } catch (e) {
    return { ...base, origen: 'default', aviso: 'privacy-policy.json ilegible (' + e.message + '): se aplica la política por defecto' };
  }
}

function regexDeRutas(politica) {
  return RUTAS_DENEGADAS.concat((politica.deny_paths || []).concat(politica.exclude || []).map(globARegex));
}

// ─────────────────────────── redacción ──────────────────────────────────────
/**
 * Tapa secretos. Devuelve { text, redactions }.
 * Falla CERRADO: ante una excepción el resultado es FALLO, jamás el original.
 */
function redactarSecretos(texto, politica, { modo = 'texto' } = {}) {
  try {
    let t = String(texto == null ? '' : texto);
    let n = 0;
    const cuenta = (re, rep) => { t = t.replace(re, (...a) => { n++; return typeof rep === 'function' ? rep(...a) : rep; }); };
    for (const p of PATRONES_SECRETOS) cuenta(p, MARCA);
    for (const p of (politica && politica.extra_patterns) || []) cuenta(p, MARCA);
    cuenta(RE_JSON_CLAVE, (m, pre) => pre + '"' + MARCA + '"');
    cuenta(RE_CABECERA, (m, pre) => pre + MARCA);
    cuenta(RE_ENV, (m, pre) => pre + MARCA);
    cuenta(RE_ASIGNACION_COMILLAS, (m, pre) => pre + '"' + MARCA + '"');
    // En código fuente, un valor sin comillas es casi siempre una expresión (identificador, acceso, llamada):
    // taparlo rompería lo que se va a editar. Los secretos literales ya los cubre el patrón con comillas.
    if (modo !== 'codigo') cuenta(RE_ASIGNACION_PLANA, (m, pre) => pre + MARCA);
    return { text: t, redactions: n, ok: true };
  } catch (e) {
    return { text: FALLO, redactions: 0, ok: false, error: e && e.message };
  }
}

function redactarPII(texto) {
  try {
    return String(texto == null ? '' : texto).replace(PATRON_EMAIL, '[EMAIL]').replace(PATRON_TELEFONO, '[TELEFONO]');
  } catch { return FALLO; }
}

/** Atajo compatible con telemetry.redactar: secretos + PII (para resúmenes). */
function redactar(texto, politica) {
  const r = redactarSecretos(texto, politica);
  return r.ok ? redactarPII(r.text) : FALLO;
}

/** Redacta un valor arbitrario: cadenas, y recursivamente objetos/arreglos (claves sensibles se tapan por nombre). */
function sanitizarValor(valor, politica, profundidad = 0) {
  if (profundidad > 8) return '[PROFUNDIDAD_EXCEDIDA]';
  if (valor == null || typeof valor === 'number' || typeof valor === 'boolean') return valor;
  if (typeof valor === 'string') { const r = redactarSecretos(valor, politica); return r.text; }
  if (Array.isArray(valor)) return valor.slice(0, 200).map((v) => sanitizarValor(v, politica, profundidad + 1));
  if (typeof valor === 'object') {
    const campos = new Set(CAMPOS_DENEGADOS_BASE.concat((politica && politica.deny_fields) || []).map((c) => c.toLowerCase()));
    const out = {};
    for (const [k, v] of Object.entries(valor).slice(0, 200)) {
      out[k] = campos.has(k.toLowerCase()) || new RegExp(CLAVES_SENSIBLES, 'i').test(k) ? MARCA : sanitizarValor(v, politica, profundidad + 1);
    }
    return out;
  }
  return '[TIPO_NO_SOPORTADO]';
}

// ─────────────────────────── clasificación ──────────────────────────────────
/**
 * Clasifica y prepara un contenido para persistir.
 *   entrada: { text|bytes, path?, field?, kind? }
 *   salida : { privacy_class, text, redactions, policy_id, redaction_version, motivo? }
 * Para `private`/`unknown` NO hay texto: ni payload ni vista previa.
 */
function prepararParaPersistir(entrada, politica) {
  const pol = politica || politicaDefault();
  const base = { policy_id: pol.policy_id, redaction_version: REDACTION_VERSION };
  const ruta = normRuta(entrada && entrada.path);
  if (ruta && regexDeRutas(pol).some((re) => re.test(ruta))) return { ...base, privacy_class: 'private', text: null, redactions: 0, motivo: 'RUTA_DENEGADA' };
  const campo = String((entrada && entrada.field) || '').toLowerCase();
  if (campo && CAMPOS_DENEGADOS_BASE.concat(pol.deny_fields || []).map((c) => c.toLowerCase()).includes(campo)) return { ...base, privacy_class: 'private', text: null, redactions: 0, motivo: 'CAMPO_DENEGADO' };

  let texto;
  if (entrada && Buffer.isBuffer(entrada.bytes)) {
    if (entrada.bytes.includes(0)) return { ...base, privacy_class: 'unknown', text: null, redactions: 0, motivo: 'BINARIO' };
    texto = entrada.bytes.toString('utf8');
  } else {
    // Convertir a texto también puede lanzar (objeto hostil): falla cerrado, no se propaga ni se devuelve nada.
    try { texto = String(entrada && entrada.text != null ? entrada.text : ''); } catch { return { ...base, privacy_class: 'unknown', text: null, redactions: 0, motivo: 'REDACCION_FALLIDA' }; }
  }

  // Modo explícito o deducido de la extensión: el código fuente no se trata como un log.
  const modo = (entrada && entrada.modo) || (ruta && EXT_CODIGO.test(ruta) ? 'codigo' : 'texto');
  const r = redactarSecretos(texto, pol, { modo });
  if (!r.ok) return { ...base, privacy_class: 'unknown', text: null, redactions: 0, motivo: 'REDACCION_FALLIDA' };
  return { ...base, privacy_class: r.redactions > 0 ? 'redacted' : 'authorized', text: r.text, redactions: r.redactions, mode: modo };
}

/** Resumen corto y seguro de un valor (para input_summary/output_summary): secretos + PII, acotado. */
function resumenSeguro(valor, { max = 600, politica } = {}) {
  const pol = politica || politicaDefault();
  let t;
  try { t = typeof valor === 'string' ? valor : JSON.stringify(sanitizarValor(valor, pol)); } catch { return FALLO; }
  const r = redactarSecretos(t == null ? '' : t, pol);
  if (!r.ok) return FALLO;
  const sinPII = pol.redact_pii_in_summaries === false ? r.text : redactarPII(r.text);
  const limpio = sinPII.replace(/\s+/g, ' ').trim();
  return limpio.length > max ? limpio.slice(0, max - 1) + '…' : limpio;
}

/** ¿Esta ruta debe excluirse de TODO (contexto, evidencia, embeddings)? */
function rutaPrivada(root, ruta) {
  return regexDeRutas(cargarPolitica(root)).some((re) => re.test(normRuta(ruta)));
}

module.exports = {
  REDACTION_VERSION, MARCA, FALLO,
  politicaDefault, cargarPolitica, redactarSecretos, redactarPII, redactar, sanitizarValor,
  prepararParaPersistir, resumenSeguro, rutaPrivada, normRuta,
};
