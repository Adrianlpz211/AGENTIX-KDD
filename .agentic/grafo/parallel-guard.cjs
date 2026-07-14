#!/usr/bin/env node
'use strict';

/**
 * Agentic KDD — Parallel Guard ("romper el silencio")
 *
 * CLAUDE.md instruye invocar la herramienta de sub-agentes DOS VECES EN EL
 * MISMO MENSAJE cuando Front+Back son paralelizables (MODO LEGIÓN). Eso es
 * texto que el modelo puede o no seguir — no hay garantía mecánica. Hasta
 * ahora, si el modelo lo hacía secuencial en vez de paralelo, el ciclo
 * "funcionaba" igual (más lento) y nadie se enteraba: post-cycle.cjs
 * registraba el ciclo como COMPLETADO sin distinguir un caso del otro.
 *
 * Este módulo NO puede forzar que el modelo invoque en paralelo — eso solo
 * puede pasar desde dentro del turno del propio asistente. Lo que SÍ puede
 * hacer, con datos reales: leer el transcript de la sesión (que Claude Code
 * ya escribe a disco en .jsonl) y verificar mecánicamente si el paralelismo
 * prometido ocurrió de verdad.
 *
 * La señal es estructural, no una suposición de timing: cuando el modelo
 * invoca 2 sub-agentes de VERDAD en paralelo, ambas invocaciones (bloques
 * tool_use) aparecen dentro del MISMO mensaje de "assistant" (mismo
 * timestamp, mismo array message.content). Si lo hizo secuencial, aparecen
 * en DOS mensajes de assistant distintos (con un tool_result del primero en
 * medio, porque así funciona el protocolo). Verificado contra el transcript
 * real de este proyecto (05ad3b4b-...jsonl): en TODO su historial, cero
 * casos de 2+ agentes en el mismo mensaje — siempre secuencial pese a la
 * instrucción de CLAUDE.md.
 *
 * Uso:
 *   node .agentic/grafo/parallel-guard.cjs check [--window-minutes=30]
 *
 * Devuelve uno de tres veredictos, nunca asume éxito por defecto:
 *   CONFIRMADO   — se encontró un mensaje con 2+ agentes simultáneos
 *   NO_CONFIRMADO — hubo invocaciones de agente en la ventana, pero ninguna
 *                   coincidió en el mismo mensaje (fue secuencial)
 *   SIN_EVIDENCIA — no se encontró ninguna invocación de agente en la ventana
 *                   (no se puede verificar nada, ni a favor ni en contra)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const AGENT_TOOL_NAMES = new Set(['Task', 'Agent']);

/**
 * Encuentra el .jsonl de transcript más reciente para este proyecto, bajo
 * ~/.claude/projects/<ruta-codificada>/. La ruta se codifica reemplazando
 * separadores de carpeta y ":" por "-" (mismo esquema que usa Claude Code).
 */
function encontrarTranscriptMasReciente(projectRoot) {
  const home = os.homedir();
  const encoded = projectRoot.replace(/[/\\:]/g, '-');
  const dir = path.join(home, '.claude', 'projects', encoded);
  if (!fs.existsSync(dir)) return null;

  let mejor = null;
  let mejorMtime = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    if (stat.isFile() && stat.mtimeMs > mejorMtime) {
      mejor = full;
      mejorMtime = stat.mtimeMs;
    }
  }
  return mejor;
}

/**
 * Recorre el transcript y agrupa las invocaciones de agente por mensaje
 * (mismo timestamp = mismo mensaje = paralelismo real si hay 2+).
 * Solo considera mensajes dentro de los últimos `windowMinutes`.
 */
async function analizarTranscript(transcriptPath, windowMinutes) {
  const corte = Date.now() - windowMinutes * 60 * 1000;
  const mensajesConAgentes = []; // { timestamp, count }

  const rl = readline.createInterface({
    input: fs.createReadStream(transcriptPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'assistant' || !obj.message || !Array.isArray(obj.message.content)) continue;

    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < corte) continue;

    const agentes = obj.message.content.filter(
      b => b.type === 'tool_use' && AGENT_TOOL_NAMES.has(b.name)
    );
    if (agentes.length > 0) {
      mensajesConAgentes.push({ timestamp: obj.timestamp, count: agentes.length });
    }
  }

  return mensajesConAgentes;
}

/**
 * Verifica si el paralelismo prometido ocurrió de verdad en los últimos
 * `windowMinutes` minutos de la sesión activa de este proyecto.
 */
async function checkParallelDispatch(projectRoot, { windowMinutes = 30 } = {}) {
  const transcriptPath = encontrarTranscriptMasReciente(projectRoot);
  if (!transcriptPath) {
    return { verdicto: 'SIN_EVIDENCIA', razon: 'No se encontró ningún transcript de sesión para este proyecto.' };
  }

  const mensajes = await analizarTranscript(transcriptPath, windowMinutes);
  if (mensajes.length === 0) {
    return {
      verdicto: 'SIN_EVIDENCIA',
      razon: `Sin invocaciones de agente en los últimos ${windowMinutes} min — no se puede verificar nada.`,
      transcript: transcriptPath,
    };
  }

  const simultaneos = mensajes.filter(m => m.count >= 2);
  if (simultaneos.length > 0) {
    return {
      verdicto: 'CONFIRMADO',
      razon: `${simultaneos.length} mensaje(s) con 2+ agentes invocados a la vez — paralelismo real confirmado.`,
      detalle: simultaneos,
      transcript: transcriptPath,
    };
  }

  const totalAgentes = mensajes.reduce((a, m) => a + m.count, 0);
  return {
    verdicto: 'NO_CONFIRMADO',
    razon: `${totalAgentes} invocación(es) de agente en ${mensajes.length} mensaje(s) DISTINTOS — se ejecutaron secuencial, no en paralelo, aunque se esperaba paralelismo.`,
    detalle: mensajes,
    transcript: transcriptPath,
  };
}

function formatearVeredicto(v) {
  const iconos = { CONFIRMADO: '✅', NO_CONFIRMADO: '⚠️ ', SIN_EVIDENCIA: '❔' };
  const lineas = [
    '',
    `${iconos[v.verdicto] || '?'} PARALLEL GUARD — ${v.verdicto}`,
    v.razon,
  ];
  if (v.transcript) lineas.push(`Transcript: ${v.transcript}`);
  return lineas.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const windowArg = args.find(a => a.startsWith('--window-minutes='));
  const windowMinutes = windowArg ? parseInt(windowArg.split('=')[1]) : 30;

  if (cmd !== 'check') {
    console.log('Uso: node parallel-guard.cjs check [--window-minutes=30]');
    process.exit(1);
  }

  checkParallelDispatch(process.cwd(), { windowMinutes }).then(v => {
    console.log(formatearVeredicto(v));
    process.exit(v.verdicto === 'NO_CONFIRMADO' ? 1 : 0);
  });
}

module.exports = { checkParallelDispatch, formatearVeredicto, encontrarTranscriptMasReciente };
