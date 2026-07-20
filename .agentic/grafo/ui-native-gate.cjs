'use strict';

/**
 * UI Native Gate — verificación mecánica de "nunca usar elementos nativos
 * del navegador sin estilizar" (Feature 4 de la sesión del 14/07/2026).
 *
 * Lumo ya tiene esta regla registrada en patrones.md con confianza ALTA
 * ("Nunca usar diálogos nativos del navegador — confirm/alert/prompt"),
 * aplicada una vez, útil una vez. Pero esa regla depende de que el LLM la
 * lea y la recuerde CADA VEZ que construye algo nuevo — el mismo punto
 * débil que "romper el silencio" (Feature 1) ataca para el paralelismo.
 * Este gate es el equivalente mecánico para UI: un chequeo determinístico
 * (grep de patrones prohibidos) que no depende de que nadie se acuerde.
 *
 * Solo cubre lo que Lumo YA tiene resuelto con un reemplazo real y
 * verificado (confirmAction/promptAction/showToast en public/panel/js/core.js)
 * — no se inventan reglas para componentes que todavía no existen (ej. un
 * "select estilizado" que Lumo no tiene construido). Agregar una regla
 * nueva es agregar una entrada a NATIVE_RULES, nada más — pensado para
 * crecer cuando aparezca el próximo "esto lo hicimos bien una vez y la
 * próxima vez se hizo por defecto otra vez".
 *
 * NOTA al portar a otro proyecto: los mensajes de NATIVE_RULES referencian
 * los wrappers reales de Lumo (core.js). Si este archivo se usa como
 * plantilla para un proyecto sin ese archivo, actualizar los mensajes al
 * wrapper real de ESE proyecto — la detección (confirm/alert/prompt
 * nativos) sigue siendo válida igual, solo el "usar X en vez de" cambia.
 *
 * Uso:
 *   node .agentic/grafo/ui-native-gate.cjs archivo1.js archivo2.js ...
 */

const fs = require('fs');
const path = require('path');

const MAX_SCAN_BYTES = 2_000_000;

// Cada regla: un patrón nativo prohibido + el reemplazo real que ya existe
// en el proyecto (no un reemplazo hipotético). "excepto" filtra los propios
// archivos donde el reemplazo se define (core.js define confirmAction
// llamando confirm() como fallback legítimo si el <dialog> no existe en el DOM).
const NATIVE_RULES = [
  {
    id: 'NATIVE_CONFIRM',
    pattern: /(?<!\.)\bconfirm\s*\(/,
    mensaje: 'confirm() nativo del navegador — usar confirmAction({title, message, confirmLabel, danger}) de core.js',
    exceptoArchivo: /core\.js$/,
  },
  {
    id: 'NATIVE_ALERT',
    pattern: /(?<!\.)\balert\s*\(/,
    mensaje: 'alert() nativo del navegador — usar showToast(msg, type) de core.js',
    exceptoArchivo: /core\.js$/,
  },
  {
    id: 'NATIVE_PROMPT',
    pattern: /(?<!\.)\bprompt\s*\(/,
    mensaje: 'prompt() nativo del navegador — usar promptAction({title, label, defaultValue}) de core.js',
    exceptoArchivo: /core\.js$/,
  },
];

const EXTENSIONES_RELEVANTES = /\.(js|jsx|ts|tsx|html)$/i;

function safeRead(full) {
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return null;
    return fs.readFileSync(full, 'utf8');
  } catch { return null; }
}

function escanearArchivo(content, filename) {
  const findings = [];
  const lineas = content.split('\n');
  for (const regla of NATIVE_RULES) {
    if (regla.exceptoArchivo && regla.exceptoArchivo.test(filename)) continue;
    lineas.forEach((linea, i) => {
      // Saltar líneas de comentario (// o *) — un comentario que MENCIONA
      // alert()/confirm() no es un uso real (falso positivo encontrado en el
      // Coliseo, 2026-07-20: la línea "// esto usa alert() a propósito" se
      // marcaba igual que la llamada real de abajo).
      const t = linea.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      if (regla.pattern.test(linea)) {
        findings.push({
          id: regla.id,
          severity: 'HIGH',
          file: filename,
          line: i + 1,
          mensaje: regla.mensaje,
          muestra: linea.trim().slice(0, 100),
        });
      }
    });
  }
  return findings;
}

function runUiNativeGate(files, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const allFindings = [];
  const scanned = [];

  (files || []).forEach(file => {
    if (!EXTENSIONES_RELEVANTES.test(file)) return;
    const full = path.isAbsolute(file) ? file : path.join(projectRoot, file);
    const content = safeRead(full);
    if (content == null) return;
    scanned.push(file);
    allFindings.push(...escanearArchivo(content, file));
  });

  // Telemetría (Plan 5, T1) — fail-soft total: sin BD o sin módulo, el gate sigue igual
  try {
    const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
    if (allFindings.length && fs.existsSync(dbPath)) {
      const gt = require(path.join(__dirname, 'gate-telemetry.cjs'));
      let db; try { db = new (require('better-sqlite3'))(dbPath); } catch { db = new (require('node:sqlite').DatabaseSync)(dbPath); }
      allFindings.forEach(f => gt.recordGateEvent(db, { gate: 'ui_native', verdict: 'WARN', file: f.file, detalle: { id: f.id, line: f.line } }));
      try { db.close(); } catch {}
    }
  } catch { /* nunca bloquea */ }

  if (allFindings.length === 0) {
    return {
      passed: true,
      scanned,
      message: `UI NATIVE GATE PASS — ${scanned.length} archivo(s) escaneado(s), sin elementos nativos sin estilizar`,
    };
  }

  return {
    passed: false,
    warn: true,
    findings: allFindings,
    scanned,
    message: `UI NATIVE GATE WARN: ${allFindings.length} uso(s) de elemento nativo del navegador:\n` +
      allFindings.map(f => `  🟡 [${f.id}] ${f.file}:${f.line} — ${f.mensaje}\n      → ${f.muestra}`).join('\n'),
  };
}

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.log('Uso: node ui-native-gate.cjs archivo1.js archivo2.js ...');
    console.log('Escanea uso de confirm()/alert()/prompt() nativos en vez de los wrappers estilizados de core.js.');
    process.exit(0);
  }
  const result = runUiNativeGate(files, process.cwd());
  console.log(result.passed ? '✅ ' + result.message : '⚠️  ' + result.message);
  process.exit(0); // WARN, no STOP — no bloquea el pipeline, solo avisa (igual que Security Gate en HIGH)
}

module.exports = { runUiNativeGate, NATIVE_RULES };
