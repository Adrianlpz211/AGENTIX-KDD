'use strict';

/**
 * Correcciones prioritarias de TEAMS (spec §9). La auditoría corre por detrás del avance ordinario; lo que encuentra entra aquí
 * y el constructor lo atiende PRIMERO, aunque tenga más trabajo principal pendiente. La cola de correcciones vacía NO significa
 * que la auditoría terminó: eso lo dicen los veredictos de los tres revisores (teams-revision.cjs), no esta tabla.
 *
 *   Estados: OPEN → ASSIGNED → IN_PROGRESS → IMPLEMENTED_PENDING_REVIEW → VERIFIED_RESOLVED
 *            REOPENED · BLOCKED_HUMAN · DISMISSED_WITH_REASON
 *
 *   · Un revisor informa: el hallazgo queda OPEN (sin triar). Solo el DIRECTOR lo publica (ASSIGNED), lo descarta con motivo o lo
 *     agrupa con otro ya existente conservando la procedencia. El constructor nunca se asigna a sí mismo ni cierra: no puede
 *     marcar VERIFIED_RESOLVED, DISMISSED ni REOPENED (la autorización es por rol declarado: el host no ofrece identidad
 *     criptográfica, y cada transición deja actor en el registro).
 *   · Prioridad: BLOQUEANTE siempre primero; entre el resto pesan riesgo, antigüedad (anti-inanición), reaperturas y recurrencia.
 *   · Suspensión segura: al tomar una corrección con una tarea principal en curso se guarda tarea, sprint/fase, siguiente paso,
 *     archivos con su hash y leases; al terminar, `reanudar` recalcula hashes y dice qué pruebas rehacer.
 *   · Una corrección con líneas movidas se reubica por símbolo/contenido; si no se encuentra, no se parchea a ciegas.
 *   · Fencing: tomar asigna un token nuevo; entregar con un token viejo o un lease vencido se rechaza (T12).
 */

const tm = require('./teams-manager.cjs');
const U = require('./teams-util.cjs');

const I = tm._i;
const SEVERIDADES = ['BLOQUEANTE', 'HALLAZGO', 'NOTA'];
const ESTADOS = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'IMPLEMENTED_PENDING_REVIEW', 'VERIFIED_RESOLVED', 'REOPENED', 'BLOCKED_HUMAN', 'DISMISSED_WITH_REASON'];
/** En vuelo: el trabajo de la corrección no terminó (o no está verificado). */
const EN_VUELO = new Set(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'IMPLEMENTED_PENDING_REVIEW', 'REOPENED']);
const FINALES = new Set(['VERIFIED_RESOLVED', 'DISMISSED_WITH_REASON']);
const PARA_CONSTRUCTOR = ['IN_PROGRESS', 'REOPENED', 'ASSIGNED'];
const PERMISOS = {
  añadir: ['director', 'revisor'], publicar: ['director'], descartar: ['director'], verificar: ['director'], reabrir: ['director', 'revisor'],
  tomar: ['builder'], entregar: ['builder'], soltar: ['builder', 'director'], bloquear: ['director', 'builder'], desbloquear: ['director'], promover: ['director'],
};
const AGING_HORAS_CAP = 400;

const noAutorizado = (accion, actor) => ({ status: 'NO_AUTORIZADO', accion, actor, detalle: `${accion} es del ${PERMISOS[accion].join(' o ')}; el constructor no cierra ni se asigna sus propias correcciones` });
/**
 * Autorización por rol DECLARADO más un candado de sesión: si la llamada trae la sesión del constructor conectado (--sesion), una
 * operación del director se rechaza aunque diga ser director. El host no ofrece identidad criptográfica: sin sesión, vale el rol
 * declarado (y cada transición deja actor en el registro). Es defensa en profundidad, no autenticación.
 */
function autorizar(root, accion, actor, session_id) {
  if (!permitido(accion, actor)) return noAutorizado(accion, actor);
  if (session_id && String(actor || '').split(':')[0] !== 'builder' && !PERMISOS[accion].includes('builder')) {
    const esBuilder = I.lectura2(root, (db) => { const b = db && db.get('SELECT session_id FROM teams_builder WHERE id = 1'); return !!b && b.session_id === session_id; });
    if (esBuilder) return noAutorizado(accion, 'builder (sesión ' + String(session_id).slice(0, 12) + ')');
  }
  return null;
}
const permitido = (accion, actor) => PERMISOS[accion].includes(String(actor || '').split(':')[0]);

function fila(f) {
  if (!f) return null;
  return {
    id: f.id, seq: f.seq, plan_id: f.plan_id, task_id: f.task_id, severity: f.severity, actionable: !!f.actionable, state: f.state, revision: f.revision,
    origin: f.origin, reviewed_hash: f.reviewed_hash, reviewed_revision: f.reviewed_revision, location: I.pj(f.location, {}), impact: f.impact,
    criterion: f.criterion, proposal: f.proposal, acceptance: f.acceptance, depends_on: I.pj(f.depends_on, []), scope: I.pj(f.scope, []),
    dedupe_key: f.dedupe_key, recurrence: f.recurrence, provenance: I.pj(f.provenance, []), assigned_to: f.assigned_to, owner_id: f.owner_id,
    fencing: f.fencing, base_hash: f.base_hash, resolved_hash: f.resolved_hash, lease_until: f.lease_until, reopen_count: f.reopen_count, reason: f.reason,
    duplicate_of: f.duplicate_of, decision_id: f.decision_id, escalated: !!f.escalated, created_at: f.created_at, updated_at: f.updated_at, published_at: f.published_at,
  };
}

const leer = (db, id) => fila(db.get('SELECT * FROM teams_findings WHERE id = ?', id));

function contador(db, clave) {
  const r = db.get('SELECT value FROM teams_meta WHERE key = ?', clave);
  const n = (r ? Number(r.value) : 0) + 1;
  db.run('INSERT OR REPLACE INTO teams_meta (key, value) VALUES (?, ?)', clave, String(n));
  return n;
}

/** Transición con registro (quién, cuándo, de qué a qué) y revisión +1. `cambios` solo acepta columnas conocidas. */
function mover(db, f, a, { actor, nota = null, cambios = {} } = {}) {
  const sets = ['state = ?', 'revision = revision + 1', 'updated_at = ?'];
  const vals = [a, I.ahoraIso()];
  for (const [k, v] of Object.entries(cambios)) { sets.push(k + ' = ?'); vals.push(v !== null && typeof v === 'object' ? I.js(v) : v); }
  db.run(`UPDATE teams_findings SET ${sets.join(', ')} WHERE id = ?`, ...vals, f.id);
  db.run('INSERT INTO teams_finding_log (finding_id, revision, from_state, to_state, actor, note, at) VALUES (?,?,?,?,?,?,?)', f.id, f.revision + 1, f.state, a, actor || null, nota, I.ahoraIso());
  return leer(db, f.id);
}

function sellos(root, v) { return U.limpiar(root, v, 800); }

// ─── prioridad ───────────────────────────────────────────────────────────────

