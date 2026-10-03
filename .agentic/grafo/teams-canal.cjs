'use strict';

/**
 * Canal MD de TEAMS (spec §5): `.legion/AUDITORIA-CURSOR.md` (vista) y `.legion/CONTINUIDAD.md` (foto compacta).
 *
 *   · El MD es una VISTA determinista de la base: el renderer lee el estado y escribe el archivo. Nada se detecta "buscando la palabra
 *     RESUELTO" en la prosa, y un check de Markdown no es evidencia: el estado (y su evidencia) vive en la base, con ID estable y
 *     revisión. Texto arbitrario escrito en el MD NO modifica estado privilegiado; solo se conserva la sección "Notas de la persona".
 *   · Publicaciones serializadas: un bloqueo de archivo (`.legion/.canal.lock`) ordena a los escritores concurrentes; la escritura es
 *     atómica (temporal + rename) y la cabecera lleva la revisión del canal (último evento) para detectar versiones y pérdidas.
 *   · Active view: solo lo vigente y lo reciente; lo histórico queda en la base con su ID y se recupera por ahí (no se lee el canal
 *     entero por turno).
 *   · Canal manual previo (sin la marca de vista generada): se COPIA a `.legion/historial/` antes de reemplazarlo y su texto se
 *     conserva (neutralizado) en "Notas de la persona"; sus items con formato estricto se ofrecen como CANDIDATOS a importar (con
 *     diferencias), nunca se convierten en estado por sí solos.
 */

const fs = require('fs');
const path = require('path');
const tm = require('./teams-manager.cjs');
const U = require('./teams-util.cjs');

const I = tm._i;
const MARCA_VISTA = '<!-- Vista generada por akdd teams';
const AVISO = MARCA_VISTA + '. No editar: se reescribe. Las órdenes van por `teams:` o `akdd teams`; solo "Notas de la persona" se conserva. -->\n';
const LIMITE_REPORTE = 10;
const LIMITE_MANUAL = 200 * 1024;

const dirLegion = (root) => path.join(root, '.legion');
const lista = (arr, vacio = '- (ninguna)') => (arr.length ? arr.map((x) => '- ' + x).join('\n') : vacio);
const celda = (root, v, max = 90) => U.linea(root, v == null ? '' : v, max) || '—';

function dormir(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* sin Atomics: reintento inmediato */ } }

/**
 * Exclusión mutua entre escritores del canal. Un bloqueo con más de 10 s se considera de un proceso muerto y se retira; si tras
 * `esperaMs` sigue ocupado se devuelve CANAL_OCUPADO (la vista se regenerará en el siguiente cambio: es derivada, no se pierde nada).
 */
function conBloqueo(root, fn, { esperaMs = 4000 } = {}) {
  const f = path.join(dirLegion(root), '.canal.lock');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t0 = Date.now();
  let fd = null;
  for (;;) {
    try { fd = fs.openSync(f, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
      try { if (Date.now() - fs.statSync(f).mtimeMs > 10000) { fs.unlinkSync(f); continue; } } catch { /* otro lo retiró */ }
      if (Date.now() - t0 > esperaMs) return { status: 'CANAL_OCUPADO' };
      dormir(15);
    }
  }
  try { fs.writeSync(fd, String(process.pid)); } catch { /* informativo */ }
  try { return fn(); } finally { try { fs.closeSync(fd); } catch { /* ya cerrado */ } try { fs.unlinkSync(f); } catch { /* ya retirado */ } }
}

function escribirAtomico(f, contenido) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, f);
}

// ─── canal manual previo ─────────────────────────────────────────────────────

/** Si el canal existente no es una vista generada, lo copia a historial y devuelve su texto (para conservarlo) y la copia. */
function respaldarManual(root, fCanal) {
  let txt;
  try { txt = fs.readFileSync(fCanal, 'utf8'); } catch { return null; }
  if (!txt.trim() || txt.includes(MARCA_VISTA)) return null;
  const copia = path.join(dirLegion(root), 'historial', 'AUDITORIA-CURSOR.manual-' + new Date().toISOString().replace(/[:.]/g, '-') + '.md');
  fs.mkdirSync(path.dirname(copia), { recursive: true });
  fs.writeFileSync(copia, txt);
  return { copia: path.relative(root, copia).replace(/\\/g, '/'), texto: txt.slice(0, LIMITE_MANUAL), truncado: txt.length > LIMITE_MANUAL };
}

