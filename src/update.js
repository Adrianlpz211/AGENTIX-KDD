'use strict';

const fs = require('fs-extra');
const path = require('path');

/**
 * akdd update (3.20.1) — punto de entrada.
 *
 * La lógica vive en módulos separados para no concentrarla aquí:
 *   update-run.js       orquestación y máquina de estados (PREPARADO … CONFIRMADO)
 *   update-classify.js  clasificación de archivos con base verificable
 *   update-backup.js    respaldo SQLite coherente y retención
 *   update-verify.js    verificación funcional sobre una copia aislada
 *   update-tx.js        journal de archivos (revertir sin pisar ediciones externas)
 *   .agentic/grafo/{schema-catalog,memory-inventory,update-guard}.cjs   (motor)
 *
 * opciones de update():
 *   ref        rama, tag o SHA; se resuelve a un commit y se descarga ESE commit
 *   archivo    .tar.gz local (sin red, o una release propia)
 *   sha256     si se da, el archivo debe coincidir o no se toca nada
 *   check      inspección y plan SIN modificar nada
 *   json       salida estructurada (un único documento JSON en stdout)
 *   migrate    compatible: pedir expresamente comprobar/aplicar migraciones (ya es el comportamiento por defecto)
 *   noMigrate  no migrar el esquema: el resultado NUNCA se presenta como actualización completa
 *   deps       reconstruir dependencias nativas (nunca automático)
 *   salir      false = devolver el resultado en vez de process.exit (pruebas)
 *
 * Estados: VERIFIED · VERIFIED_WITH_WARNINGS · NO_CHANGES_VERIFIED · BLOCKED ·
 *          ROLLED_BACK · RECOVERY_REQUIRED · UNVERIFIED. Salida 0 solo si es verificable.
 */
async function update(opts = {}) {
  return require('./update-run').run(opts);
}

/**
 * Rollback posterior: revierte los ARCHIVOS de la última actualización aplicada y
 * conserva la memoria (nunca restaura una base antigua). Ver update-run.rollbackUltima.
 */
function rollback(opts = {}) {
  return require('./update-run').rollbackUltima(opts);
}

// ── preserveUserState ────────────────────────────────────────────────────────
// Lee el estado actual del usuario antes del update para restaurarlo después