/**
 * Puntaje de atención (mayor = antes). BLOQUEANTE nunca lo supera un HALLAZGO ni una NOTA, por mucha edad que tengan: el tope de
 * los bonos del resto queda por debajo de la base de BLOQUEANTE. La edad (anti-inanición) hace que un hallazgo viejo termine
 * pasando a uno nuevo de mayor riesgo; la recurrencia escala el origen que insiste.
 */
function prioridad(f, { ahora = Date.now(), riesgo = 'MEDIUM' } = {}) {
  const base = f.severity === 'BLOQUEANTE' ? 100000 : (f.severity === 'HALLAZGO' ? 10000 : 1000);
  const r = riesgo === 'HIGH' ? 300 : (riesgo === 'LOW' ? 100 : 200);
  const edadH = Math.min(AGING_HORAS_CAP, Math.max(0, (ahora - Date.parse(f.created_at || I.ahoraIso())) / 3600000));
  const bonos = r + edadH * 15 + Math.min(f.reopen_count || 0, 5) * 400 + Math.min((f.recurrence || 1) - 1, 5) * 300 + (f.escalated ? 500 : 0);
  return base + Math.min(bonos, base === 100000 ? 99000 : 8999);
}

function ordenar(db, lista, ahora = Date.now()) {
  const riesgoDe = new Map();
  const r = (f) => {
    if (!f.task_id) return 'MEDIUM';
    if (!riesgoDe.has(f.task_id)) { const t = I.tarea(db, f.task_id); riesgoDe.set(f.task_id, t ? ((t.effort_policy && t.effort_policy.tier) || t.risk || 'MEDIUM') : 'MEDIUM'); }
    return riesgoDe.get(f.task_id);
  };
  return lista.map((f) => Object.assign({}, f, { prioridad: prioridad(f, { ahora, riesgo: r(f) }) })).sort((a, b) => b.prioridad - a.prioridad || a.seq - b.seq);
}

// ─── alta, triaje y agrupación ───────────────────────────────────────────────

function ubicacion(root, loc, scope) {
  let l = typeof loc === 'string' ? { file: loc.replace(/:(\d+)$/, ''), line: Number((/:(\d+)$/.exec(loc) || [])[1]) || null } : Object.assign({}, loc || {});
  if (!l.file && scope.length) l.file = scope[0];
  if (l.file) {
    l.file = U.normRel(l.file);
    const abs = U.dentroDeRaiz(root, l.file);
    if (abs) {
      try {
        const txt = require('fs').readFileSync(abs, 'utf8');
        l.file_hash = l.file_hash || U.sha(txt);
        if (l.line && !l.snippet) l.snippet = (txt.split(/\r?\n/)[Number(l.line) - 1] || '').trim().slice(0, 200) || undefined;
      } catch { /* archivo aún inexistente: se guarda sin hash */ }
    }
  }
  if (l.symbol) l.symbol = String(l.symbol).slice(0, 80);
  return l;
}

/** Alta de una corrección o hallazgo. El director lo publica de una vez (ASSIGNED); un revisor lo deja OPEN para que el director lo triage. */
/**
 * Valida y normaliza una alta SIN tocar la base (para que un revisor pueda preparar varios hallazgos y registrarlos junto con su
 * veredicto en UNA transacción). Devuelve el objeto preparado o un { status } de rechazo.
 */
function preparar(root, o = {}) {
  const sev = String(o.severity || '').toUpperCase();
  if (!SEVERIDADES.includes(sev)) return { status: 'SEVERIDAD_INVALIDA', validas: SEVERIDADES };
  const actor = o.actor || 'director';
  if (!permitido('añadir', actor)) return noAutorizado('añadir', actor);
  const esDirector = actor.split(':')[0] === 'director';
  const accionable = sev !== 'NOTA' || o.accionable === true;
  const criterio = sellos(root, o.criterion);
  const aceptacion = sellos(root, o.acceptance);
  const propuesta = sellos(root, o.proposal);
  const faltan = [];
  if (accionable && !criterio) faltan.push('criterion');
  if (accionable && !aceptacion) faltan.push('acceptance');
  if (accionable && esDirector && o.publicar !== false && !propuesta) faltan.push('proposal');
  if (!criterio && !sellos(root, o.impact)) faltan.push('criterion|impact');
  if (faltan.length) return { status: 'FALTAN_CAMPOS', faltan };
  const scope = U.lista(o.scope).map(U.normRel);
  const loc = ubicacion(root, o.location, scope);
  const scopeFinal = scope.length ? scope : (loc.file ? [loc.file] : []);
  return { sev, actor, esDirector, accionable, criterio, aceptacion, propuesta, loc, scopeFinal, o };
}

/** Alta de una corrección o hallazgo. El director lo publica de una vez (ASSIGNED); un revisor lo deja OPEN para que el director lo triage. */
function añadir(root, o = {}) {
  const p = preparar(root, o);
  if (p.status) return p;
  return I.tx2(root, (db, despertar) => añadirEn(db, despertar, root, p));
}

