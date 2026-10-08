#!/usr/bin/env node
'use strict';
/**
 * TEAMS que no se duerme: qué hacer cuando el host de un rol (Claude Code = Director, Cursor = constructor) va a PARAR.
 *
 * El problema medido en medinet: el vigilante (proceso en segundo plano) termina al emitir un aviso y el modelo debe relanzarlo
 * antes de trabajar; si su turno acaba antes de relanzarlo, los dos roles quedan dormidos y solo el dueño los despierta. Un proceso
 * no puede escribir en el chat de otro, pero el host SÍ ofrece un gancho de parada:
 *   · Claude Code  Stop      → {"decision":"block","reason":"…"}   (el modelo sigue trabajando con ese texto)
 *   · Cursor       stop      → {"followup_message":"…"}            (Cursor envía ese mensaje como nuevo turno)
 *
 * Se pide continuar SOLO si es el rol de ESE host, el canal está ACTIVO y además:
 *   (a) hay trabajo del canal sin atender para ese rol, o
 *   (b) su vigilante no está vivo (nadie lo despertará cuando llegue algo).
 * Nunca con el canal PAUSADO, CERRADO o PREPARADO (el protocolo mandó parar), ni cuando no queda nada accionable y el vigilante
 * vive (por ejemplo «solo faltan decisiones del dueño»: ahí parar es lo correcto).
 * Y con freno propio: tras 3 continuaciones seguidas sin que cambie nada en 15 min deja de insistir y lo anota (DORMIDO), para no
 * quemar tokens en un bucle; el dueño lo ve en el semáforo.
 *
 * Opt-out: AKDD_NO_TEAMS_STOP=1.
 */
const fs = require('fs');
const path = require('path');

const VENTANA_MS = 15 * 60 * 1000;
const MAX_SEGUIDAS = 3;
const ROL_RECIENTE_MS = 6 * 3600 * 1000; // el host solo cuenta como «ese rol» si el rol hizo una ronda en las últimas 6 h

const rolDe = (host) => (host === 'cursor' ? 'builder' : 'director');
const archivo = (root) => path.join(root, '.agentic', '_teams', 'continuidad.json');

function leer(root) { try { return JSON.parse(fs.readFileSync(archivo(root), 'utf8')); } catch { return {}; } }
function guardar(root, d) { try { fs.mkdirSync(path.dirname(archivo(root)), { recursive: true }); fs.writeFileSync(archivo(root), JSON.stringify(d, null, 2)); } catch { /* sin disco: sin freno persistente */ } }

/** → { continuar, motivo, mensaje?, detalle? } */
function decidir(root, host, entrada, opts = {}) {
  const no = (motivo, detalle) => ({ continuar: false, motivo, detalle });
  try {
    if (process.env.AKDD_NO_TEAMS_STOP === '1') return no('APAGADO');
    if (!fs.existsSync(path.join(root, '.legion', 'AUDITORIA-CURSOR.md'))) return no('SIN_CANAL');
    // Claude ya está continuando por un gancho de parada: otra vuelta seguida sería un bucle.
    if (host === 'claude' && entrada && entrada.stop_hook_active) return no('YA_CONTINUANDO');
    if (host === 'cursor' && entrada && Number(entrada.loop_count) >= 2) return no('YA_CONTINUANDO');
    const T = require('./teams.cjs');
    const e = T.calcular(root, { sinRecuperar: true });
    if (!e || e.canal !== 'ACTIVO') return no('CANAL_' + (e ? e.canal : 'NULO'));
    const est = T.leerEstado(root);
    const individual = est.modo === 'individual';
    const rol = rolDe(host);
    // ¿este host está haciendo de ese rol? (si no, es otra conversación cualquiera y no se le obliga a nada)
    const ahora = opts.ahora || Date.now();
    const ult = (est.rondas || {})[rol] || 0;
    if (!(ahora - ult < ROL_RECIENTE_MS) && !opts.forzarRol) return no('NO_ES_ESTE_ROL');
    const roles = individual && host === 'claude' ? ['director', 'builder'] : [rol];
    const razones = []; let pendiente = false;
    for (const r of roles) {
      const a = T.accionable(e, r);
      if (a.digest && a.digest !== (est.seen || {})[r]) { pendiente = true; for (const x of a.razones.slice(0, 5)) razones.push(x); }
    }
    const sinVigilante = roles.some((r) => !T.leerVigilante(root, r).vivo);
    if (!pendiente && !sinVigilante) return no('NADA_QUE_HACER');

    // freno anti-bucle
    const d = leer(root); const huella = JSON.stringify([razones, sinVigilante]);
    const reg = d[rol] || { n: 0, desde: ahora, huella: '' };
    if (reg.huella !== huella || ahora - reg.desde > VENTANA_MS) { reg.n = 0; reg.desde = ahora; reg.huella = huella; reg.dormido = false; }
    if (reg.n >= MAX_SEGUIDAS) {
      if (!reg.dormido) { reg.dormido = true; d[rol] = reg; guardar(root, d); try { T.registrarEvento(root, { rol: 'sistema', cmd: 'DORMIDO', objetivo: rol + ': ' + MAX_SEGUIDAS + ' continuaciones sin cambio' }); } catch { /* auxiliar */ } try { require('./ntfy-bridge.cjs').enviar && require('./ntfy-bridge.cjs').enviar('TEAMS: ' + (rol === 'builder' ? 'Cursor' : 'Claude Code') + ' se detuvo con trabajo pendiente tras ' + MAX_SEGUIDAS + ' intentos de reanudarlo. Escríbele en su chat: teams: continuar'); } catch { /* sin teléfono */ } }
      return no('FRENO_ANTIBUCLE', 'dormido: ' + razones.slice(0, 2).join(' | '));
    }
    reg.n += 1; d[rol] = reg; guardar(root, d);

    const CMD = require('./teams-prompts.cjs').CMD;
    const nombre = rol === 'builder' ? 'CONSTRUCTOR' : 'DIRECTOR';
    const partes = ['[TEAMS] No termines todavía: eres el ' + nombre + ' y el canal sigue ACTIVO.'];
    if (pendiente) partes.push('Hay trabajo sin atender: ' + razones.join(' · ') + '.');
    if (sinVigilante) partes.push('Tu vigilante NO está vivo: relánzalo ahora, como tarea en segundo plano, ANTES de seguir (' + CMD + ' esperar --rol=' + rol + ' --despertar' + (host === 'claude' ? ' --continuo con la herramienta Monitor' : '') + '); sin él nadie te despierta cuando llegue algo.');
    partes.push(pendiente ? 'Después corre `' + CMD + ' ' + (rol === 'builder' ? 'ronda --rol=builder' : 'revisar') + '` y trabaja lo que imprima.' : 'Con el vigilante vivo ya puedes terminar el turno.');
    return { continuar: true, motivo: pendiente ? 'TRABAJO_PENDIENTE' : 'SIN_VIGILANTE', mensaje: partes.join(' ') };
  } catch (err) { return no('ERROR', String(err && err.message || err).slice(0, 120)); }
}

/** Salida en el formato de cada host (null = dejar parar sin decir nada). */
function salidaParaHost(host, r) {
  if (!r || !r.continuar) return null;
  return host === 'cursor' ? { followup_message: r.mensaje } : { decision: 'block', reason: r.mensaje };
}

module.exports = { decidir, salidaParaHost, rolDe, MAX_SEGUIDAS, VENTANA_MS };
