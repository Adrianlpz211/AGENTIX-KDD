'use strict';

/**
 * Estado de una capacidad (C08), con un vocabulario único para hooks, TEAMS,
 * WhatsApp y restore:
 *
 *   NOT_INSTALLED → INSTALLED → CONFIGURED → AVAILABLE → VERIFIED
 *                                         ↘ DEGRADED (algo concreto falla)
 *
 * VERIFIED exige una verificación VIGENTE con scope host o e2e: ligada al
 * hash del módulo, al de su config/deps, al host y su versión, y a un
 * execution_id. Un mock (scope fixture) nunca sube de AVAILABLE. Cambiar el
 * cuerpo o la config invalida la verificación. Repetir el mismo execution_id
 * no cuenta dos veces. Un id o un hash declarados por quien construyó no son
 * una firma: el que verifica es quien ejecuta (el director/runner).
 */

const crypto = require('crypto');
const fs = require('fs');

const ORDEN_SCOPE = { fixture: 1, host: 2, e2e: 3 };
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

function hashArchivos(files) {
  const partes = [];
  for (const f of files) { try { partes.push([f.replace(/\\/g, '/').split('/').pop(), sha(fs.readFileSync(f))]); } catch { partes.push([f, 'AUSENTE']); } }
  return sha(JSON.stringify(partes)).slice(0, 16);
}

/**
 * @param c { instalado, configurado, disponible, degradado: [motivos], verificaciones: [{scope, execution_id, hash_modulo, hash_config, host, version, at}] }
 * @param actual { hash_modulo, hash_config, host, version }
 */
function evaluar(c = {}, actual = {}) {
  const vistos = new Set();
  const vigentes = [];
  const invalidadas = [];
  for (const v of c.verificaciones || []) {
    if (!v || !v.execution_id) { invalidadas.push({ v, motivo: 'SIN_EXECUTION_ID' }); continue; }
    if (vistos.has(v.execution_id)) continue;
    vistos.add(v.execution_id);
    const motivos = [];
    if (actual.hash_modulo && v.hash_modulo !== actual.hash_modulo) motivos.push('MODULO_CAMBIO');
    if (actual.hash_config && v.hash_config !== actual.hash_config) motivos.push('CONFIG_CAMBIO');
    if (actual.host && v.host && v.host !== actual.host) motivos.push('OTRO_HOST');
    if (actual.version && v.version && v.version !== actual.version) motivos.push('VERSION_HOST_CAMBIO');
    if (!ORDEN_SCOPE[v.scope]) motivos.push('SCOPE_DESCONOCIDO');
    if (motivos.length) invalidadas.push({ execution_id: v.execution_id, scope: v.scope, motivo: motivos.join('+') });
    else vigentes.push(v);
  }
  const mejor = vigentes.reduce((m, v) => (!m || ORDEN_SCOPE[v.scope] > ORDEN_SCOPE[m.scope] ? v : m), null);
  let estado;
  if (!c.instalado) estado = 'NOT_INSTALLED';
  else if (!c.configurado) estado = 'INSTALLED';
  else if (!c.disponible) estado = 'CONFIGURED';
  else if ((c.degradado || []).length) estado = 'DEGRADED';
  else if (mejor && ORDEN_SCOPE[mejor.scope] >= ORDEN_SCOPE.host) estado = 'VERIFIED';
  else estado = 'AVAILABLE';
  return {
    estado,
    verification_scope: mejor ? mejor.scope : null,
    verificaciones_vigentes: vigentes.length,
    invalidadas,
    degradado: c.degradado || [],
    nota: estado === 'AVAILABLE' && mejor && mejor.scope === 'fixture' ? 'probado en fixture; falta la prueba en el host real' : null,
  };
}

module.exports = { evaluar, hashArchivos, ORDEN_SCOPE };