function preserveUserState(projectPath, configPath) {
  const state = {
    configured:  false,
    name:        null,
    description: null,
    stack:       null,
    testCommand: null,
    rawSections: {},  // Secciones del usuario que no son del sistema
  };

  if (!fs.existsSync(configPath)) return state;

  try {
    const config = fs.readFileSync(configPath, 'utf8');

    // CONFIGURADO
    state.configured = /^CONFIGURADO:\s*SI/m.test(config);

    // Nombre del proyecto
    const nameMatch = config.match(/^Nombre:\s*(.+)$/m);
    if (nameMatch) state.name = nameMatch[1].trim();

    // Descripción
    const descMatch = config.match(/^Descripción:\s*([\s\S]+?)(?=\n##|\n[A-Z])/m);
    if (descMatch) state.description = descMatch[1].trim();

    // Stack completo (bloque ## Stack hasta el siguiente ##)
    const stackMatch = config.match(/^## Stack\n([\s\S]+?)(?=\n##|$)/m);
    if (stackMatch) state.stack = stackMatch[1].trim();

    // Test command — [^\S\n]* y no \s*: \s* cruzaba el salto de línea y con
    // config.md en formato YAML de bloque capturaba la línea siguiente (2026-07-19).
    const testMatch = config.match(/^[^\S\n]*test:[^\S\n]*(\S.*)$/m) || config.match(/^[^\S\n]*comando:[^\S\n]*(\S.*)$/m);
    if (testMatch && testMatch[1].trim() !== '—') {
      state.testCommand = testMatch[1].trim();
    }

    // Secciones de módulos y reglas del proyecto (todo lo que va después de ## Reglas)
    const userSections = config.match(/^## (Reglas del proyecto|Módulos|Archivos compartidos|Sinónimos)([\s\S]+?)(?=\n##|$)/gm) || [];
    for (const section of userSections) {
      const titleMatch = section.match(/^## (.+)/);
      if (titleMatch) state.rawSections[titleMatch[1]] = section;
    }

  } catch(e) { /* best-effort */ }

  return state;
}

// ── restoreUserState ─────────────────────────────────────────────────────────
// Restaura el estado del usuario en config.md después del update

function restoreUserState(configPath, state) {
  if (!fs.existsSync(configPath)) return;

  try {
    let config = fs.readFileSync(configPath, 'utf8');
    let changed = false;

    // Restaurar CONFIGURADO: SI
    if (state.configured && /^CONFIGURADO:\s*NO/m.test(config)) {
      config = config.replace(/^CONFIGURADO:\s*NO/m, 'CONFIGURADO: SI');
      changed = true;
    }

    // Restaurar nombre del proyecto
    if (state.name) {
      const currentName = config.match(/^Nombre:\s*(.+)$/m)?.[1]?.trim();
      if (!currentName || currentName === '—' || currentName === '') {
        config = config.replace(/^Nombre:\s*.*$/m, `Nombre: ${state.name}`);
        changed = true;
      }
    }

    // Restaurar test command ([^\S\n]*: no cruzar saltos de línea, 2026-07-19)
    if (state.testCommand) {
      const currentTest = config.match(/^[^\S\n]*test:[^\S\n]*(\S.*)$/m)?.[1]?.trim();
      if (!currentTest || currentTest === '—') {
        config = config.replace(/^(\s*test:)\s*.*$/m, `$1 ${state.testCommand}`);
        changed = true;
      }
    }

    // Restaurar stack si se perdió
    if (state.stack) {
      const hasStack = config.includes('## Stack') && !config.match(/^## Stack\s*\n—/m);
      if (!hasStack) {
        config = config.replace(/^## Stack[\s\S]*?(?=\n##)/m, `## Stack\n${state.stack}\n`);
        changed = true;
      }
    }

    // Restaurar secciones de usuario
    for (const [title, section] of Object.entries(state.rawSections)) {
      if (!config.includes(`## ${title}`)) {
        config += `\n${section}\n`;
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(configPath, config, 'utf8');
    }

  } catch(e) { /* best-effort */ }
}

/**
 * Lo que el proyecto declaró en .agentic/protected_files no lo pisa una
 * actualización. Manifiesto inválido = no se copia nada. Si hay manifiesto
 * pero no hay con qué leerlo, tampoco: no verificado no es permitido.
 */
function guardiaProtegidos(projectPath, fuente) {
  const candidatos = [fuente, projectPath, path.join(__dirname, '..')]
    .filter(Boolean)
    .map((base) => path.resolve(base, '.agentic', 'grafo', 'protected-files.cjs'));
  const modPath = candidatos.find((p) => fs.existsSync(p));
  const hayManifiesto = fs.existsSync(path.join(projectPath, '.agentic', 'protected_files'));
  if (!modPath) {
    if (hayManifiesto) return { ok: false, message: 'Hay .agentic/protected_files pero no se pudo cargar el verificador — update detenido' };
    return { ok: true, omitidos: [], filtro: () => true };
  }
  const pf = require(modPath);
  const m = pf.cargar(projectPath);
  if (!m.ok) return { ok: false, message: `.agentic/protected_files inválido (${m.message}${m.line ? ', línea ' + m.line : ''}) — update detenido, nada se copió` };
  const omitidos = [];
  const filtro = (_src, dest) => {
    const rel = path.relative(projectPath, dest);
    if (!rel || rel.startsWith('..')) return true;
    const r = pf.verificar(projectPath, [rel], { accion: 'update' });
    if (r.status === 'PASS') return true;
    omitidos.push(rel.replace(/\\/g, '/'));
    return false;
  };
  return { ok: true, omitidos, filtro };
}

module.exports = { update, rollback, guardiaProtegidos, preserveUserState, restoreUserState, migrarInstruccionesUsuario };

// ── migrarInstruccionesUsuario ───────────────────────────────────────────────
// Una sola vez: si el CLAUDE.md que hay en disco tiene texto del usuario
// debajo del marcador y todavía no existe .agentic/INSTRUCCIONES-PROYECTO.md,
// lo mueve allí. A partir de ese momento ese archivo es la única fuente y
// Agentix jamás lo escribe.
//
// Devuelve true si migró algo (para poder avisarlo por consola).

function migrarInstruccionesUsuario(projectPath, userInstrPath) {
  try {
    if (fs.existsSync(userInstrPath)) return false;   // ya migrado: no tocar

    const claudePath = path.join(projectPath, 'CLAUDE.md');
    if (!fs.existsSync(claudePath)) return false;

    const actual = fs.readFileSync(claudePath, 'utf8');

    // El marcador ha tenido dos redacciones; se acepta cualquiera. Se usa el
    // PRIMERO: todo lo que va después (incluso otro marcador pegado por el
    // usuario) es texto suyo y se conserva tal cual.
    const lineas = actual.split('\n');
    const sinCR = (l) => l.replace(/\r$/, '');
    const i = lineas.findIndex((l) => /^#\s*INSTRUCCIONES DEL PROYECTO/.test(sinCR(l)));
    if (i < 0) return false;

    // El marcador es un marco: líneas que empiezan por UN solo '#', cerradas
    // por una línea '# =====' (el cierre). El texto del usuario empieza DESPUÉS
    // de ese cierre y no se toca: ni sus encabezados '#', '##', '###', ni sus
    // comentarios. No se corta "por lineas que empiezan por #" porque eso se
    // comía sus títulos (lo cazó test/update-instrucciones).
    let r = i + 1;
    while (r < lineas.length && /^#(?!#)/.test(sinCR(lineas[r]))) r++;
    let borde = i;
    for (let k = r - 1; k > i; k--) {
      if (/^#\s*={5,}\s*$/.test(sinCR(lineas[k]))) { borde = k; break; }
    }
    const resto = lineas.slice(borde + 1).join('\n')
      .replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');

    if (!resto) return false;   // no había nada del usuario

    fs.ensureDirSync(path.dirname(userInstrPath));
    fs.writeFileSync(userInstrPath,
      '# Instrucciones del proyecto\n' +
      '#\n' +
      '# Este archivo es tuyo. Agentix NO lo escribe nunca.\n' +
      '# `akdd update` lo lee y lo pega al final de CLAUDE.md en cada actualización.\n' +
      '\n' + resto + '\n', 'utf8');
    return true;
  } catch {
    return false;   // fail-soft: nunca romper un update por esto
  }
}
