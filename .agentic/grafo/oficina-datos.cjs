'use strict';
/**
 * Datos de la «Oficina» del tablero (la agencia 3D). Solo lectura.
 *
 * La oficina vive con CUALQUIER forma de trabajo, no solo con TEAMS:
 *   · TEAMS completo (Director + Constructor) o individual → `teams.cjs salud` (si el proyecto lo trae y hay canal).
 *   · Un solo modelo trabajando con `aa:` (solo Claude Code o solo Cursor) → las marcas de `linea-tiempo` (`--actor=<quién eres>`):
 *     quien tiene una tarea abierta con la sesión corriendo está trabajando AHORA.
 * Nada aquí escribe, ni adivina: si no hay marca, no hay actividad que mostrar.
 */
const fs = require('fs');
const path = require('path');

const MARCA = ['.agentic', '_tarea_en_curso.json'];
const VIGENCIA_MS = 6 * 60 * 60 * 1000;   // una sesión «abierta» hace más de 6 h es una marca olvidada, no trabajo en curso

function actividad(root, ahora = Date.now()) {
  const out = { actores: [], generado: new Date(ahora).toISOString() };
  let m = null;
  try { m = JSON.parse(fs.readFileSync(path.join(root, ...MARCA), 'utf8')); } catch { return out; }
  const actores = m && m.actores ? m.actores : (m && m.abierta ? { default: { abierta: m.abierta } } : {});
  for (const [actor, p] of Object.entries(actores)) {
    const t = p && p.abierta; if (!t) continue;
    const ss = t.sesiones || []; const ult = ss[ss.length - 1];
    const desde = ult && ult.inicio ? Date.parse(ult.inicio) : NaN;
    const activa = !!(ult && !ult.fin && Number.isFinite(desde) && (ahora - desde) < VIGENCIA_MS);
    out.actores.push({ actor: String(actor).slice(0, 40), tarea: String(t.tarea || '').replace(/\s+/g, ' ').slice(0, 90), activa, desde_seg: Number.isFinite(desde) ? Math.max(0, Math.round((ahora - desde) / 1000)) : null });
  }
  return out;
}

function leer(root) {
  let teams = null, instalado = false;
  try {
    const f = path.join(root, '.agentic', 'grafo', 'teams.cjs');
    if (fs.existsSync(f)) { instalado = true; teams = require(f).salud(root) || null; }
  } catch { /* sin TEAMS: la oficina sigue viva con la actividad de aa: */ }
  return { teams, teams_instalado: instalado, actividad: actividad(root) };
}

module.exports = { leer, actividad };