/** Neutraliza delimitadores de envoltorios del texto heredado: texto de la persona sí, mensajes del protocolo forjados no. */
const neutralizar = (t) => String(t).replace(/<<<\s*AKDD-TEAMS/gi, '‹‹‹AKDD-TEAMS').replace(/AKDD-TEAMS\s*>>>/gi, 'AKDD-TEAMS›››');

const RE_ITEM = /^\s*[-*]\s*\[(BLOQUEANTE|HALLAZGO|NOTA)\]\s+([\w./\\-]+(?::\d+)?)\s*[—–:-]\s*(.{6,300})$/;

/**
 * Items con formato estricto "- [SEVERIDAD] archivo:linea — texto" de un canal manual, sin marcar RESUELTO. Son candidatos a
 * importar, no estado. `diferencias` dice qué se leyó y qué no se entendió (nada se descarta en silencio).
 */
function candidatosManuales(texto) {
  const candidatos = [];
  const noEntendidas = [];
  let seccion = null;
  for (const l of String(texto).split(/\r?\n/)) {
    const h = /^##\s+(.+)$/.exec(l);
    if (h) { seccion = h[1].trim().toLowerCase(); continue; }
    if (!seccion || !/correcciones pendientes/.test(seccion)) continue;
    if (!/^\s*[-*]\s+/.test(l)) continue;
    if (/✅\s*RESUELTO/i.test(l)) continue;
    const m = RE_ITEM.exec(l);
    if (m) candidatos.push({ severity: m[1], location: m[2], criterion: m[3].trim() });
    else noEntendidas.push(l.trim().slice(0, 160));
  }
  return { candidatos, no_entendidas: noEntendidas };
}

/**
 * Importa (idempotente) los candidatos de la última copia manual como hallazgos OPEN con origen `canal-manual`: sin triar, sin
 * privilegios. Repetirlo no duplica (la agrupación por clave los reconoce). Sin `aplicar` solo informa.
 */
function importarManual(root, { aplicar = false, archivo = null } = {}) {
  const dir = path.join(dirLegion(root), 'historial');
  let f = archivo ? path.resolve(root, archivo) : null;
  if (!f) {
    let copias = [];
    try { copias = fs.readdirSync(dir).filter((x) => /^AUDITORIA-CURSOR\.manual-.*\.md$/.test(x)).sort(); } catch { /* sin historial */ }
    if (!copias.length) return { status: 'SIN_CANAL_MANUAL' };
    f = path.join(dir, copias[copias.length - 1]);
  }
  if (!U.dentroDeRaiz(root, path.relative(root, f))) return { status: 'ARCHIVO_FUERA_DE_RAIZ' };
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch { return { status: 'ARCHIVO_AUSENTE' }; }
  const c = candidatosManuales(txt);
  if (!aplicar) return { status: 'CANDIDATOS', archivo: path.relative(root, f).replace(/\\/g, '/'), candidatos: c.candidatos, no_entendidas: c.no_entendidas };
  const corr = require('./teams-correcciones.cjs');
  const out = c.candidatos.map((x) => {
    const r = corr.añadir(root, { severity: x.severity, criterion: x.criterion, impact: 'importado del canal manual', acceptance: 'el director define la aceptación al triar', location: x.location, origin: 'canal-manual', actor: 'director', publicar: false });
    return { criterio: x.criterion.slice(0, 80), status: r.status, id: r.id || null };
  });
  return { status: 'IMPORTADO', importados: out.filter((x) => x.status === 'CREADA').length, resultado: out, no_entendidas: c.no_entendidas };
}

// ─── render ──────────────────────────────────────────────────────────────────