/** Núcleo del alta, dentro de una transacción ya abierta (la de añadir, o la del informe de un revisor). */
function añadirEn(db, despertar, root, p) {
  const { sev, actor, esDirector, accionable, criterio, aceptacion, propuesta, loc, scopeFinal, o } = p;
  {
    if (o.event_id) {
      const previo = db.get('SELECT id FROM teams_findings WHERE event_id = ?', o.event_id);
      if (previo) return { status: 'DUPLICADO', id: previo.id, duplicado: true };
    }
    const tarea = o.task_id ? I.tarea(db, o.task_id) : null;
    if (o.task_id && !tarea) return { status: 'TAREA_DESCONOCIDA', task_id: o.task_id };
    const plan = tarea ? tarea.plan_id : ((db.get('SELECT id FROM teams_plans ORDER BY created_at DESC LIMIT 1') || {}).id || null);
    const clave = U.sha([o.task_id || '', criterio.toLowerCase().replace(/\s+/g, ' ').trim(), loc.symbol || loc.file || scopeFinal[0] || ''].join('|'));
    const procedencia = { origen: o.origin || actor, actor, at: I.ahoraIso(), reviewed_hash: o.reviewed_hash || null, nota: o.nota ? sellos(root, o.nota) : null };
    const previa = db.get('SELECT * FROM teams_findings WHERE dedupe_key = ? ORDER BY seq DESC LIMIT 1', clave);
    if (previa) {
      const p = fila(previa);
      if (EN_VUELO.has(p.state) || p.state === 'BLOCKED_HUMAN') {
        /* Mismo problema ya abierto: se agrupa (no se duplica la tarea del constructor) y se conserva quién más lo vio. */
        const recurrencia = p.recurrence + 1;
        const subir = SEVERIDADES.indexOf(sev) < SEVERIDADES.indexOf(p.severity);
        const m = mover(db, p, p.state, { actor, nota: 'duplicado agrupado', cambios: {
          recurrence: recurrencia, escalated: recurrencia >= 3 ? 1 : (p.escalated ? 1 : 0), severity: subir ? sev : p.severity,
          provenance: p.provenance.concat(procedencia),
        } });
        if (esDirector && p.state === 'OPEN' && accionable && o.publicar !== false && propuesta) {
          const pub = publicarEn(db, despertar, root, m, { actor, proposal: propuesta });
          return { status: 'DUPLICADO_AGRUPADO', id: p.id, recurrence: recurrencia, state: pub.state, escalated: !!pub.escalated };
        }
        return { status: 'DUPLICADO_AGRUPADO', id: p.id, recurrence: recurrencia, state: m.state, escalated: !!m.escalated };
      }
      if (p.state === 'VERIFIED_RESOLVED') {
        if (o.reviewed_hash && p.resolved_hash && o.reviewed_hash !== p.resolved_hash) {
          /* Evidencia nueva sobre la versión ya "arreglada": el problema volvió o el arreglo no alcanzó. */
          const m = mover(db, p, 'REOPENED', { actor, nota: 'reaparece sobre la versión corregida', cambios: {
            reopen_count: p.reopen_count + 1, recurrence: p.recurrence + 1, provenance: p.provenance.concat(procedencia), reviewed_hash: o.reviewed_hash, assigned_to: 'builder',
          } });
          publicar(db, despertar, 'CORRECTION_REOPENED', 'builder', m);
          avisarCierre(db, despertar, m);
          return { status: 'REABIERTO_POR_RECURRENCIA', id: p.id, state: m.state };
        }
        return { status: 'YA_RESUELTO', id: p.id };
      }
      if (p.state === 'DISMISSED_WITH_REASON' && !o.forzar) return { status: 'YA_DESCARTADO', id: p.id, razon: p.reason };
    }
    const id = 'F-' + String(contador(db, 'finding_seq')).padStart(4, '0');
    const estado = esDirector && accionable && o.publicar !== false ? 'ASSIGNED' : 'OPEN';
    const hash = o.reviewed_hash || (scopeFinal.length ? U.hashArchivos(root, scopeFinal) : null);
    db.run(`INSERT INTO teams_findings (id, seq, plan_id, task_id, severity, actionable, state, revision, origin, reviewed_hash, reviewed_revision, location, impact, criterion,
      proposal, acceptance, depends_on, scope, dedupe_key, recurrence, provenance, assigned_to, event_id, created_at, updated_at, published_at)
      VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
    id, Number(id.slice(2)), plan, o.task_id || null, sev, accionable ? 1 : 0, estado, o.origin || actor, hash, tarea ? tarea.revision : null,
    I.js(loc), sellos(root, o.impact), criterio, propuesta, aceptacion, I.js(U.lista(o.depends_on)), I.js(scopeFinal), clave, I.js([procedencia]),
    estado === 'ASSIGNED' ? 'builder' : null, o.event_id || null, I.ahoraIso(), I.ahoraIso(), estado === 'ASSIGNED' ? I.ahoraIso() : null);
    db.run('INSERT INTO teams_finding_log (finding_id, revision, from_state, to_state, actor, note, at) VALUES (?,?,?,?,?,?,?)', id, 1, null, estado, actor, 'alta', I.ahoraIso());
    const f = leer(db, id);
    if (estado === 'ASSIGNED') publicar(db, despertar, 'CORRECTION_PUBLISHED', 'builder', f);
    else I.publicar(db, despertar, { kind: 'FINDING_REPORTED', producer: actor.split(':')[0], target: 'director', task_id: f.task_id, payload: { id, severity: sev, accionable } });
    if (estado === 'ASSIGNED' && sev === 'BLOQUEANTE' && f.task_id) I.marcarDependientesRevalidar(db, despertar, f.task_id, 'HALLAZGO_BLOQUEANTE:' + id);
    if (accionable) avisarCierre(db, despertar, f);
    return { status: 'CREADA', id, state: estado, finding: f };
  }
}

function publicar(db, despertar, kind, target, f, extra = {}) {
  return I.publicar(db, despertar, { kind, producer: target === 'builder' ? 'director' : 'builder', target, task_id: f.task_id, payload: Object.assign({ id: f.id, severity: f.severity, state: f.state, revision: f.revision }, extra) });
}

/** Un hallazgo accionable que llega con un cierre solicitado lo reabre: no se descarta ni espera al ACK. */
function avisarCierre(db, despertar, f) {
  try { require('./teams-cierre.cjs').reabrirPorHallazgo(db, despertar, f); } catch { /* sin cierre en curso */ }
}

function publicarEn(db, despertar, root, f, { actor, proposal }) {
  const m = mover(db, f, 'ASSIGNED', { actor, nota: 'publicada por el director', cambios: { assigned_to: 'builder', published_at: I.ahoraIso(), proposal: proposal || f.proposal } });
  publicar(db, despertar, 'CORRECTION_PUBLISHED', 'builder', m);
  if (m.severity === 'BLOQUEANTE' && m.task_id) I.marcarDependientesRevalidar(db, despertar, m.task_id, 'HALLAZGO_BLOQUEANTE:' + m.id);
  avisarCierre(db, despertar, m);
  return m;
}

/** El director publica un hallazgo OPEN (con la solución que él decide) para que el constructor lo atienda. */
function publicarCorreccion(root, { id, proposal, actor = 'director', session_id = null }) {
  const na = autorizar(root, 'publicar', actor, session_id);
  if (na) return na;
  return I.tx2(root, (db, despertar) => {
    const f = leer(db, id);
    if (!f) return { status: 'CORRECCION_DESCONOCIDA' };
    if (f.state !== 'OPEN') return { status: 'TRANSICION_INVALIDA', estado: f.state };
    if (!f.actionable) return { status: 'NOTA_NO_ACCIONABLE', detalle: 'una nota no se convierte en corrección sin promoverla (correcciones promover)' };
    const sol = sellos(root, proposal) || f.proposal;
    if (!sol) return { status: 'FALTAN_CAMPOS', faltan: ['proposal'] };
    const m = publicarEn(db, despertar, root, f, { actor, proposal: sol });
    return { status: 'PUBLICADA', id, state: m.state };
  });
}

/** Una nota sigue siendo nota hasta que el director decide que merece corrección. */
function promover(root, { id, proposal, acceptance, actor = 'director', session_id = null }) {
  const na = autorizar(root, 'promover', actor, session_id);
  if (na) return na;
  return I.tx2(root, (db) => {
    const f = leer(db, id);
    if (!f) return { status: 'CORRECCION_DESCONOCIDA' };
    if (f.actionable) return { status: 'YA_ACCIONABLE' };
    const acc = sellos(root, acceptance) || f.acceptance;
    const sol = sellos(root, proposal) || f.proposal;
    if (!acc || !sol) return { status: 'FALTAN_CAMPOS', faltan: [!sol && 'proposal', !acc && 'acceptance'].filter(Boolean) };
    db.run('UPDATE teams_findings SET actionable = 1, proposal = ?, acceptance = ?, updated_at = ? WHERE id = ?', sol, acc, I.ahoraIso(), id);
    return { status: 'PROMOVIDA', id };
  });
}

/** Falso positivo o duplicado: se descarta CON motivo y se conserva la procedencia (en el otro hallazgo si es duplicado). */
function descartar(root, { id, razon, duplicate_of = null, actor = 'director', session_id = null }) {
  const na = autorizar(root, 'descartar', actor, session_id);
  if (na) return na;
  const motivo = sellos(root, razon);
  if (!motivo) return { status: 'SIN_MOTIVO', detalle: 'descartar exige la justificación' };
  return I.tx2(root, (db, despertar) => {
    const f = leer(db, id);
    if (!f) return { status: 'CORRECCION_DESCONOCIDA' };
    if (FINALES.has(f.state)) return { status: 'TRANSICION_INVALIDA', estado: f.state };
    let otro = null;
    if (duplicate_of) {
      otro = leer(db, duplicate_of);
      if (!otro || otro.id === f.id) return { status: 'DUPLICADO_DE_DESCONOCIDO', duplicate_of };
    }
    const m = mover(db, f, 'DISMISSED_WITH_REASON', { actor, nota: motivo, cambios: { reason: motivo, duplicate_of: otro ? otro.id : null } });
    if (otro) {
      db.run('UPDATE teams_findings SET provenance = ?, recurrence = recurrence + 1, updated_at = ? WHERE id = ?', I.js(otro.provenance.concat(f.provenance.map((p) => Object.assign({}, p, { via: f.id })))), I.ahoraIso(), otro.id);
    }
    I.publicar(db, despertar, { kind: 'CORRECTION_DISMISSED', producer: 'director', target: 'builder', task_id: f.task_id, payload: { id, razon: motivo, duplicate_of: otro ? otro.id : null } });
    return { status: 'DESCARTADA', id, state: m.state };
  });
}

// ─── el constructor: tomar, entregar, reanudar ───────────────────────────────

function sesionBuilderValida(db, session_id) {
  const b = db.get('SELECT session_id, state FROM teams_builder WHERE id = 1');
  if (!b || !b.session_id) return null; // sin builder registrado: transporte simulado o manual, no se exige
  return session_id && session_id === b.session_id ? null : { status: 'SESION_NO_REGISTRADA', detalle: 'la sesión no es el constructor conectado (T26): conecta el builder o usa su session_id' };
}

/**
 * Dueño del constructor cuando la CLI no lo trae: el único dueño con tareas asignadas (el adapter real usa su propio nombre, p. ej.
 * builder-md-session), o builder-cursor. La identidad que importa para aceptar es la SESIÓN registrada y el fencing, no este nombre.
 */
function ownerPorDefecto(db) {
  const o = db.all("SELECT DISTINCT owner_id FROM teams_tasks WHERE owner_id IS NOT NULL AND state IN ('READY','RUNNING','VERIFYING')").map((r) => r.owner_id);
  return o.length === 1 ? o[0] : 'builder-cursor';
}

/** Recursos del scope ocupados por OTRO dueño: dos escritores sobre el mismo recurso no se permiten. */
function recursosOcupados(db, recursos, owner) {
  return recursos.map(I.normalizarRecurso).filter((r) => db.get('SELECT 1 FROM teams_leases WHERE resource = ? AND owner_id != ?', r, owner));
}

function reclamarVencidas(db, ahora) {
  /* Una corrección IN_PROGRESS sin latido vigente (el constructor murió) vuelve a ASSIGNED para que otra sesión la tome con otro fencing. */
  for (const f of db.all("SELECT * FROM teams_findings WHERE state = 'IN_PROGRESS'").map(fila)) {
    if (f.lease_until && f.lease_until > ahora) continue;
    db.run('DELETE FROM teams_leases WHERE task_id = ?', 'COR:' + f.id);
    mover(db, f, 'ASSIGNED', { actor: 'sistema', nota: 'lease vencido: vuelve a la cola', cambios: { owner_id: null, lease_until: null } });
  }
}

/**
 * El constructor toma la corrección más prioritaria (o `id`). En un punto seguro: guarda la posición de su tarea principal (si la
 * tiene), valida que el sujeto revisado siga siendo el actual y reserva los recursos con un token de fencing nuevo.
 */
function tomar(root, { id = null, owner_id, session_id = null, siguiente_paso = null, actor = 'builder', ahora = Date.now() } = {}) {
  if (!permitido('tomar', actor)) return noAutorizado('tomar', actor);
  return I.tx2(root, (db, despertar) => {
    const malaSesion = sesionBuilderValida(db, session_id);
    if (malaSesion) return malaSesion;
    owner_id = owner_id || ownerPorDefecto(db);
    reclamarVencidas(db, ahora);
    let f;
    if (id) f = leer(db, id);
    else f = ordenar(db, db.all("SELECT * FROM teams_findings WHERE actionable = 1 AND state IN ('IN_PROGRESS','REOPENED','ASSIGNED') AND (owner_id IS NULL OR owner_id = ?)", owner_id).map(fila), ahora)[0];
    if (!f) return { status: id ? 'CORRECCION_DESCONOCIDA' : 'SIN_CORRECCIONES' };
    if (f.state === 'IN_PROGRESS' && f.owner_id === owner_id) return { status: 'TOMADA', duplicado: true, finding: f };
    if (!['ASSIGNED', 'REOPENED'].includes(f.state)) return { status: 'TRANSICION_INVALIDA', estado: f.state };
    /* Sujeto: ¿lo revisado sigue siendo lo que hay? Si no, se reubica por símbolo/contenido; si no aparece, no se toca a ciegas. */
    const hashAhora = f.scope.length ? U.hashArchivos(root, f.scope) : null;
    let reubicacion = null;
    if (f.reviewed_hash && hashAhora && f.reviewed_hash !== hashAhora) {
      reubicacion = f.location && f.location.file ? U.localizar(root, f.location) : { status: 'NO_ENCONTRADO' };
      if (!['REUBICADO', 'SIN_CAMBIOS'].includes(reubicacion.status)) {
        I.publicar(db, despertar, { kind: 'CORRECTION_STALE', producer: 'builder', target: 'director', task_id: f.task_id, payload: { id: f.id, reubicacion: reubicacion.status } });
        return { status: 'HASH_OBSOLETO_SIN_REUBICAR', id: f.id, detalle: 'el código cambió desde la revisión y la observación no se encontró: el director debe volver a revisar', reubicacion };
      }
    }
    const ocupados = recursosOcupados(db, f.scope, owner_id);
    if (ocupados.length) return { status: 'RECURSO_OCUPADO', recursos: ocupados };
    /* Suspensión segura de la tarea principal (si la hay): posición, archivos con hash y leases; su lease se renueva para que sobreviva. */
    let suspension = null;
    const principal = db.all("SELECT * FROM teams_tasks WHERE owner_id = ? AND state = 'RUNNING'", owner_id).map(I.fila)[0];
    if (principal) {
      /* Una tarea ya suspendida por otra corrección (el constructor atiende varias seguidas) conserva su posición original: no se pisa. */
      const yaSusp = db.get("SELECT * FROM teams_suspended WHERE task_id = ? AND state = 'SUSPENDED'", principal.id);
      if (!yaSusp && !siguiente_paso) return { status: 'FALTA_SIGUIENTE_PASO', task_id: principal.id, detalle: 'indica en qué paso quedó tu tarea principal para retomarla exacta (--siguiente-paso)' };
      if (!yaSusp) {
        const flujo = I.flujoDe(db, principal.id);
        const leases = db.all('SELECT resource, fencing, expires_ms FROM teams_leases WHERE task_id = ?', principal.id);
        db.run('INSERT INTO teams_suspended (finding_id, task_id, sprint_id, phase, next_step, files, leases, state, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          f.id, principal.id, principal.sprint_id, flujo ? flujo.phase : null, sellos(root, siguiente_paso), I.js(U.hashesPorArchivo(root, principal.allowed_files)), I.js(leases), 'SUSPENDED', I.ahoraIso());
        I.upsertFlujo(db, principal.id, { suspended: true });
        const lim = I.limitesDe(db, principal.plan_id);
        db.run('UPDATE teams_leases SET expires_ms = ? WHERE task_id = ?', ahora + lim.lease_ms, principal.id);
        suspension = { task_id: principal.id, sprint_id: principal.sprint_id, phase: flujo ? flujo.phase : null, siguiente_paso: sellos(root, siguiente_paso) };
      } else {
        suspension = { task_id: principal.id, sprint_id: yaSusp.sprint_id, phase: yaSusp.phase, siguiente_paso: yaSusp.next_step, ya_suspendida: true };
      }
    }
    const fencing = I.siguienteFencing(db);
    const lim = I.limitesDe(db, f.plan_id || (principal && principal.plan_id) || '');
    for (const r of f.scope.map(I.normalizarRecurso)) {
      if (db.get('SELECT 1 FROM teams_leases WHERE resource = ?', r)) continue; // ya es del mismo dueño (tarea principal suspendida): no se pisa su lease
      db.run('INSERT INTO teams_leases (resource, owner_id, task_id, fencing, expires_ms) VALUES (?,?,?,?,?)', r, owner_id, 'COR:' + f.id, fencing, ahora + lim.lease_ms);
    }
    const cambios = { owner_id, fencing, base_hash: hashAhora, lease_until: ahora + lim.lease_ms };
    if (reubicacion && reubicacion.status === 'REUBICADO') cambios.location = Object.assign({}, f.location, { line: reubicacion.line, relocated_from: f.location.line || null, relocated_by: reubicacion.por });
    const m = mover(db, f, 'IN_PROGRESS', { actor, nota: 'tomada por ' + owner_id, cambios });
    I.publicar(db, despertar, { kind: 'CORRECTION_TAKEN', producer: 'builder', target: 'director', task_id: f.task_id, payload: { id: f.id, fencing, suspendida: suspension && suspension.task_id } });
    return { status: 'TOMADA', finding: m, fencing, suspension, reubicacion };
  });
}

/** Corrección terminada por el constructor: queda IMPLEMENTED_PENDING_REVIEW. Nunca VERIFIED_RESOLVED: eso es del director con el revisor. */
function entregar(root, { id, owner_id, fencing = null, session_id = null, files = [], nota = null, event_id = null, actor = 'builder', ahora = Date.now() } = {}) {
  if (!permitido('entregar', actor)) return noAutorizado('entregar', actor);
  return I.tx2(root, (db, despertar) => {
    if (event_id) {
      const previo = db.get('SELECT payload FROM teams_events WHERE event_id = ?', event_id);
      if (previo) return Object.assign({ duplicado: true }, I.pj(previo.payload, {}).desenlace || { status: 'DUPLICADO' });
    }
    const f = leer(db, id);
    if (f && !owner_id) owner_id = f.owner_id;
    const cerrar = (d, tarea) => {
      if (event_id) I.publicar(db, despertar, { event_id, kind: 'CORRECTION_RESULT', producer: 'builder', target: 'director', task_id: f ? f.task_id : null, payload: { id, desenlace: d } });
      return d;
    };
    if (!f) return { status: 'CORRECCION_DESCONOCIDA' };
    const malaSesion = sesionBuilderValida(db, session_id);
    if (malaSesion) return cerrar(malaSesion);
    if (f.state !== 'IN_PROGRESS') return cerrar({ status: 'TRANSICION_INVALIDA', estado: f.state });
    if (f.owner_id !== owner_id) return cerrar({ status: 'RECHAZADO_LEASE_DE_OTRO' });
    if (fencing != null && Number(fencing) !== Number(f.fencing)) return cerrar({ status: 'RECHAZADO_FENCING_OBSOLETO', actual: f.fencing });
    const ls = db.all('SELECT * FROM teams_leases WHERE task_id = ?', 'COR:' + f.id);
    if (ls.some((l) => l.owner_id !== owner_id || Number(l.fencing) !== Number(f.fencing))) return cerrar({ status: 'RECHAZADO_FENCING_OBSOLETO' });
    if (ls.some((l) => l.expires_ms <= ahora) || (f.lease_until && f.lease_until <= ahora)) return cerrar({ status: 'RECHAZADO_LEASE_VENCIDO' });
    if (recursosOcupados(db, f.scope, owner_id).length) return cerrar({ status: 'RECHAZADO_LEASE_DE_OTRO' });
    const permitidos = new Set(f.scope.map(I.normalizarRecurso));
    const fuera = U.lista(files).map(I.normalizarRecurso).filter((x) => permitidos.size && !permitidos.has(x));
    if (fuera.length) return cerrar({ status: 'FUERA_DE_ALCANCE', fuera, detalle: 'la corrección tocó archivos fuera de su scope: se reporta, no se acepta' });
    const hashNuevo = f.scope.length ? U.hashArchivos(root, f.scope) : null;
    if (f.scope.length && hashNuevo === f.base_hash) return cerrar({ status: 'SIN_CAMBIOS', detalle: 'el código no cambió desde que tomaste la corrección' });
    db.run('DELETE FROM teams_leases WHERE task_id = ?', 'COR:' + f.id);
    const m = mover(db, f, 'IMPLEMENTED_PENDING_REVIEW', { actor, nota: nota ? sellos(root, nota) : 'entregada', cambios: { resolved_hash: hashNuevo } });
    /* El sujeto de la tarea afectada cambió: sus veredictos anteriores ya no valen (hash viejo) y su flujo apunta al hash nuevo. */
    const t = f.task_id ? I.tarea(db, f.task_id) : null;
    if (t && t.allowed_files.length) {
      I.upsertFlujo(db, t.id, { current_hash: U.hashArchivos(root, t.allowed_files) });
      const motivo = 'CORRECCION_ENTREGADA:' + f.id;
      /* Resolver una corrección puede invalidar lo que dependía de ese código: se marca para revalidar, no se da por bueno. */
      const tocados = new Set(f.scope.map(I.normalizarRecurso));
      const dependientes = new Set(I.descendientes(db, [t.id]));
      for (const o of I.tareas(db).filter((x) => x.id !== t.id && ['DONE_VERIFIED', 'VERIFYING', 'RUNNING'].includes(x.state) && (dependientes.has(x.id) || x.allowed_files.some((a) => tocados.has(I.normalizarRecurso(a)))))) {
        const fl = I.flujoDe(db, o.id);
        if (fl && !fl.revalidar.includes(motivo)) I.upsertFlujo(db, o.id, { revalidar: fl.revalidar.concat(motivo) });
      }
    }
    publicar(db, despertar, 'CORRECTION_DELIVERED', 'director', m, { resolved_hash: hashNuevo, files: U.lista(files).slice(0, 50) });
    return cerrar({ status: 'IMPLEMENTADA_PENDIENTE_REVISION', id, state: m.state, resolved_hash: hashNuevo, revision: m.revision });
  });
}

/**
 * Retoma la tarea principal suspendida por esta corrección: recalcula el hash de cada archivo, dice cuáles cambiaron y qué pruebas
 * rehacer, y deja el siguiente paso EXACTO que el constructor guardó. No cierra nada: solo restituye la posición.
 */
function reanudar(root, { id = null, task_id = null, owner_id = null, actor = 'builder' } = {}) {
  if (!permitido('tomar', actor)) return noAutorizado('tomar', actor);
  return I.tx2(root, (db, despertar) => {
    const s = id
      ? db.get("SELECT * FROM teams_suspended WHERE finding_id = ? AND state = 'SUSPENDED' ORDER BY id DESC LIMIT 1", id)
      : db.get("SELECT * FROM teams_suspended WHERE state = 'SUSPENDED' AND (task_id = ? OR ? IS NULL) ORDER BY id DESC LIMIT 1", task_id, task_id);
    if (!s) return { status: 'NADA_QUE_REANUDAR' };
    const f = leer(db, s.finding_id);
    const enCurso = db.all("SELECT id FROM teams_findings WHERE state = 'IN_PROGRESS' AND (owner_id = ? OR ? IS NULL)", owner_id, owner_id).map((x) => x.id);
    if (enCurso.length) return { status: 'CORRECCION_EN_CURSO', id: enCurso[0], pendientes: enCurso, detalle: 'entrega la corrección (o suéltala) antes de reanudar la tarea principal' };
    const t = I.tarea(db, s.task_id);
    if (!t) { db.run("UPDATE teams_suspended SET state = 'HUERFANA', resumed_at = ? WHERE id = ?", I.ahoraIso(), s.id); return { status: 'TAREA_DESCONOCIDA', task_id: s.task_id }; }
    if (owner_id && t.owner_id && t.owner_id !== owner_id) return { status: 'TAREA_DE_OTRO', owner_id: t.owner_id };
    const antes = I.pj(s.files, []);
    const ahoraHashes = U.hashesPorArchivo(root, antes.map((a) => a.file));
    const cambios = ahoraHashes.filter((a) => { const p = antes.find((x) => x.file === a.file); return !p || p.hash !== a.hash; }).map((a) => a.file);
    const informe = {
      status: 'REANUDADA', task_id: t.id, sprint_id: s.sprint_id, phase: s.phase, siguiente_paso: s.next_step, state_tarea: t.state,
      archivos: ahoraHashes.map((a) => ({ file: a.file, hash_antes: (antes.find((x) => x.file === a.file) || {}).hash || null, hash_ahora: a.hash, cambiado: cambios.includes(a.file) })),
      // Si la corrección tocó archivos de la tarea principal, sus pruebas ya no valen: se rehacen antes de entregar.
      pruebas_afectadas: cambios.length ? ['relevant-check', 'affected-tests'] : [],
      leases_guardados: I.pj(s.leases, []).length,
    };
    db.run("UPDATE teams_suspended SET state = 'REANUDADA', resumed_at = ?, resume_report = ? WHERE id = ?", I.ahoraIso(), I.js(informe), s.id);
    const fl = I.flujoDe(db, t.id);
    const parches = { suspended: false };
    if (cambios.length && f) { const m = 'CORRECCION_TOCO_ARCHIVOS:' + f.id; if (!(fl && fl.revalidar.includes(m))) parches.revalidar = (fl ? fl.revalidar : []).concat(m); }
    I.upsertFlujo(db, t.id, parches);
    const lim = I.limitesDe(db, t.plan_id);
    db.run('UPDATE teams_leases SET expires_ms = ? WHERE task_id = ?', Date.now() + lim.lease_ms, t.id);
    return informe;
  });
}

/** Latido de una corrección en curso: renueva su lease. Un fencing viejo no renueva nada. */
function latido(root, { id, owner_id, fencing, ahora = Date.now() }) {
  return I.tx2(root, (db) => {
    const f = leer(db, id);
    if (!f || f.state !== 'IN_PROGRESS') return { status: 'NO_EN_CURSO' };
    if (!owner_id) owner_id = f.owner_id;
    if (f.owner_id !== owner_id || Number(f.fencing) !== Number(fencing)) return { status: 'FENCING_OBSOLETO' };
    const lim = I.limitesDe(db, f.plan_id || '');
    db.run('UPDATE teams_leases SET expires_ms = ? WHERE task_id = ?', ahora + lim.lease_ms, 'COR:' + f.id);
    db.run('UPDATE teams_findings SET lease_until = ? WHERE id = ?', ahora + lim.lease_ms, f.id);
    return { status: 'OK' };
  });
}

/** El constructor suelta una corrección que no puede atender (o el director la retira de su dueño): vuelve a la cola. */
function soltar(root, { id, owner_id = null, motivo = null, actor = 'builder' }) {
  if (!permitido('soltar', actor)) return noAutorizado('soltar', actor);
  return I.tx2(root, (db) => {
    const f = leer(db, id);
    if (!f) return { status: 'CORRECCION_DESCONOCIDA' };
    if (f.state !== 'IN_PROGRESS') return { status: 'TRANSICION_INVALIDA', estado: f.state };
    if (actor === 'builder' && owner_id && f.owner_id !== owner_id) return { status: 'RECHAZADO_LEASE_DE_OTRO' };
    db.run('DELETE FROM teams_leases WHERE task_id = ?', 'COR:' + f.id);
    mover(db, f, 'ASSIGNED', { actor, nota: motivo ? sellos(root, motivo) : 'soltada', cambios: { owner_id: null } });
    return { status: 'SOLTADA', id };
  });
}

// ─── el director: verificar, reabrir, bloquear ───────────────────────────────

/**
 * Cierra la corrección: VERIFIED_RESOLVED. Solo el director, y solo con el veredicto PASS del revisor de origen sobre el hash que el
 * constructor entregó (revisión dirigida: para una corrección pequeña no hace falta la triple auditoría extensa; la final sí exige los tres).
 */
function verificar(root, { id, actor = 'director', expected_revision = null, evidencia = null, session_id = null } = {}) {
  const na = autorizar(root, 'verificar', actor, session_id);
  if (na) return na;
  return I.tx2(root, (db, despertar) => {
    const f = leer(db, id);
    if (!f) return { status: 'CORRECCION_DESCONOCIDA' };
    if (expected_revision != null && Number(expected_revision) !== f.revision) return { status: 'REVISION_OBSOLETA', actual: f.revision };
    if (f.state !== 'IMPLEMENTED_PENDING_REVIEW') return { status: 'TRANSICION_INVALIDA', estado: f.state };
    const hashAhora = f.scope.length ? U.hashArchivos(root, f.scope) : null;
    if (f.scope.length && hashAhora !== f.resolved_hash) return { status: 'HASH_CAMBIO_DESPUES_DE_ENTREGAR', detalle: 'el código cambió tras la entrega: hay que revisar de nuevo', resolved_hash: f.resolved_hash, actual: hashAhora };
    const rol = String(f.origin || '').startsWith('revisor:') ? f.origin.split(':')[1] : null;
    let revision = null;
    if (rol) {
      revision = db.get("SELECT id, verdict FROM teams_reviews WHERE finding_id = ? AND role = ? AND subject_hash = ? ORDER BY id DESC LIMIT 1", f.id, rol, f.resolved_hash);
      if (!revision) return { status: 'ESPERA_REVISION_DIRIGIDA', rol, detalle: `falta el veredicto del revisor ${rol} sobre el hash entregado`, resolved_hash: f.resolved_hash };
      if (revision.verdict !== 'PASS') return { status: 'REVISION_NO_APROBO', rol, verdict: revision.verdict };
    }
    const m = mover(db, f, 'VERIFIED_RESOLVED', { actor, nota: evidencia ? sellos(root, evidencia) : (revision ? 'PASS de ' + rol : 'verificada por el director') });
    if (revision) db.run('UPDATE teams_reviews SET consumed = 1 WHERE id = ?', revision.id);
    publicar(db, despertar, 'CORRECTION_VERIFIED', 'builder', m);
    return { status: 'VERIFICADA', id, state: m.state };
  });
}

/** Reabre con evidencia nueva (revisor o director). Sube prioridad por reapertura; el constructor lo vuelve a ver primero. */
function reabrir(root, o) {
  const na = autorizar(root, 'reabrir', o.actor || 'director', o.session_id);
  if (na) return na;
  return I.tx2(root, (db, despertar) => reabrirEn(db, despertar, root, o));
}

function reabrirEn(db, despertar, root, { id, razon, evidencia = null, reviewed_hash = null, actor = 'director' }) {
  const motivo = sellos(root, razon);
  if (!motivo) return { status: 'SIN_MOTIVO', detalle: 'reabrir exige la razón y la nueva evidencia' };
  const f = leer(db, id);
  if (!f) return { status: 'CORRECCION_DESCONOCIDA' };
  if (!['IMPLEMENTED_PENDING_REVIEW', 'VERIFIED_RESOLVED', 'DISMISSED_WITH_REASON'].includes(f.state)) return { status: 'TRANSICION_INVALIDA', estado: f.state };
  const m = mover(db, f, 'REOPENED', { actor, nota: motivo, cambios: {
    reopen_count: f.reopen_count + 1, owner_id: null, assigned_to: 'builder', reviewed_hash: reviewed_hash || f.reviewed_hash,
    provenance: f.provenance.concat({ origen: actor, actor, at: I.ahoraIso(), reabierta: true, nota: motivo, evidencia: evidencia ? sellos(root, evidencia) : null }),
  } });
  publicar(db, despertar, 'CORRECTION_REOPENED', 'builder', m);
  avisarCierre(db, despertar, m);
  return { status: 'REABIERTA', id, state: m.state, reopen_count: m.reopen_count };
}

/** Negocio ambiguo: no se decide por conveniencia. Queda la pregunta y las alternativas, y el trabajo independiente sigue. */
function bloquear(root, { id, pregunta, alternativas = [], actor = 'director' }) {
  if (!permitido('bloquear', actor)) return noAutorizado('bloquear', actor);
  const q = sellos(root, pregunta);
  if (!q) return { status: 'SIN_PREGUNTA' };
  return I.tx2(root, (db, despertar) => {
    const f = leer(db, id);
    if (!f) return { status: 'CORRECCION_DESCONOCIDA' };
    if (FINALES.has(f.state)) return { status: 'TRANSICION_INVALIDA', estado: f.state };
    const alts = U.lista(alternativas).map((a) => sellos(root, a));
    const stop = I.abrirStop(db, despertar, {
      reason_code: 'CORRECCION_NEGOCIO', scope: f.task_id ? 'TASK' : 'CHANNEL', task_id: f.task_id || null, resources: f.scope, decision_required: true,
      evidence: [{ kind: 'finding', id: f.id }], question: alts.length ? `${q} Alternativas: ${alts.join(' | ')}` : q,
    });
    db.run('DELETE FROM teams_leases WHERE task_id = ?', 'COR:' + f.id);
    mover(db, f, 'BLOCKED_HUMAN', { actor, nota: q, cambios: { decision_id: stop.id, owner_id: null } });
    return { status: 'BLOQUEADA_POR_DECISION', id, decision_id: stop.id };
  });
}

/** Con la decisión de la persona ya resuelta (teams resolver), la corrección vuelve a la cola del constructor. */
function desbloquear(root, { id, actor = 'director', session_id = null }) {
  const na = autorizar(root, 'desbloquear', actor, session_id);
  if (na) return na;
  return I.tx2(root, (db, despertar) => {
    const f = leer(db, id);
    if (!f) return { status: 'CORRECCION_DESCONOCIDA' };
    if (f.state !== 'BLOCKED_HUMAN') return { status: 'TRANSICION_INVALIDA', estado: f.state };
    const d = f.decision_id ? db.get('SELECT resolved_at, decision FROM teams_decisions WHERE id = ?', f.decision_id) : null;
    if (d && !d.resolved_at) return { status: 'DECISION_PENDIENTE', decision_id: f.decision_id };
    const m = mover(db, f, 'ASSIGNED', { actor, nota: d ? 'decisión: ' + sellos(root, d.decision) : 'desbloqueada', cambios: { assigned_to: 'builder' } });
    publicar(db, despertar, 'CORRECTION_PUBLISHED', 'builder', m);
    return { status: 'DESBLOQUEADA', id, state: m.state };
  });
}

// ─── consulta ────────────────────────────────────────────────────────────────

/** Reubica la observación en el archivo actual sin tocar nada (el constructor lo consulta antes de editar). */
function reubicar(root, { id }) {
  return I.lectura2(root, (db) => {
    if (!db) return { status: 'MIGRACION_PENDIENTE' };
    const f = leer(db, id);
    if (!f) return { status: 'CORRECCION_DESCONOCIDA' };
    return Object.assign({ id, ubicacion_original: f.location }, U.localizar(root, f.location));
  });
}

function listar(root, { estado = null, task_id = null, activas = false, ahora = Date.now() } = {}) {
  return I.lectura2(root, (db) => {
    if (!db) return [];
    let lista = db.all('SELECT * FROM teams_findings ORDER BY seq').map(fila);
    if (estado) lista = lista.filter((f) => f.state === estado);
    if (task_id) lista = lista.filter((f) => f.task_id === task_id);
    if (activas) lista = lista.filter((f) => f.actionable && (EN_VUELO.has(f.state) || f.state === 'BLOCKED_HUMAN'));
    return ordenar(db, lista, ahora);
  });
}

/** Lo que el constructor atiende ahora: corrección accionable, ya publicada, en el orden de prioridad (BLOQUEANTE primero). */
function siguiente(root, { owner_id = null, ahora = Date.now() } = {}) {
  return I.lectura2(root, (db) => {
    if (!db) return null;
    const lista = db.all("SELECT * FROM teams_findings WHERE actionable = 1 AND state IN ('IN_PROGRESS','REOPENED','ASSIGNED')").map(fila)
      .filter((f) => f.state !== 'IN_PROGRESS' || !owner_id || f.owner_id === owner_id || !f.owner_id);
    return ordenar(db, lista, ahora)[0] || null;
  });
}


/** Tareas principales suspendidas por una corrección y aún sin reanudar (el constructor las retoma con `reanudar`). */
function suspendidas(root) {
  return I.lectura2(root, (db) => (db ? db.all("SELECT * FROM teams_suspended WHERE state = 'SUSPENDED' ORDER BY id").map((x) => ({
    finding_id: x.finding_id, task_id: x.task_id, sprint_id: x.sprint_id, phase: x.phase, siguiente_paso: x.next_step, desde: x.created_at })) : []));
}

function resumen(db, ahora = Date.now()) {
  if (!db) return { disponible: false };
  const todas = db.all('SELECT * FROM teams_findings ORDER BY seq').map(fila);
  const cuenta = Object.fromEntries(ESTADOS.map((e) => [e, 0]));
  for (const f of todas) cuenta[f.state] += 1;
  const activas = ordenar(db, todas.filter((f) => f.actionable && ['ASSIGNED', 'IN_PROGRESS', 'IMPLEMENTED_PENDING_REVIEW', 'REOPENED', 'BLOCKED_HUMAN'].includes(f.state)), ahora);
  return {
    disponible: true, por_estado: cuenta, total: todas.length,
    por_triar: todas.filter((f) => f.actionable && f.state === 'OPEN').length,
    activas, notas: todas.filter((f) => !f.actionable && f.state === 'OPEN'),
    abiertas_accionables: todas.filter((f) => f.actionable && (EN_VUELO.has(f.state))).length,
    bloqueadas_humano: todas.filter((f) => f.state === 'BLOCKED_HUMAN').length,
  };
}

module.exports = {
  autorizar, reclamarVencidasEn: reclamarVencidas, SEVERIDADES, ESTADOS, EN_VUELO, FINALES, prioridad, ordenar, resumen, leer, fila,
  preparar, añadirEn, reabrirEn, añadir, publicarCorreccion, promover, descartar, tomar, entregar, reanudar, latido, soltar, verificar, reabrir, bloquear, desbloquear, reubicar, listar, siguiente, suspendidas,
};

// ─── CLI: akdd teams correcciones <sub> ──────────────────────────────────────
if (require.main === module) {
  const { opt, pos } = U.parseArgs(process.argv.slice(2));
  const [sub] = pos;
  const root = process.cwd();
  const comun = { actor: opt.como, id: opt.id || pos[1] };
  const quitar = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  let r;
  try {
    switch (sub) {
      case 'añadir': case 'anadir': r = añadir(root, quitar({ task_id: opt.tarea, severity: opt.severidad, origin: opt.origen, criterion: opt.criterio, impact: opt.impacto, proposal: opt.solucion, acceptance: opt.aceptacion, location: opt.ubicacion, scope: opt.archivos, nota: opt.nota, reviewed_hash: opt.hash, actor: opt.como || 'director', publicar: opt.sin_publicar ? false : undefined, event_id: opt.evento })); break;
      case 'publicar': r = publicarCorreccion(root, quitar({ id: comun.id, proposal: opt.solucion, actor: opt.como || 'director', session_id: opt.sesion })); break;
      case 'promover': r = promover(root, quitar({ id: comun.id, proposal: opt.solucion, acceptance: opt.aceptacion, actor: opt.como || 'director' })); break;
      case 'descartar': r = descartar(root, quitar({ id: comun.id, razon: opt.razon, duplicate_of: opt.duplicado_de, actor: opt.como || 'director', session_id: opt.sesion })); break;
      case 'tomar': r = tomar(root, quitar({ id: opt.id || pos[1] || null, owner_id: opt.dueno, session_id: opt.sesion, siguiente_paso: opt.siguiente_paso, actor: opt.como || 'builder' })); break;
      case 'entregar': r = entregar(root, quitar({ id: comun.id, owner_id: opt.dueno, fencing: opt.fencing, session_id: opt.sesion, files: opt.archivos, nota: opt.nota, event_id: opt.evento, actor: opt.como || 'builder' })); break;
      case 'latido': r = latido(root, quitar({ id: comun.id, owner_id: opt.dueno, fencing: opt.fencing })); break;
      case 'suspendidas': r = suspendidas(root); break;
      case 'reanudar': r = reanudar(root, quitar({ id: opt.id || pos[1], task_id: opt.tarea, owner_id: opt.dueno, actor: opt.como || 'builder' })); break;
      case 'soltar': r = soltar(root, quitar({ id: comun.id, owner_id: opt.dueno, motivo: opt.motivo, actor: opt.como || 'builder' })); break;
      case 'verificar': r = verificar(root, quitar({ id: comun.id, expected_revision: opt.revision, evidencia: opt.evidencia, actor: opt.como || 'director', session_id: opt.sesion })); break;
      case 'reabrir': r = reabrir(root, quitar({ id: comun.id, razon: opt.razon, evidencia: opt.evidencia, reviewed_hash: opt.hash, actor: opt.como || 'director', session_id: opt.sesion })); break;
      case 'bloquear': r = bloquear(root, quitar({ id: comun.id, pregunta: opt.pregunta, alternativas: opt.alternativas, actor: opt.como || 'director' })); break;
      case 'desbloquear': r = desbloquear(root, quitar({ id: comun.id, actor: opt.como || 'director', session_id: opt.sesion })); break;
      case 'reubicar': r = reubicar(root, { id: comun.id }); break;
      case 'siguiente': r = siguiente(root, { owner_id: opt.dueno || null }); break;
      case 'listar': default: r = listar(root, quitar({ estado: opt.estado, task_id: opt.tarea, activas: opt.activas ? true : undefined })); break;
    }
  } catch (e) { r = { status: e.code || 'ERROR', detalle: e.message }; }
  if (!['listar', 'siguiente', 'reubicar', 'suspendidas', undefined].includes(sub)) require('./teams-canal.cjs').refrescar(root);
  console.log(JSON.stringify(r, null, 2));
  if (r && /INVALIDO|DESCONOCID|ERROR|NO_AUTORIZADO|MIGRACION_PENDIENTE|FALTAN|SIN_/.test(String(r.status || ''))) process.exitCode = 1;
}
