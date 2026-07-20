'use strict';

/**
 * ClickUp Bridge — Agentic KDD (opt-in, apagado por defecto)
 *
 * Trae tareas de una Lista de ClickUp, las coteja contra el proyecto real
 * (ast_symbols, config.md, code-summaries.cjs) y arma el "sprint sólido" que
 * el modelo presenta antes de correr `aa: sprint` con ellas. NO depende de
 * MCP — es un script más de `.agentic/grafo/`, igual que cualquier otro
 * `akdd X`, llamando directo a la API REST de ClickUp con `fetch` (global en
 * Node 18+).
 *
 * Apagado por defecto (mismo criterio que akdd hooks / akdd jina-install):
 * no hace nada hasta correr `akdd clickup on`, y eso requiere
 * CLICKUP_API_TOKEN en .env — si falta, avisa y no continúa.
 *
 * Clasificación por tarea (ver PLAN-CLICKUP-BRIDGE.md):
 *   RELEVANTE_CLARA — hay evidencia directa en el proyecto (ast_symbols,
 *     ids de UI, código_summaries) de que esto ya existe.
 *   RELEVANTE_NUEVA — no existe todavía, pero el vocabulario del ticket
 *     encaja con el dominio descrito en config.md (Stack/Descripción).
 *   AMBIGUA — señal débil, ni clara ni sin rastro. Cae a Modo Explore.
 *   SIN_RASTRO — cero evidencia Y el vocabulario no encaja con el dominio.
 *     Nunca se ejecuta sola; se dejaría nota, no se marca Done.
 *
 * Uso:
 *   node clickup-bridge.cjs on                     — activa (valida token)
 *   node clickup-bridge.cjs set-list <list-id>      — configura la lista
 *   node clickup-bridge.cjs pull                    — trae + clasifica + arma el sprint sólido
 *   node clickup-bridge.cjs status                  — estado actual (activo/lista/token)
 */

const fs = require('fs');
const path = require('path');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

const CONFIG_PATH = (root) => path.join(root, '.agentic', 'config.md');
const CLICKUP_API = 'https://api.clickup.com/api/v2';