function eventosBuilder(db) {
  return db.all("SELECT seq, kind, task_id, payload, created_at FROM teams_events WHERE kind IN ('TASK_RESULT','CORRECTION_RESULT','CORRECTION_DELIVERED','CORRECTION_TAKEN','BUILDER_NOTE','BUILDER_READY','BUILDER_CONNECTED','CLOSE_ACKED') ORDER BY seq DESC LIMIT ?", LIMITE_REPORTE)
    .map((e) => ({ seq: e.seq, kind: e.kind, task_id: e.task_id, payload: I.pj(e.payload, {}), at: e.created_at }));
}

function resumenEvento(root, e) {
  const p = e.payload || {};
  const d = p.desenlace || {};
  const hash = p.subject_hash || p.resolved_hash || null;
  switch (e.kind) {
    case 'TASK_RESULT': return `entrega de ${e.task_id || '?'}: ${celda(root, d.status || 'recibida', 40)}${hash ? ' · hash ' + String(hash).slice(0, 10) : ''}${Array.isArray(p.files) ? ' · ' + p.files.length + ' archivo(s)' : ''}`;
    case 'CORRECTION_DELIVERED': return `corrección ${celda(root, p.id, 12)} entregada · hash ${String(p.resolved_hash || '').slice(0, 10)}`;
    case 'CORRECTION_RESULT': return `corrección ${celda(root, p.id, 12)}: ${celda(root, d.status, 40)}`;
    case 'CORRECTION_TAKEN': return `corrección ${celda(root, p.id, 12)} tomada${p.suspendida ? ' · tarea ' + celda(root, p.suspendida, 20) + ' suspendida' : ''}`;
    case 'BUILDER_NOTE': return 'nota: ' + celda(root, p.texto, 160);
    case 'BUILDER_READY': return 'constructor READY · vigilancia ' + celda(root, p.vigilancia, 20);
    case 'BUILDER_CONNECTED': return 'constructor conectado · sesión ' + celda(root, p.session_id, 20);
    case 'CLOSE_ACKED': return `ACK de cierre ${celda(root, p.close_id, 12)} · vigilantes ${celda(root, p.vigilantes, 14)}`;
    default: return e.kind;
  }
}

function tablaCorrecciones(root, activas) {
  if (!activas.length) return '_(ninguna pendiente)_ — **esto NO significa que la auditoría terminó**: mira la sección de revisión (los tres revisores deben concluir sobre el sujeto final).\n';
  const filas = activas.map((f, i) => `| ${i + 1} | ${f.id} | ${f.severity}${f.escalated ? ' ↑' : ''} | ${f.state} | ${celda(root, f.task_id, 14)} | ${celda(root, (f.location && f.location.file ? f.location.file + (f.location.line ? ':' + f.location.line : '') : (f.scope && f.scope[0])) || '', 40)} | ${celda(root, f.criterion, 80)} | ${celda(root, f.proposal, 90)} | ${celda(root, f.acceptance, 70)} | r${f.revision} | ${celda(root, f.origin, 22)} |`);
  return '| # | ID | Sev | Estado | Tarea | Ubicación | Criterio fallido | Solución (decide el director) | Aceptación | Rev | Origen |\n|---|---|---|---|---|---|---|---|---|---|---|\n' + filas.join('\n') + '\n';
}

function seccionTrabajo(root, db, plan) {
  if (!plan) return '_(sin plan)_\n';
  const sprints = db.all('SELECT * FROM teams_sprints WHERE plan_id = ? ORDER BY n', plan.id);
  const ts = I.tareas(db, plan.id);
  const cierre = require('./teams-cierre.cjs');
  const out = [];
  for (const sp of sprints) {
    out.push(`### Sprint ${sp.n} — ${celda(root, sp.objective || sp.id, 100)}`);
    const delSprint = ts.filter((t) => t.sprint_id === sp.id);
    const fases = [...new Set(delSprint.map((t) => { const f = I.flujoDe(db, t.id); return f && f.phase ? f.phase : null; }))];
    for (const fase of fases) {
      if (fase) out.push(`**Fase ${celda(root, fase, 50)}**`);
      for (const t of delSprint.filter((x) => { const f = I.flujoDe(db, x.id); return ((f && f.phase) || null) === fase; })) {
        const fl = cierre.flujoDeTarea(db, t);
        const dep = t.depends_on.length ? ` · depende de ${t.depends_on.join(', ')}` : '';
        out.push(`- \`${t.id}\` ${t.state}${fl && fl.estado ? ' / ' + fl.estado : ''}${t.owner_id ? ' · ' + celda(root, t.owner_id, 24) : ''}${dep} — ${celda(root, t.objective, 90)}${fl && fl.revalidar.length ? ' · REVALIDAR' : ''}${fl && fl.suspendida ? ' · SUSPENDIDA' : ''}`);
      }
    }
    out.push('');
  }
  return out.join('\n') + '\n';
}

