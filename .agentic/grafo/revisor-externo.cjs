#!/usr/bin/env node
/**
 * Agentic KDD — Revisor externo (opcional, opt-in por riesgo)
 *
 * Nunca es requisito general ni se llama en tareas menores. Configuración en
 * .agentic/revisor-externo.json:
 *   { "enabled": true, "provider": "...", "model": "...", "min_tier": "HIGH",
 *     "timeout_ms": 120000, "budget_usd": 1, "required_for_close": false,
 *     "credential_env": "NOMBRE_DE_LA_VARIABLE" }
 *
 * Este módulo decide SI aplica y QUÉ significa su ausencia; no llama a ningún
 * proveedor. Sin configuración, sin proveedor o sin credencial → la revisión
 * es UNVERIFIED (REVISION_EXTERNA_NO_DISPONIBLE), nunca un PASS inventado.
 * `required_for_close` decide si la tarea puede cerrar sin ella.
 *
 * El snapshot que vería un revisor es inmutable (hash por archivo) y pasa por
 * el redactor de secretos. Una discrepancia de alto riesgo se registra; no se
 * resuelve sola.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ORDEN = ['LOW', 'MEDIUM', 'HIGH'];
const ARCHIVO = path.join('.agentic', 'revisor-externo.json');

function config(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, ARCHIVO), 'utf8')); } catch { return null; }
}

/** ¿Aplica a esta decisión del router? */
function aplica(root, decision) {
  const c = config(root);
  if (!c || c.enabled !== true) return { aplica: false, motivo: 'NO_CONFIGURADO' };
  const min = ORDEN.includes(c.min_tier) ? c.min_tier : 'HIGH';
  if (ORDEN.indexOf(decision.tier) < ORDEN.indexOf(min)) return { aplica: false, motivo: 'TIER_MENOR', min_tier: min };
  return { aplica: true, config: c };
}

/** Estado de la revisión para el cierre. Sin revisor real → no disponible. */
function estado(root, decision, resultado) {
  const a = aplica(root, decision);
  if (!a.aplica) return { status: 'SKIP', reason_code: a.motivo, puede_cerrar: true };
  const c = a.config;
  const puedeSin = c.required_for_close !== true;
  if (!c.provider || !c.model) return { status: 'UNVERIFIED', reason_code: 'REVISION_EXTERNA_NO_DISPONIBLE', detalle: 'sin proveedor/modelo configurado', puede_cerrar: puedeSin };
  if (!c.credential_env || !process.env[c.credential_env]) return { status: 'UNVERIFIED', reason_code: 'REVISION_EXTERNA_NO_DISPONIBLE', detalle: 'sin credencial en el entorno', puede_cerrar: puedeSin };
  if (!resultado) return { status: 'UNVERIFIED', reason_code: 'REVISION_EXTERNA_PENDIENTE', puede_cerrar: puedeSin };
  if (resultado.veredicto === 'PASS') return { status: 'PASS', puede_cerrar: true, ref: resultado.ref || null };
  return { status: 'FAIL', reason_code: 'DISCREPANCIA_REVISOR', detalle: resultado.resumen || null, puede_cerrar: false, nota: 'se registra para decisión humana; no se resuelve sola' };
}

/** Snapshot de solo lectura: contenido redactado + hash de cada archivo. */
function snapshot(root, archivos) {
  let redactar = (t) => t;
  try { redactar = require('./telemetry.cjs').redactar; } catch { /* sin redactor no hay snapshot */ return { ok: false, reason_code: 'SIN_REDACTOR' }; }
  const items = [];
  for (const rel of archivos || []) {
    let txt; try { txt = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    items.push({ path: rel.replace(/\\/g, '/'), sha256: crypto.createHash('sha256').update(txt).digest('hex'), contenido: redactar(txt) });
  }
  return Object.freeze({ ok: true, items: Object.freeze(items.map(Object.freeze)), hash: crypto.createHash('sha256').update(JSON.stringify(items.map((i) => [i.path, i.sha256]))).digest('hex') });
}

module.exports = { aplica, estado, snapshot, config, ARCHIVO };