// ── Carga liviana de .env (sin dependencia de `dotenv`) ──────────────────────
// akdd.js no carga .env para ningún comando — cada script que lo necesita se
// lo carga solo, mismo criterio que ya usa el resto del motor (FLOTA360 corre
// con `node --env-file=.env`, pero acá no controlamos cómo el dev invoca esto).
function loadDotEnv(root) {
  const p = path.join(root, '.env');
  if (!fs.existsSync(p)) return;
  const txt = fs.readFileSync(p, 'utf8');
  for (const linea of txt.split('\n')) {
    const m = linea.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv(process.cwd());

// ── Config persistida en .agentic/config.md ──────────────────────────────────
// Se usa el mismo archivo que ya guarda CONFIGURADO/Stack — una línea más,
// nada de un archivo nuevo para un solo dato.

function readConfigField(root, key) {
  const p = CONFIG_PATH(root);
  if (!fs.existsSync(p)) return null;
  const txt = fs.readFileSync(p, 'utf8');
  const m = txt.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

function writeConfigField(root, key, value) {
  const p = CONFIG_PATH(root);
  let txt = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '# Agentic KDD — Configuración del proyecto\n';
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(txt)) {
    txt = txt.replace(re, `${key}: ${value}`);
  } else {
    // Se agrega después de la primera línea (CONFIGURADO:) si existe, si no al final.
    if (/^CONFIGURADO:/m.test(txt)) {
      txt = txt.replace(/^(CONFIGURADO:.*)$/m, `$1\n${key}: ${value}`);
    } else {
      txt += `\n${key}: ${value}\n`;
    }
  }
  fs.writeFileSync(p, txt, 'utf8');
}

// ── ClickUp REST ──────────────────────────────────────────────────────────────

function apiHeaders() {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) return null;
  return { Authorization: token, 'Content-Type': 'application/json' };
}

async function clickupFetch(pathname, opts = {}) {
  const headers = apiHeaders();
  if (!headers) throw new Error('CLICKUP_API_TOKEN no configurado en .env');
  const res = await fetch(`${CLICKUP_API}${pathname}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const body = await safe(async () => res.json()) || {};
  if (!res.ok) throw new Error(`ClickUp API ${res.status}: ${body.err || res.statusText}`);
  return body;
}

async function getCurrentUser() {
  return clickupFetch('/user');
}

async function getListTasks(listId) {
  const data = await clickupFetch(`/list/${listId}/task?include_closed=false`);
  return data.tasks || [];
}

async function markTaskDone(taskId, doneStatus) {
  // Los estados son PROPIOS de cada Lista de ClickUp — "complete" no existe
  // universalmente (encontrado probando contra lista real: "Status does not
  // exist"). Si no se pasa uno explícito, se resuelve el estado de cierre
  // real de la lista de esta tarea: el de type 'done'/'closed', o el último.
  let status = doneStatus;
  if (!status) {
    const task = await clickupFetch(`/task/${taskId}`);
    const listId = task.list && task.list.id;
    if (listId) {
      const list = await clickupFetch(`/list/${listId}`);
      const statuses = (list.statuses || []);
      const cierre = statuses.find(s => s.type === 'done' || s.type === 'closed') || statuses[statuses.length - 1];
      if (cierre) status = cierre.status;
    }
  }
  if (!status) throw new Error('no se pudo resolver el estado de cierre de la lista — pasá --status=X explícito');
  return clickupFetch(`/task/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

async function commentOnTask(taskId, text) {
  return clickupFetch(`/task/${taskId}/comment`, {
    method: 'POST',
    body: JSON.stringify({ comment_text: text }),
  });
}

// ── Clasificación de una tarea contra el proyecto ────────────────────────────

function loadCodeSummaries(root) {
  const dbPath = path.join(root, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return [];
  const db = safe(() => {
    try { return new (require('better-sqlite3'))(dbPath, { readonly: true }); }
    catch { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath, { readOnly: true }); }
  });
  if (!db) return [];
  const rows = safe(() => db.prepare(`SELECT file, summary FROM code_summaries WHERE symbol = ''`).all()) || [];
  safe(() => db.close());
  return rows;
}

function loadAstSymbolNames(root) {
  const dbPath = path.join(root, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return [];
  const db = safe(() => {
    try { return new (require('better-sqlite3'))(dbPath, { readonly: true }); }
    catch { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath, { readOnly: true }); }
  });
  if (!db) return [];
  // file incluido: la elegibilidad --auto necesita saber QUÉ archivos matchea
  // un ticket para pasarlos por classifyFileRisk (security-gate).
  const rows = safe(() => db.prepare(`SELECT DISTINCT symbol_name, file FROM ast_symbols`).all()) || [];
  safe(() => db.close());
  return rows
    .map(r => ({ name: String(r.symbol_name || '').toLowerCase(), file: String(r.file || '') }))
    .filter(r => r.name);
}

function loadDomainVocabulary(root) {
  const cfg = path.join(root, '.agentic', 'config.md');
  if (!fs.existsSync(cfg)) return '';
  return fs.readFileSync(cfg, 'utf8').toLowerCase();
}

/** Extrae palabras "de contenido" (no stopwords) de un texto, para comparar por overlap. */
function contentWords(text) {
  const STOP = new Set(['el','la','los','las','de','del','al','un','una','y','o','que','en','a','para','con','por','se','su','sus','es','este','esta','como','no','si','ya','lo']);
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP.has(w));
}

// Comparación por prefijo (stem barato): "facturas" y "facturación" no son
// substring una de otra, pero comparten los primeros 6 caracteres. Sin esto,
// palabras del mismo dominio con distinta terminación (plural, conjugación)
// fallan a SIN_RASTRO por error de forma, no por falta de relación real —
// encontrado probando "agrega pagos con tarjeta" contra un dominio que solo
// dice "facturación" (no "factura"/"pagos" literal).
function stem(w) { return w.length > 6 ? w.slice(0, 6) : w; }
/** Cuenta cuántos STEMS DISTINTOS de `a` aparecen en `b` — no ocurrencias. Sin
 * esto, "guardar" repetida 2 veces en el título+descripción de un mismo
 * ticket contaba como 2 coincidencias distintas, disparando el umbral de
 * RELEVANTE_CLARA con una sola palabra real en común (bug encontrado
 * probando contra ClickUp real). */
function overlapCount(a, b) {
  const stemsB = new Set(b.map(stem));
  const stemsA = new Set(a.map(stem));
  let n = 0;
  for (const s of stemsA) if (stemsB.has(s)) n++;
  return n;
}

function classifyTask(task, root) {
  const texto = `${task.name || ''} ${task.description || task.text_content || ''}`;
  const palabras = contentWords(texto);

  // 0. Descripción demasiado pobre (solo título de 1-3 palabras, sin texto
  //    real) → SIEMPRE ambigua, ANTES de intentar cualquier match. Encontrado
  //    probando contra ClickUp real: "Revisar" (una sola palabra) daba
  //    RELEVANTE_CLARA porque "revisa" coincidía por casualidad con la
  //    descripción de auth.js ("revisa que el token sea válido") — con tan
  //    poco texto, cualquier coincidencia es más ruido que señal real.
  if (palabras.length < 4) {
    return { categoria: 'AMBIGUA', evidencia: 'descripción insuficiente para clasificar con confianza' };
  }

  const astNames = loadAstSymbolNames(root);
  const summaries = loadCodeSummaries(root);
  const dominioPalabras = contentWords(loadDomainVocabulary(root));

  // 1. Evidencia DIRECTA: RELEVANTE_CLARA exige al menos 2 palabras de
  //    contenido en común (no 1 sola) — un ticket de "predicción del clima
  //    para las rutas" comparte la palabra "rutas" con el proyecto (es un
  //    concepto real), pero eso solo NO alcanza para decir "esto ya existe".
  //    Bajado de "alguna coincidencia" a "al menos 2" tras encontrar ese caso
  //    real probando contra ClickUp.
  const astPalabras = astNames.flatMap(s => contentWords(s.name.replace(/[_.\/]/g, ' ')));
  const matchAst = overlapCount(palabras, astPalabras) >= 2;
  // Archivos matcheados: los que la elegibilidad --auto pasa después por
  // classifyFileRisk. Por símbolo (archivo del símbolo que coincide) y por
  // summary (archivo cuya descripción coincide).
  const archivosMatch = new Set();
  if (matchAst) {
    astNames.forEach(s => {
      const ws = contentWords(s.name.replace(/[_.\/]/g, ' '));
      if (ws.length && overlapCount(palabras, ws) >= 1) archivosMatch.add(s.file);
    });
  }
  let matchSummary = false;
  for (const s of summaries) {
    const desc = contentWords(String(s.description || s.summary || ''));
    if (overlapCount(palabras, desc) >= 2) {
      matchSummary = true;
      archivosMatch.add(String(s.file || ''));
    }
  }

  if (matchAst || matchSummary) {
    return {
      categoria: 'RELEVANTE_CLARA',
      evidencia: matchAst ? 'ast_symbols' : 'code-summaries',
      archivos: [...archivosMatch].filter(Boolean),
    };
  }

  // 2. Sin evidencia directa fuerte — ¿el vocabulario encaja con el dominio
  //    del proyecto (lo que describe config.md)? Acá 1 sola coincidencia
  //    alcanza — RELEVANTE_NUEVA nunca es auto-ejecutable, así que una señal
  //    más débil es aceptable (es solo una etiqueta informativa para quien
  //    revisa la lista, no una puerta de seguridad).
  const encajaDominio = overlapCount(palabras, dominioPalabras) >= 1;

  if (encajaDominio) {
    return { categoria: 'RELEVANTE_NUEVA', evidencia: 'vocabulario coincide con el dominio de config.md, sin evidencia directa en código' };
  }

  return { categoria: 'SIN_RASTRO', evidencia: 'ninguna coincidencia en ast_symbols, code-summaries, ni dominio de config.md' };
}

// ── Comandos ──────────────────────────────────────────────────────────────────

async function cmdOn(root) {
  if (!process.env.CLICKUP_API_TOKEN) {
    console.log('\n  ⚠️  Falta CLICKUP_API_TOKEN en tu .env');
    console.log('  1. ClickUp → tu avatar → Configuración → Apps → API Token');
    console.log('  2. Agregá: CLICKUP_API_TOKEN=pk_... en .env');
    console.log('  3. Volvé a correr: akdd clickup on\n');
    return false;
  }
  let user;
  try { user = await getCurrentUser(); }
  catch (e) {
    console.log(`\n  ❌ El token no funcionó: ${e.message}\n`);
    return false;
  }
  writeConfigField(root, 'clickup_enabled', 'true');
  console.log(`\n  ✅ ClickUp activado — token válido para: ${user.user?.username || user.user?.email || 'usuario desconocido'}`);
  console.log('  Falta configurar la lista: akdd clickup set-list <list-id>\n');
  return true;
}

function cmdSetList(root, listId) {
  if (!listId) { console.log('\n  Uso: akdd clickup set-list <list-id>\n'); return; }
  writeConfigField(root, 'clickup_list_id', listId);
  console.log(`\n  ✅ Lista configurada: ${listId} (guardado en .agentic/config.md)\n`);
}

function cmdStatus(root) {
  const enabled = readConfigField(root, 'clickup_enabled') === 'true';
  const listId = readConfigField(root, 'clickup_list_id');
  const hasToken = !!process.env.CLICKUP_API_TOKEN;
  console.log('\n  ClickUp Bridge — estado');
  console.log(`  Activado:       ${enabled ? '✅' : '❌ (correr: akdd clickup on)'}`);
  console.log(`  Token en .env:  ${hasToken ? '✅' : '❌'}`);
  console.log(`  Lista:          ${listId || '❌ (correr: akdd clickup set-list <id>)'}\n`);
}

// ── Elegibilidad --auto (Feature 1) ──────────────────────────────────────────
// Reutiliza los gates REALES en vez de inventar criterios propios:
//   - classifyFileRisk (security-gate.cjs) sobre los archivos matcheados
//   - runSpecGate (spec-gate.cjs) sobre el texto del ticket
// Ante CUALQUIER duda (WARN incluido) → no elegible. El --auto solo corre lo
// que es obviamente seguro; todo lo demás espera confirmación humana.

function autoEligibility(tarea, root) {
  const razones = [];
  const c = tarea.clasificacion;

  if (c.categoria !== 'RELEVANTE_CLARA') {
    return { elegible: false, razones: [`categoría ${c.categoria} — solo RELEVANTE_CLARA puede correr sola`] };
  }

  // Descripción con sustancia real: 8+ palabras de contenido. Más exigente
  // que el umbral de clasificación (4) — clasificar con poco es aceptable,
  // EJECUTAR sin confirmación con poco no.
  const texto = `${tarea.nombre || ''} ${tarea.descripcion || ''}`;
  if (contentWords(texto).length < 8) {
    razones.push('descripción corta — ejecutar sin confirmación exige un ticket bien explicado');
  }

  // Riesgo de los archivos que el ticket matchea en el proyecto.
  try {
    const { classifyFileRisk } = require('./security-gate.cjs');
    for (const f of (c.archivos || [])) {
      const riesgo = classifyFileRisk(f);
      if (riesgo === 'CRITICAL' || riesgo === 'SENSITIVE') {
        razones.push(`toca ${f} (${riesgo})`);
      }
    }
  } catch { razones.push('security-gate no disponible — sin clasificación de riesgo, no se auto-ejecuta'); }

  // Valores de negocio vigilados (Spec Gate) en el texto del ticket.
  try {
    const { runSpecGate } = require('./spec-gate.cjs');
    const spec = runSpecGate(texto, root);
    if (spec && (spec.violations || []).length > 0) {
      razones.push(`Spec Gate: ${spec.violations.map(v => v.field).join(', ')} — valores de negocio requieren confirmación humana SIEMPRE`);
    }
  } catch { razones.push('spec-gate no disponible — sin verificación de valores, no se auto-ejecuta'); }

  // Conflicto con la MEMORIA real del proyecto — el Spec Gate de arriba usa
  // nombres de campo hardcodeados en inglés (trial_days…) y falla ciego con
  // tickets en español sobre valores propios del proyecto (encontrado en la
  // primera prueba real: "subir el recargo de combustible a 15%" salió
  // elegible aunque la memoria tiene una decisión ALTA sobre ese recargo).
  // Regla: el ticket trae un NÚMERO y comparte ≥2 stems con un nodo
  // ALTA/MEDIA que también trae un número → posible cambio de regla de
  // negocio → confirmación humana siempre.
  const ticketTieneNumero = /\d/.test(texto);
  if (ticketTieneNumero) {
    const nodos = loadMemoryNodes(root);
    const palabrasTicket = contentWords(texto);
    for (const n of nodos) {
      if (!/\d/.test(n.texto)) continue;
      if (overlapCount(palabrasTicket, contentWords(n.texto)) >= 2) {
        razones.push(`coincide con una regla registrada en memoria (${n.confianza}): "${n.titulo.slice(0, 60)}" — cambiar un valor de negocio exige confirmación`);
        break;
      }
    }
  }

  // Tema sensible por vocabulario del ticket — espejo semántico de la lista
  // CRITICAL de archivos: si el ticket HABLA de autenticación/sesiones/
  // credenciales, da igual qué archivo haya matcheado la clasificación
  // (encontrado en la primera prueba real: "recuérdame al login con sesión de
  // 30 días" matcheó login() de public/app.js — NORMAL — y nunca vio auth.js).
  const TEMAS_CRITICOS = /\b(login|auth|autentic\w*|sesi[oó]n(es)?|token(s)?|contraseñ\w*|password|credencial\w*|jwt|permis\w*|rol(es)?\b)/i;
  if (TEMAS_CRITICOS.test(texto)) {
    razones.push('el ticket toca autenticación/sesiones/credenciales — tema CRITICAL, confirmación humana siempre');
  }

  // Alcance estructural grande — migraciones/reescrituras nunca corren solas
  // por más claras que estén descritas.
  const ALCANCE_GRANDE = /\b(migra\w*|reescrib\w*|redise\w*|elimina\w+\s+(el\s+)?m[oó]dulo|drop\s+table)/i;
  if (ALCANCE_GRANDE.test(texto)) {
    razones.push('alcance estructural grande (migración/reescritura) — confirmación humana siempre');
  }

  return { elegible: razones.length === 0, razones };
}

/** Nodos de memoria ALTA/MEDIA (decision/patron/error) con su texto, para el chequeo de conflicto. */
function loadMemoryNodes(root) {
  const dbPath = path.join(root, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return [];
  const db = safe(() => {
    try { return new (require('better-sqlite3'))(dbPath, { readonly: true }); }
    catch { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath, { readOnly: true }); }
  });
  if (!db) return [];
  const rows = safe(() => db.prepare(
    `SELECT titulo, contenido, confianza FROM nodos
     WHERE estado = 'ACTIVO' AND confianza IN ('ALTA','MEDIA')
       AND tipo IN ('decision','patron','error')`
  ).all()) || [];
  safe(() => db.close());
  return rows.map(r => ({
    titulo: String(r.titulo || ''),
    confianza: r.confianza,
    texto: `${r.titulo || ''} ${r.contenido || ''}`,
  }));
}

async function cmdPull(root, { auto = false } = {}) {
  const enabled = readConfigField(root, 'clickup_enabled') === 'true';
  const listId = readConfigField(root, 'clickup_list_id');
  if (!enabled) { console.log('\n  ❌ ClickUp no está activado. Corré: akdd clickup on\n'); return null; }
  if (!listId) { console.log('\n  ❌ Falta configurar la lista. Corré: akdd clickup set-list <id>\n'); return null; }

  let tasks;
  try { tasks = await getListTasks(listId); }
  catch (e) { console.log(`\n  ❌ Error trayendo tareas: ${e.message}\n`); return null; }

  const clasificadas = tasks.map(t => ({
    id: t.id,
    nombre: t.name,
    descripcion: String(t.description || t.text_content || ''),
    clasificacion: classifyTask(t, root),
  }));

  if (auto) {
    clasificadas.forEach(t => { t.auto = autoEligibility(t, root); });
  }

  console.log(`\n  📋 Sprint sólido — ${clasificadas.length} tarea(s) traídas de la lista ${listId}${auto ? ' (modo --auto)' : ''}\n`);
  clasificadas.forEach(t => {
    const icono = { RELEVANTE_CLARA: '🟢', RELEVANTE_NUEVA: '🔵', AMBIGUA: '🟡', SIN_RASTRO: '🔴' }[t.clasificacion.categoria] || '❔';
    console.log(`  ${icono} [${t.clasificacion.categoria}] ${t.nombre}  (id: ${t.id})`);
    console.log(`     ${t.clasificacion.evidencia}`);
    if (t.auto) {
      if (t.auto.elegible) console.log('     ⚡ AUTO-ELEGIBLE — puede correr sola');
      else console.log(`     ✋ requiere confirmación: ${t.auto.razones.join('; ')}`);
    }
  });

  if (auto) {
    const elegibles = clasificadas.filter(t => t.auto && t.auto.elegible);
    const esperan = clasificadas.filter(t => !t.auto || !t.auto.elegible);
    console.log(`\n  ── Resumen pre-lote (el seguro barato) ──`);
    console.log(`  ⚡ Correrían solas:          ${elegibles.length} → ${elegibles.map(t => `"${t.nombre}"`).join(', ') || '—'}`);
    console.log(`  ✋ Esperan confirmación:     ${esperan.length}`);
  }
  console.log('');
  return clasificadas;
}

// ── Cierre en ClickUp (Feature 2) ─────────────────────────────────────────────

async function cmdDone(root, taskId, status) {
  if (!taskId) { console.log('\n  Uso: akdd cu done <task-id> [--status=X]\n'); return; }
  const enabled = readConfigField(root, 'clickup_enabled') === 'true';
  if (!enabled) { console.log('\n  ❌ ClickUp no está activado. Corré: akdd clickup on\n'); return; }
  try {
    await markTaskDone(taskId, status);
    console.log(`\n  ✅ Tarea ${taskId} marcada como completada en ClickUp\n`);
  } catch (e) { console.log(`\n  ❌ No se pudo marcar: ${e.message}\n`); process.exitCode = 1; }
}

async function cmdComment(root, taskId, texto) {
  if (!taskId || !texto) { console.log('\n  Uso: akdd cu comment <task-id> "texto"\n'); return; }
  const enabled = readConfigField(root, 'clickup_enabled') === 'true';
  if (!enabled) { console.log('\n  ❌ ClickUp no está activado. Corré: akdd clickup on\n'); return; }
  try {
    await commentOnTask(taskId, texto);
    console.log(`\n  ✅ Comentario dejado en la tarea ${taskId}\n`);
  } catch (e) { console.log(`\n  ❌ No se pudo comentar: ${e.message}\n`); process.exitCode = 1; }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1).filter(a => !a.startsWith('--'));
  const flags = argv.filter(a => a.startsWith('--'));
  const root = process.cwd();

  (async () => {
    if (cmd === 'on') await cmdOn(root);
    else if (cmd === 'set-list') cmdSetList(root, rest[0]);
    else if (cmd === 'status') cmdStatus(root);
    else if (cmd === 'pull') await cmdPull(root, { auto: flags.includes('--auto') });
    else if (cmd === 'done') {
      const statusFlag = flags.find(f => f.startsWith('--status='));
      await cmdDone(root, rest[0], statusFlag ? statusFlag.split('=')[1] : undefined);
    }
    else if (cmd === 'comment') await cmdComment(root, rest[0], rest.slice(1).join(' '));
    else console.log('\n  Uso: node clickup-bridge.cjs <on|set-list|status|pull [--auto]|done <id>|comment <id> "texto">\n');
  })().catch(e => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { classifyTask, autoEligibility, cmdOn, cmdSetList, cmdStatus, cmdPull, cmdDone, cmdComment, getListTasks, markTaskDone, commentOnTask, getCurrentUser };