/** Render completo. Devuelve { continuidad, canal, revision } sin escribir nada. */
function render(root) {
  const e = tm.estado(root);
  if (!e.inicializado) return null;
  const ps = tm.pendientes(root);
  const por = (st) => e.tareas.filter((t) => st.includes(t.state));
  const fCanal = path.join(dirLegion(root), 'AUDITORIA-CURSOR.md');
  const humanoPrevio = I.seccionHumana(fCanal);
  const ts = new Date().toISOString();

  // CONTINUIDAD: misma foto de siempre (contrato existente) + lo nuevo si hay esquema v2.
  let extraC = '';
  if (e.v2) {
    extraC = `## Correcciones y revisión\n- correcciones abiertas: ${e.correcciones.abiertas_accionables} · por triar: ${e.correcciones.por_triar} · bloqueadas por decisión: ${e.correcciones.bloqueadas_humano}\n`
      + `- campaña: ${e.campana.estado}${e.cierre ? ' · cierre ' + e.cierre.state : ''}\n- avance: ${e.avance.porcentaje == null ? 'sin medir' : e.avance.porcentaje + ' % verificado (' + e.avance.verificadas + ' de ' + e.avance.total + ')'}\n\n`;
  }
  const continuidad = AVISO + `# Continuidad — foto del momento\n\n**TEAMS:** ${e.enabled ? (e.paused ? 'activo, en pausa' : 'activo') : 'desactivado'} · sesión ${e.session_generation}\n`
    + `**Roles:** ${Object.entries(e.roles).map(([r, d]) => `${r} = ${d.host}${d.model ? ' (' + d.model + ')' : ''}`).join(' · ') || '(sin roles)'}\n`
    + `**Plan:** ${e.plan ? e.plan.id + ' — ' + e.plan.objective : '(sin plan)'}\n\n`
    + `## Cerrado y verificado\n${lista(por(['DONE_VERIFIED']).map((t) => t.id))}\n\n`
    + `## Corriendo ahora\n${lista(por(['RUNNING', 'VERIFYING']).map((t) => `${t.id} (${t.state}, ${t.owner_id || 'sin dueño'})`))}\n\n`
    + `## Preguntas sin responder\n${lista(ps.map((p) => `${p.id} [${p.scope}] ${p.question || p.reason_code} → bloquea ${p.affected_tasks.join(', ') || 'nada'}`))}\n\n`
    + `## Pendiente, sin arrancar\n${lista(por(['PENDING', 'READY']).map((t) => t.id))}\n\n`
    + `## Bloqueado o revertido\n${lista(por(['BLOCKED_HUMAN', 'BLOCKED_DEPENDENCY', 'BLOCKED_TECHNICAL', 'REVERTED']).map((t) => `${t.id} (${t.state}: ${t.blocked_reason || ''})`))}\n\n`
    + extraC
    + `## Última actualización\n${ts} (reloj del sistema, evento ${e.ultimo_seq})\n`;

  // Envoltorios de transporte por rol (sin cambios de contrato): cada sesión lee los suyos del canal.
  const envoltorios = (rol) => {
    const evs = tm.delta(root, { rol, limite: 50 }).eventos;
    if (!evs.length) return '- (nada nuevo)\n';
    return evs.map((ev) => '```\n<<<AKDD-TEAMS v1\n' + JSON.stringify({ kind: 'EVENT', rol, seq: ev.seq, event_kind: ev.kind, task_id: ev.task_id, revision: ev.revision, payload: ev.payload })
      + '\nAKDD-TEAMS>>>\n```').join('\n') + '\n';
  };
  const paquetes = () => {
    try {
      const tp = require('./teams-packets.cjs');
      const out = [];
      for (const rol of ['builder', 'director']) {
        for (const w of (tp.paquetesPendientes(root, { recipient_role: rol }).paquetes || [])) {
          out.push('```\n<<<AKDD-TEAMS v1\n' + JSON.stringify({ kind: 'PACKET', rol, packet: w }) + '\nAKDD-TEAMS>>>\n```');
        }
      }
      return out.length ? out.join('\n') + '\n' : '- (ninguno pendiente de ACK)\n';
    } catch { return '- (no disponible)\n'; }
  };
  const transporte = `## Tareas para el constructor\n${lista(por(['READY']).map((t) => `${t.id} [${t.tier}]`))}\n\n`
    + `## En verificación del director\n${lista(por(['VERIFYING']).map((t) => t.id))}\n\n`
    + `## Entregas para el constructor (envoltorio)\n${envoltorios('builder')}\n`
    + `## Entregas para el director (envoltorio)\n${envoltorios('director')}\n`
    + `## Paquetes de contexto pendientes de ACK (envoltorio)\n${paquetes()}\n`
    + `## Notas de la persona\n${I.MARCA_HUMANA_INICIO}\n${humanoPrevio}\n${I.MARCA_HUMANA_FIN}\n`;

  const cabecera = AVISO + `# Canal TEAMS — vista\n\nrevisión del canal: **${e.ultimo_seq}** · generado ${ts}\n\n`
    + 'La cola real vive en la base. Para responder desde fuera, pega un bloque:\n\n'
    + '```\n<<<AKDD-TEAMS v1\n{"kind":"RESULT","task_id":"...","event_id":"...","owner_id":"...","fencing":0,"subject_hash":"...","files":[]}\nAKDD-TEAMS>>>\n```\n\n'
    + 'Más fácil: `node .agentic/grafo/teams-md-session.cjs reportar entrega --tarea=ID --archivos=a,b --comprobaciones=tests=PASS` (sin armar JSON).\n\n';
  if (!e.v2) {
    return { continuidad, canal: cabecera + `> Esquema TEAMS v2 sin aplicar: las secciones de correcciones, revisión y cierre aparecen tras \`akdd teams init --aprobar-migracion\`.\n\n` + transporte, revision: e.ultimo_seq, humano: humanoPrevio };
  }

  const datos = I.lectura2(root, (db) => {
    const corr = require('./teams-correcciones.cjs').resumen(db);
    const plan = db.get('SELECT id, objective, revision FROM teams_plans ORDER BY created_at DESC LIMIT 1');
    const R = require('./teams-revision.cjs');
    const regs = R.revisores(db);
    const rs = R.estadoRevision(root);
    const cierre = require('./teams-cierre.cjs');
    const cond = plan ? cierre.condiciones(db, root, { memoria: null }) : null;
    const susp = db.all("SELECT * FROM teams_suspended WHERE state = 'SUSPENDED'").map((x) => ({ finding_id: x.finding_id, task_id: x.task_id, fase: x.phase, paso: x.next_step }));
    return { corr, plan, regs, rs, cond, trabajo: seccionTrabajo(root, db, plan), reporte: eventosBuilder(db), susp };
  });
  const b = e.builder;
  const identidad = `## 1. Identidad\n`
    + `- Proyecto \`${(require('crypto').createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex')).slice(0, 12)}\` · sesión ${e.session_generation} · plan ${e.plan ? e.plan.id + ' rev ' + e.plan.revision : '(sin plan)'}\n`
    + `- Roles: ${Object.entries(e.roles).map(([r, d]) => `${r} = ${d.host}`).join(' · ')} · revisores: ${['frontend', 'backend', 'negocio'].map((r) => `${r} = ${datos.regs[r] ? datos.regs[r].modality + (datos.regs[r].degradado ? ' (degradado)' : '') : 'SIN REGISTRAR'}`).join(' · ')}\n`
    + `- Constructor: ${b ? `sesión ${celda(root, b.session_id, 24)} (${b.state}) · vigilancia ${b.vigilancia.modo} [declarada]` : 'no conectado (akdd teams conectar-builder)'}\n\n`;
  const refs = e.referencias.length ? `- Referencias del dueño: ${e.referencias.map((r) => celda(root, r.url, 80)).join(' · ')}\n` : '';
  const control = `## 2. Control de campaña\n- Estado: **${e.campana.estado}**${e.campana.nota ? ' — ' + e.campana.nota : ''}${e.paused ? ' (pausa)' : ''}\n- Avance medido: ${e.avance.mensaje}\n`
    + (e.ejecucion ? `- Ejecución ${e.ejecucion.run_id}: ${e.ejecucion.ticks} pase(s) · último ${e.ejecucion.last_tick_at || '—'}\n` : '- Ejecución: no iniciada (teams: ejecutar)\n') + refs + '\n';
  const cp = datos.corr.activas;
  const sinTriar = datos.corr.por_triar ? `\n_${datos.corr.por_triar} hallazgo(s) de revisores esperan el triaje del director (no los atiende el constructor aún)._\n` : '';
  const notas = datos.corr.notas.length ? `\n_${datos.corr.notas.length} nota(s) no accionable(s) de revisores: no son tareas; el director puede promoverlas._\n` : '';
  const susp = datos.susp.length ? `\n**Tareas suspendidas por corrección:** ${datos.susp.map((x) => `${x.task_id} (corrección ${x.finding_id}${x.fase ? ', fase ' + celda(root, x.fase, 30) : ''}; siguiente paso: ${celda(root, x.paso, 80)})`).join(' · ')}\n` : '';
  const correcciones = `## 3. Correcciones pendientes (por prioridad — léelas PRIMERO, antes que cualquier tarea)\nOrden: BLOQUEANTE, riesgo, antigüedad. Atender una corrección suspende tu tarea en curso de forma segura (\`correcciones tomar\`) y se retoma exacta (\`correcciones reanudar\`).\n\n${tablaCorrecciones(root, cp)}${sinTriar}${notas}${susp}\n`;
  const trabajo = `## 4. Trabajo principal (sprints → fases → tareas)\n${datos.trabajo}`;
  const reporte = `## 5. Reporte de Cursor\n${lista(datos.reporte.map((x) => `#${x.seq} ${resumenEvento(root, x)} (${x.at})`), '- (sin reportes todavía)')}\n\n`;
  const filasRev = ['frontend', 'backend', 'negocio'].map((r) => {
    const reg = datos.regs[r];
    const fin = datos.rs.final && datos.rs.final[r] ? datos.rs.final[r] : { estado: 'SIN_VEREDICTO' };
    return `| ${r} | ${reg ? reg.modality + (reg.agent_id ? ' · ' + celda(root, reg.agent_id, 18) : '') : 'SIN REGISTRAR'} | ${fin.estado === 'VIGENTE' ? fin.verdict : fin.estado} |`;
  });
  const dirV = datos.cond ? (datos.cond.faltan.length ? `faltan para cerrar: ${datos.cond.faltan.map((f) => f.code + (f.role ? ':' + f.role : '')).join(', ')}` : 'cumple las condiciones de cierre') : 'sin plan';
  const revision = `## 6. Revisión front/back/negocio y veredicto del director\n| Rol | Modalidad | Veredicto sobre el sujeto FINAL |\n|---|---|---|\n${filasRev.join('\n')}\n\n- Veredicto del director: ${dirV}\n- Informes de revisores sin consumir: ${datos.rs.sin_consumir ? datos.rs.sin_consumir.length : 0}\n\n`;
  const humanos = `## 7. Pendientes humanos y tareas independientes\n${lista(e.pendientes_dueno.map((p) => `\`${p.id}\` ${celda(root, p.pregunta || p.reason_code, 140)} → bloquea ${p.bloquea.join(', ') || 'nada del plan'}`), '- (ninguno)')}\n`
    + `- Independientes listas: ${por(['READY']).map((t) => t.id).join(', ') || '(ninguna)'}\n\n`;
  const c = e.cierre;
  const cierreS = `## 8. Cierre y ACK final\n${c ? `- Cierre ${c.close_id}: **${c.state}** → ${c.final_status}${c.state === 'ACKED' ? ` · ACK ${c.ack_at} · vigilantes del constructor: ${c.stop_report && c.stop_report.estado}` : ''}${c.reopened_reason ? ' · reabierto por ' + celda(root, c.reopened_reason, 60) : ''}\n${c.not_done && c.not_done.length ? '- NO implementado: ' + c.not_done.map((x) => `${x.task_id || x.correccion}: ${celda(root, x.motivo, 80)}`).join(' · ') + '\n' : ''}` : '- Sin solicitud de cierre. La cola vacía no cierra: espera a los tres revisores sobre el sujeto final.\n'}\n`;
  const canal = cabecera + identidad + control + correcciones + trabajo + reporte + revision + humanos + cierreS + '---\n\n# Transporte (no editar)\n\n' + transporte;
  return { continuidad, canal, revision: e.ultimo_seq, humano: humanoPrevio };
}

