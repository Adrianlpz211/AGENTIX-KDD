'use strict';

/**
 * El identificador del ciclo en curso, uno por actor.
 *
 * Todo lo que pasa durante un ciclo (gates, STOP, recall, pasos) lleva este
 * id. Sin él, "los STOP de este ciclo" solo se podía deducir por fechas, y un
 * ciclo heredaba los frenos del anterior o perdía los suyos.
 *
 * Lo abre el context-enricher al empezar y lo cierra el post-cycle al
 * registrar el ciclo. `AKDD_CYCLE_ID` en el entorno manda sobre el archivo.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARCHIVO = path.join('.agentic', '_ciclo_actual.json');

function actor() {
  return (process.env.AKDD_ACTOR || 'default').trim() || 'default';
}

function leer(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, ARCHIVO), 'utf8')) || {}; }
  catch { return {}; }
}

function escribir(root, datos) {
  const ruta = path.join(root, ARCHIVO);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const tmp = ruta + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 2));
  fs.renameSync(tmp, ruta);
}

function iniciar(root, opciones) {
  const o = opciones || {};
  const quien = o.actor || actor();
  const datos = leer(root);
  const ciclo = {
    cycle_id: o.cycle_id || crypto.randomUUID(),
    started_at: new Date().toISOString(),
    tarea: String(o.tarea || '').slice(0, 160),
    actor: quien,
  };
  datos[quien] = ciclo;
  escribir(root, datos);
  return ciclo;
}

function actual(root, opciones) {
  if (process.env.AKDD_CYCLE_ID) return { cycle_id: process.env.AKDD_CYCLE_ID, actor: actor(), origen: 'env' };
  const quien = (opciones && opciones.actor) || actor();
  const c = leer(root || process.cwd())[quien];
  return c && c.cycle_id ? Object.assign({ origen: 'archivo' }, c) : null;
}

function cerrar(root, opciones) {
  const quien = (opciones && opciones.actor) || actor();
  const datos = leer(root);
  const c = datos[quien] || null;
  if (c) {
    delete datos[quien];
    escribir(root, datos);
  }
  return c;
}

module.exports = { iniciar, actual, cerrar, ARCHIVO };
