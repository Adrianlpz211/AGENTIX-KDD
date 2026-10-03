'use strict';

/**
 * Vigencia de lo recordado (P14). Recordar un patrón no demuestra que siga
 * aplicando: esto dice, para una entrada y el contexto de la tarea, si se
 * aplica, si hay que validarla antes, o si no corresponde — y por qué.
 *
 *   · recomendación, hecho observado y regla de negocio se distinguen
 *   · otro stack/framework → VALIDAR, nunca se aplica directo
 *   · sujeto distinto al que se probó → el PASS viejo no vale (VALIDAR)
 *   · otro proyecto o tenant → NO (no se filtra contexto ajeno)
 *   · protegido (contrato, regla, criticidad alta) → la edad no lo desactiva:
 *     sigue exigible; el decay solo ordena
 *   · confiable nunca sustituye ejecutar: `sustituye_ejecucion` siempre false
 *
 * Los metadatos salen de columnas existentes y de líneas `clave: valor` del
 * contenido (stack, subject_hash, scenario_id, contract_id, fuente,
 * criticidad, clase, protegido, project_id, tenant). Sin migrar la base.
 */

const CLAVES = ['stack', 'framework', 'subject_hash', 'scenario_id', 'contract_id', 'fuente', 'criticidad', 'clase', 'protegido', 'project_id', 'tenant'];
const TIPOS_PROTEGIDOS = new Set(['contrato', 'regla', 'regla_negocio', 'spec']);
const TIPOS_REGLA = new Set(['regla', 'regla_negocio', 'spec']);
const TIPOS_HECHO = new Set(['error', 'contrato', 'observacion', 'hecho', 'bug']);

function metadatos(fila) {
  const m = {};
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?(${CLAVES.join('|')})\\s*:\\s*(.+?)\\s*$`, 'gim');
  let x;
  const txt = String((fila && fila.contenido) || '');
  while ((x = re.exec(txt))) if (!(x[1].toLowerCase() in m)) m[x[1].toLowerCase()] = x[2];
  for (const k of CLAVES) if (fila && fila[k] != null && fila[k] !== '') m[k] = String(fila[k]);
  if (!m.stack && m.framework) m.stack = m.framework;
  return m;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+#.]/g, '');

function esProtegido(fila, m = metadatos(fila)) {
  return TIPOS_PROTEGIDOS.has(String(fila.tipo || '').toLowerCase())
    || /^(si|sí|true|1)$/i.test(m.protegido || '')
    || /^(alta|critica|crítica|critical|high)$/i.test(m.criticidad || '');
}

function claseDe(fila, m = metadatos(fila)) {
  const c = norm(m.clase);
  if (/regla|negocio/.test(c)) return 'REGLA_NEGOCIO';
  if (/hecho|observ/.test(c)) return 'HECHO_OBSERVADO';
  if (/recom|patron/.test(c)) return 'RECOMENDACION';
  const t = String(fila.tipo || '').toLowerCase();
  if (TIPOS_REGLA.has(t)) return 'REGLA_NEGOCIO';
  if (TIPOS_HECHO.has(t) || m.subject_hash || /ejecuci|test|gate/i.test(m.fuente || '')) return 'HECHO_OBSERVADO';
  return 'RECOMENDACION';
}

/**
 * @param fila     fila de `nodos` (o un objeto con tipo/contenido/vigencia_tipo)
 * @param contexto { stack, subject_hash, project_id, tenant }
 * @returns { aplicable: SI|VALIDAR|NO, clase, protegido, exigible, motivos, incertidumbre, fuente, sustituye_ejecucion }
 */
function evaluar(fila, contexto = {}) {
  const m = metadatos(fila);
  const clase = claseDe(fila, m);
  const protegido = esProtegido(fila, m);
  const motivos = [];
  let aplicable = 'SI';
  const bajar = (a) => { if (a === 'NO' || (a === 'VALIDAR' && aplicable === 'SI')) aplicable = a; };

  if (m.project_id && contexto.project_id && m.project_id !== contexto.project_id) { motivos.push('OTRO_PROYECTO'); bajar('NO'); }
  if (m.tenant && contexto.tenant && m.tenant !== contexto.tenant) { motivos.push('OTRO_TENANT'); bajar('NO'); }
  if (m.stack && contexto.stack && norm(m.stack) !== norm(contexto.stack)) { motivos.push('OTRO_STACK'); bajar('VALIDAR'); }
  if (clase === 'HECHO_OBSERVADO' && m.subject_hash && contexto.subject_hash && m.subject_hash !== contexto.subject_hash) { motivos.push('SUJETO_CAMBIO'); bajar('VALIDAR'); }
  const vig = String(fila.vigencia_tipo || '').toUpperCase();
  if (vig === 'SOSPECHOSO') { motivos.push('SOSPECHOSO'); bajar('VALIDAR'); }
  if (vig === 'OBSOLETO' || String(fila.estado || '').toUpperCase() === 'OBSOLETO') {
    if (protegido) { motivos.push('EDAD_NO_DESACTIVA_PROTEGIDO'); bajar('VALIDAR'); } else { motivos.push('OBSOLETO'); bajar('NO'); }
  }

  const incertidumbre = [];
  if (!m.fuente) incertidumbre.push('SIN_FUENTE');
  if (!m.stack && clase === 'RECOMENDACION') incertidumbre.push('SIN_STACK');
  if (clase === 'HECHO_OBSERVADO' && !m.subject_hash) incertidumbre.push('SIN_SUJETO_PROBADO');

  return {
    aplicable, clase, protegido, exigible: protegido, motivos, incertidumbre,
    fuente: m.fuente || null, stack: m.stack || null, scenario_id: m.scenario_id || null, contract_id: m.contract_id || null,
    sustituye_ejecucion: false,
  };
}

/** La edad nunca desactiva lo protegido: como mucho lo deja para validar. */
const edadPuedeDesactivar = (fila) => !esProtegido(fila);

module.exports = { evaluar, metadatos, esProtegido, claseDe, edadPuedeDesactivar, CLAVES };