/**
 * Regenera las dos vistas bajo bloqueo y con escritura atómica. Importa de forma conservadora un canal manual previo
 * (copia + conserva su texto neutralizado en las notas de la persona).
 */
function regenerar(root) {
  if (!tm.estado(root).inicializado) return { status: 'SIN_TEAMS' };
  const r = conBloqueo(root, () => {
    const fCanal = path.join(dirLegion(root), 'AUDITORIA-CURSOR.md');
    const manual = respaldarManual(root, fCanal);
    const v = render(root);
    if (!v) return { status: 'SIN_TEAMS' };
    let canal = v.canal;
    let importado = null;
    if (manual) {
      const c = candidatosManuales(manual.texto);
      const heredado = `Canal manual anterior (copia en ${manual.copia}${manual.truncado ? ', truncado' : ''}):\n${neutralizar(manual.texto)}`;
      canal = canal.replace(I.MARCA_HUMANA_INICIO + '\n' + (v.humano || '') + '\n', I.MARCA_HUMANA_INICIO + '\n' + [v.humano, heredado].filter(Boolean).join('\n\n') + '\n');
      importado = { copia: manual.copia, candidatos: c.candidatos.length, no_entendidas: c.no_entendidas.length, comando: c.candidatos.length ? 'akdd teams importar-canal --aplicar' : null };
    }
    escribirAtomico(path.join(dirLegion(root), 'CONTINUIDAD.md'), v.continuidad);
    escribirAtomico(fCanal, canal);
    return { status: 'OK', archivos: ['.legion/CONTINUIDAD.md', '.legion/AUDITORIA-CURSOR.md'], revision: v.revision, importado };
  });
  return r;
}

/**
 * Refresca el canal tras una operación que cambió estado (para que lo que ven Cursor y el director en el MD no quede viejo).
 * Fail-soft: la base es la fuente de verdad; si el canal está ocupado o falla, se regenera en el siguiente cambio.
 */
function refrescar(root) {
  try { return regenerar(root).status; } catch (e) { return 'ERROR:' + String(e.message).slice(0, 80); }
}

module.exports = { refrescar, regenerar, render, conBloqueo, importarManual, candidatosManuales, respaldarManual, MARCA_VISTA };

// CLI: akdd teams importar-canal [--aplicar] [--archivo=ruta]
if (require.main === module) {
  const { opt, pos } = U.parseArgs(process.argv.slice(2));
  const root = process.cwd();
  let r;
  try { r = pos[0] === 'importar' ? importarManual(root, { aplicar: !!opt.aplicar, archivo: opt.archivo || null }) : regenerar(root); } catch (e) { r = { status: e.code || 'ERROR', detalle: e.message }; }
  console.log(JSON.stringify(r, null, 2));
}
