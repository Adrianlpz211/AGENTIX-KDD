#!/usr/bin/env node
'use strict';
/* ENGRANAJES — Agentix como un reloj, no como piezas sueltas.
 *
 * Cada mecanismo de Agentix (registro de commits, TEAMS, contratos, memoria que aprende, motor creativo, ganchos, servicios…) es un engranaje. Antes cada uno fallaba
 * en silencio (`catch {}`, «fail-soft») y nadie veía el conjunto: en una semana aparecieron, descubiertos a mano, contratos parados 10 días por un archivo de 122 MB,
 * el motor creativo sin datos desde agosto, 24 cierres fallidos por base ocupada en un log que nadie lee, 68 archivos sin commit durante 3 días y un control con 62 alarmas falsas.
 *
 * Este auditor comprueba cada engranaje contra EVIDENCIA (git, la base, los archivos de estado) y dice cuál no gira, con el dato. Reglas:
 *   · solo lee: nunca toca el proyecto;
 *   · un engranaje que no se puede comprobar sale SIN_DATO con su causa — jamás «OK» por no haber podido mirar;
 *   · si una comprobación revienta, ese engranaje sale ROTO con el error: el auditor tampoco falla en silencio;
 *   · cada engranaje trae QUÉ HACER (acción concreta), no solo el síntoma.
 *
 *   node .agentic/grafo/engranajes.cjs [--json] [--dias=N]        (akdd engranajes)
 *   Sale con código 1 si algún engranaje está ROTO. El resultado queda en .agentic/_engranajes.json (lo lee el semáforo de TEAMS).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const OK = 'OK', ATENCION = 'ATENCION', ROTO = 'ROTO', SIN_DATO = 'SIN_DATO';
const ARCHIVO = (root) => path.join(root, '.agentic', '_engranajes.json');
const DIA = 86400000;

const git = (root, args) => {
  try {
    const r = spawnSync('git', ['-c', 'safe.directory=*', ...args], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  } catch { return null; }
};
const leerJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const hace = (ms) => { const m = Math.round(ms / 60000); return m < 90 ? m + ' min' : m < 2880 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' días'; };

function abrirBase(root) {
  const p = path.join(root, '.agentic', 'memoria.db');
  if (!fs.existsSync(p)) return { db: null, causa: 'no existe .agentic/memoria.db' };
  try { return { db: require('./db-adapter.cjs').openReadOnly(p, { busyTimeout: 3000 }) }; } catch (e) { return { db: null, causa: 'no se pudo abrir la base: ' + String((e && e.message) || e).slice(0, 100) }; }
}
const consulta = (db, sql, params) => { try { return params ? db.all(sql, params) : db.all(sql); } catch { return null; } };

/** Cada comprobación devuelve { estado, dato, hacer? }. Si revienta, ese engranaje sale ROTO con el error. */
const COMPROBACIONES = [
  { id: 'commits-a-ciclos', nombre: 'Commits → ciclos en la base', fn: (c) => {
    const k = c.cobertura.commits;
    if (!k || k.en_git == null) return { estado: SIN_DATO, dato: 'sin git utilizable: no se puede medir' };
    if (!k.en_git) return { estado: OK, dato: 'sin commits en la ventana' };
    const p = k.pct == null ? Math.round(100 * k.con_ciclo / k.en_git) : k.pct;
    const dato = `${k.con_ciclo} de ${k.en_git} commits tienen ciclo (${p} %)` + (k.sin_ciclo && k.sin_ciclo.length ? ` · sin ciclo: ${k.sin_ciclo.slice(0, 5).join(', ')}` : '') + (k.abandonados_por_el_hook ? ` · abandonados por el hook: ${k.abandonados_por_el_hook}` : '');
    const hacer = 'akdd reconciliar --aplicar (los registra retroactivamente) y revisa por qué el hook de commit no los tomó';
    if (p < 80 || (k.sin_ciclo || []).length >= 5) return { estado: ROTO, dato, hacer };
    return p < 100 || k.abandonados_por_el_hook ? { estado: ATENCION, dato, hacer } : { estado: OK, dato };
  } },
  { id: 'teams-a-registro', nombre: 'TEAMS: tarea aceptada → ciclo registrado y verificado', fn: (c) => {
    const t = c.cobertura.teams;
    if (!t) return { estado: fs.existsSync(path.join(c.root, '.legion', 'AUDITORIA-CURSOR.md')) ? SIN_DATO : OK, dato: 'sin registro de TEAMS en este proyecto' };
    const dato = `${t.registradas_y_verificadas} verificadas de ${t.en_registro}` + (t.pendientes ? ` · ${t.pendientes} pendientes` : '');
    const hacer = 'teams.cjs observar --reintentar; si persiste, mira la causa de cada pendiente con teams.cjs estado';
    if (t.pendientes > 3) return { estado: ROTO, dato, hacer };
    return t.pendientes ? { estado: ATENCION, dato, hacer } : { estado: OK, dato };
  } },
  { id: 'trabajo-sin-commit', nombre: 'Trabajo editado pero sin commit (aún no existe para Agentix)', fn: (c) => {
    const s = c.cobertura.sin_commit;
    const vivo = require('./cobertura.cjs').archivosSinCommit(c.root);
    if (vivo == null) return { estado: SIN_DATO, dato: 'sin git utilizable' };
    if (!vivo.length) return { estado: OK, dato: 'todo lo editado está commiteado' };
    const desde = s && s.desde ? Date.now() - Date.parse(s.desde) : null;
    const dato = `${vivo.length} archivo(s) sin commit` + (desde != null ? ` desde hace ${hace(desde)}` : '');
    const hacer = 'commitear lo que esté terminado: el commit es lo que lo deja en la memoria, la línea de tiempo y el tablero';
    if (vivo.length > 100 || (desde != null && desde > 3 * DIA)) return { estado: ROTO, dato, hacer };
    return desde != null && desde > DIA ? { estado: ATENCION, dato, hacer } : { estado: OK, dato };
  } },
  { id: 'calidad-del-registro', nombre: 'Calidad de lo registrado (ciclos con pruebas, duración y módulo)', fn: (c) => {
    const q = c.cobertura.calidad || {}; const pobres = [];
    for (const o of ['commit', 'teams', 'aa/manual']) {
      const g = q[o]; if (!g || !g.ciclos) continue;
      for (const campo of ['con pruebas', 'duración medida']) if (g[campo] != null && g[campo] < 40) pobres.push(`${o}: ${campo} ${g[campo]} %`);
    }
    if (!pobres.length) return { estado: OK, dato: 'campos clave llenos en la mayoría de los ciclos' };
    return { estado: ATENCION, dato: 'ciclos casi vacíos → ' + pobres.slice(0, 4).join(' · '), hacer: 'los contratos y el tiempo salen de esos campos: revisa que el TDD gate corra las pruebas y que el cierre del ciclo pase --tests' };
  } },
  { id: 'contratos', nombre: 'Contratos: nacen cuando las pruebas pasan verificadas', fn: (c) => {
    if (!c.db) return { estado: SIN_DATO, dato: c.causaBase };
    const pb = consulta(c.db, 'SELECT count(*) n, max(last_verified_at) u FROM protected_behaviors');
    if (!pb) return { estado: SIN_DATO, dato: 'la base no tiene protected_behaviors (esquema sin migrar)', hacer: 'akdd doctor' };
    const n = pb[0].n; const ult = pb[0].u ? Date.parse(String(pb[0].u).replace(' ', 'T') + 'Z') : null;
    const cic = consulta(c.db, 'SELECT count(*) n FROM ciclos WHERE tests_pasando > 0 AND fecha_inicio >= ?', [new Date(Date.now() - 7 * DIA).toISOString().slice(0, 19).replace('T', ' ')]);
    const conPruebas = cic ? cic[0].n : 0;
    const edad = ult ? Date.now() - ult : null;
    const dato = `${n} contratos` + (edad != null ? `, el último registrado hace ${hace(edad)}` : '') + `; ${conPruebas} ciclos con pruebas en 7 días`;
    const hacer = 'mira la verificación TDD (siguiente engranaje): sin PASS verificado no nace ningún contrato';
    if (conPruebas >= 5 && edad != null && edad > 7 * DIA) return { estado: ROTO, dato, hacer };
    if (conPruebas >= 3 && edad != null && edad > 3 * DIA) return { estado: ATENCION, dato, hacer };
    return { estado: OK, dato };
  } },
  { id: 'verificacion-tdd', nombre: 'Verificación TDD al cerrar el ciclo (huella del código + pruebas)', fn: (c) => {
    const st = leerJson(path.join(c.root, '.agentic', '_tdd_state.json'));
    const stops = c.db ? consulta(c.db, "SELECT detalle FROM gate_events WHERE gate='tdd' AND verdict='STOP' AND ts >= ? ORDER BY id DESC LIMIT 50", [new Date(Date.now() - DIA).toISOString().slice(0, 19).replace('T', ' ')]) : null;
    const motivos = {}; for (const r of stops || []) { let m = 'sin motivo'; try { m = JSON.parse(r.detalle).motivo || m; } catch { /* detalle no JSON */ } motivos[m] = (motivos[m] || 0) + 1; }
    const lista = Object.entries(motivos).map(([k, v]) => `${k} ×${v}`).join(', ');
    const incompleta = st && st.source_check && /incompleta/i.test(String(st.source_check.motivo || ''));
    const dato = (st ? `último estado: ${st.status || '?'}${st.reason_code ? ' (' + st.reason_code + ')' : ''}` : 'sin estado de TDD') + (lista ? ` · STOPs en 24 h: ${lista}` : '');
    if (incompleta) return { estado: ROTO, dato: dato + ' · ' + st.source_check.motivo, hacer: 'la huella del código no se puede completar (archivo enorme o directorio ilegible): quítalo o ignóralo; así ningún contrato nace' };
    const total = (stops || []).length;
    if (total >= 3) return { estado: ATENCION, dato, hacer: 'las pruebas del proyecto fallan o el código cambia mientras corren: arregla la prueba que falla (' + ((st && st.failures && st.failures[0]) || 'ver .agentic/_tdd_state.json') + ')' };
    return { estado: OK, dato };
  } },
  { id: 'huella-del-codigo', nombre: 'Huella del código (base de toda verificación de pruebas)', fn: (c) => {
    const h = require('./source-evidence.cjs').capture(c.root);
    const grandes = Object.entries(h.files).filter(([, v]) => String(v).startsWith('grande:')).map(([k, v]) => k + ' (' + Math.round(Number(String(v).split(':')[1]) / 1048576) + ' MB)');
    if (!h.complete) return { estado: ROTO, dato: 'incompleta: ' + (h.motivo || 'motivo desconocido'), hacer: 'sin huella completa ninguna prueba queda verificada y no nace ningún contrato: quita o ignora lo que la rompe' };
    const dato = Object.keys(h.files).length + ' archivos con huella completa' + (grandes.length ? ' · archivos grandes que no se leen: ' + grandes.slice(0, 3).join(', ') : '');
    return grandes.length ? { estado: OK, dato: dato + ' (no estorban; conviene sacarlos del proyecto)' } : { estado: OK, dato };
  } },
  { id: 'motor-creativo', nombre: 'Motor creativo: sube de nivel con 10 contratos', fn: (c) => {
    if (!c.db) return { estado: SIN_DATO, dato: c.causaBase };
    const v = consulta(c.db, "SELECT count(*) n FROM verified_contracts WHERE status IN ('protected','verified')");
    const s = consulta(c.db, 'SELECT count(*) n FROM creative_suggestions');
    const ciclos = consulta(c.db, 'SELECT count(*) n FROM ciclos');
    if (!v || !s) return { estado: SIN_DATO, dato: 'tablas del motor creativo ausentes', hacer: 'akdd doctor' };
    const dato = `${v[0].n} contratos verificados (necesita 10 para nivel 2) · ${s[0].n} sugerencias en total`;
    return v[0].n < 10 && ciclos && ciclos[0].n >= 20 ? { estado: ATENCION, dato, hacer: 'depende de los contratos: arregla primero la verificación TDD' } : { estado: OK, dato };
  } },
  { id: 'cierre-de-ciclos', nombre: 'Cierre del ciclo (post-cycle): sin fallos recientes', fn: (c) => {
    const f = path.join(c.root, '.agentic', 'grafo', 'post-cycle.log');
    if (!fs.existsSync(f)) return { estado: OK, dato: 'sin log de fallos' };
    const edad = Date.now() - fs.statSync(f).mtimeMs;
    if (edad > 2 * DIA) return { estado: OK, dato: 'el log tiene fallos antiguos (último hace ' + hace(edad) + ')' };
    const txt = fs.readFileSync(f, 'utf8'); const fallos = (txt.match(/post-cycle falló/g) || []).length; const bloqueos = (txt.match(/database is locked/g) || []).length;
    const dato = `${fallos} cierres fallidos en el log (${bloqueos} por base ocupada), último hace ${hace(edad)}`;
    const hacer = 'la base está ocupada por otro proceso: cierra lo que la tenga abierta o reintenta con akdd reconciliar --aplicar';
    return fallos >= 10 ? { estado: ROTO, dato, hacer } : fallos ? { estado: ATENCION, dato, hacer } : { estado: OK, dato: 'sin cierres fallidos recientes' };
  } },
  { id: 'gates-sin-ruido', nombre: 'Controles sin falsas alarmas', fn: (c) => {
    if (!c.db) return { estado: SIN_DATO, dato: c.causaBase };
    const r = consulta(c.db, "SELECT gate, count(*) n FROM gate_events WHERE verdict IN ('STOP','FAIL') AND ts >= ? GROUP BY gate ORDER BY n DESC LIMIT 5", [new Date(Date.now() - DIA).toISOString().slice(0, 19).replace('T', ' ')]);
    if (!r) return { estado: SIN_DATO, dato: 'sin gate_events' };
    const ruidosos = r.filter((x) => x.n > 20);
    if (!ruidosos.length) return { estado: OK, dato: r.length ? 'STOP/FAIL en 24 h: ' + r.map((x) => `${x.gate} ×${x.n}`).join(', ') : 'ningún STOP en 24 h' };
    return { estado: ATENCION, dato: 'demasiados STOP en 24 h (probable falso positivo): ' + ruidosos.map((x) => `${x.gate} ×${x.n}`).join(', '), hacer: 'revisa el control: un archivo nuevo o movido no debe contar como pruebas borradas' };
  } },
  { id: 'memoria-que-aprende', nombre: 'Memoria KDD: errores, patrones y decisiones se siguen escribiendo', fn: (c) => {
    if (!c.db) return { estado: SIN_DATO, dato: c.causaBase };
    const desde = new Date(Date.now() - 7 * DIA).toISOString().slice(0, 19).replace('T', ' ');
    const n = consulta(c.db, "SELECT count(*) n FROM nodos WHERE fecha_creacion >= ?", [desde]);
    const ciclos = consulta(c.db, 'SELECT count(*) n FROM ciclos WHERE fecha_inicio >= ?', [desde]);
    if (!n || !ciclos) return { estado: SIN_DATO, dato: 'no se pudo contar' };
    const dato = `${n[0].n} nodos nuevos en 7 días con ${ciclos[0].n} ciclos`;
    return ciclos[0].n >= 10 && n[0].n === 0 ? { estado: ATENCION, dato: dato + ': el trabajo no está dejando aprendizaje', hacer: 'el paso Memoria del ciclo no escribe: revisa 07-memoria.md y que `aa:` / TEAMS lo ejecuten al cerrar' } : { estado: OK, dato };
  } },
  { id: 'ganchos-de-git', nombre: 'Ganchos de git (registran al hacer commit)', fn: (c) => {
    if (!fs.existsSync(path.join(c.root, '.git'))) return { estado: SIN_DATO, dato: 'no es un repositorio git' };
    const hp = (git(c.root, ['config', '--get', 'core.hooksPath']) || '').trim();
    if (hp) { const abs = path.isAbsolute(hp) ? hp : path.join(c.root, hp); if (!fs.existsSync(abs)) return { estado: ROTO, dato: `core.hooksPath apunta a «${hp}», que no existe: ningún gancho de git corre`, hacer: 'git config --unset core.hooksPath' }; }
    const dir = hp ? (path.isAbsolute(hp) ? hp : path.join(c.root, hp)) : path.join(c.root, '.git', 'hooks');
    const faltan = ['post-commit', 'pre-commit'].filter((h) => !fs.existsSync(path.join(dir, h)));
    return faltan.length ? { estado: ROTO, dato: 'faltan ganchos: ' + faltan.join(', '), hacer: 'akdd hooks' } : { estado: OK, dato: 'post-commit y pre-commit instalados' };
  } },
  { id: 'ganchos-de-los-hosts', nombre: 'Ganchos de Claude Code y Cursor (aa: implícito, parada de TEAMS)', fn: (c) => {
    const problemas = [];
    const usaCursor = fs.existsSync(path.join(c.root, '.cursor')); const usaClaude = fs.existsSync(path.join(c.root, '.claude')) || fs.existsSync(path.join(c.root, 'CLAUDE.md'));
    if (usaCursor) {
      const j = leerJson(path.join(c.root, '.cursor', 'hooks.json'));
      const stop = j && j.hooks && Array.isArray(j.hooks.stop) ? j.hooks.stop.find((x) => /host-guard\.cjs/.test(x.command || '')) : null;
      if (!j) problemas.push('Cursor sin .cursor/hooks.json');
      else if (!stop) problemas.push('Cursor sin el gancho de parada de Agentix');
      else if (!('loop_limit' in stop) || stop.loop_limit !== null) problemas.push('el stop de Cursor no tiene loop_limit: null (Cursor corta a 5 seguimientos)');
    }
    if (usaClaude) {
      const j = leerJson(path.join(c.root, '.claude', 'settings.json'));
      if (!j || !j.hooks || !JSON.stringify(j.hooks).includes('host-guard.cjs')) problemas.push('Claude Code sin los ganchos de Agentix (.claude/settings.json)');
    }
    if (!usaCursor && !usaClaude) return { estado: SIN_DATO, dato: 'el proyecto no usa Cursor ni Claude Code' };
    return problemas.length ? { estado: ATENCION, dato: problemas.join(' · '), hacer: 'akdd update (reinstala los ganchos) o akdd host-hooks install' } : { estado: OK, dato: 'ganchos presentes en los hosts que usa el proyecto' };
  } },
  { id: 'servicios-de-aviso', nombre: 'Servicios de aviso (Telegram / ntfy)', fn: (c) => {
    const partes = []; let roto = false; let hay = false;
    try {
      const nb = require('./ntfy-bridge.cjs'); const cfg = nb.leerConfig(c.root);
      if (cfg && cfg.activo) { hay = true; const v = nb.estadoServicio(c.root).vivo; partes.push('ntfy ' + (v ? 'vivo' : 'PARADO')); if (!v) roto = true; }
      if (nb.telegramActivo(c.root)) {
        hay = true; const sv = leerJson(path.join(os.homedir(), '.agentix', 'telegram', 'servicio.json')); let vivo = false;
        if (sv) { try { process.kill(sv.pid, 0); vivo = Date.now() - Date.parse(sv.latido) < 90000; } catch { vivo = false; } }
        partes.push('Telegram ' + (vivo ? 'vivo' : 'PARADO')); if (!vivo) roto = true;
      }
    } catch (e) { return { estado: SIN_DATO, dato: 'no se pudo comprobar: ' + String(e.message).slice(0, 80) }; }
    if (!hay) return { estado: OK, dato: 'sin avisos activados' };
    return roto ? { estado: ROTO, dato: partes.join(' · ') + ': los avisos no llegan', hacer: 'relanzar el servicio (telegram-hub.cjs servir / ntfy-bridge.cjs servir)' } : { estado: OK, dato: partes.join(' · ') };
  } },
  { id: 'teams', nombre: 'TEAMS (si el canal está activo): los dos roles avanzan', fn: (c) => {
    if (!fs.existsSync(path.join(c.root, '.legion', 'AUDITORIA-CURSOR.md'))) return { estado: OK, dato: 'este proyecto no usa TEAMS' };
    const T = require('./teams.cjs'); const s = T.salud(c.root, { sinRecuperar: true });
    if (!s) return { estado: SIN_DATO, dato: 'no se pudo calcular la salud de TEAMS' };
    if (s.canal !== 'ACTIVO') return { estado: OK, dato: 'canal ' + s.canal };
    const rojas = (s.alertas || []).filter((a) => a.nivel === 'ROJO');
    const dato = `canal ACTIVO · semáforo ${s.semaforo}` + (rojas.length ? ' · ' + rojas[0].msg.slice(0, 140) : '');
    return rojas.length ? { estado: ATENCION, dato, hacer: 'teams.cjs diagnostico' } : { estado: OK, dato };
  } },
  { id: 'base-y-copias', nombre: 'Base de memoria sana y sin copias sueltas', fn: (c) => {
    if (!c.db) return { estado: ROTO, dato: c.causaBase, hacer: 'akdd doctor' };
    const sueltas = []; try { for (const f of fs.readdirSync(path.join(c.root, '.agentic'))) if (/^memoria.*(copia|copy|old|bak).*\.db$|^memoria .*\.db$/i.test(f)) sueltas.push(f); } catch { /* sin carpeta */ }
    return sueltas.length ? { estado: ATENCION, dato: 'copias de la base dentro de .agentic: ' + sueltas.join(', '), hacer: 'muévelas fuera del proyecto: confunden los respaldos y pesan' } : { estado: OK, dato: 'base abierta y sin copias sueltas' };
  } },
];

function auditar(root, { dias = 7 } = {}) {
  root = path.resolve(root);
  const { db, causa } = abrirBase(root);
  let cobertura = {};
  try { cobertura = require('./cobertura.cjs').informe(root, { dias }); } catch (e) { cobertura = { _error: String((e && e.message) || e).slice(0, 120) }; }
  const ctx = { root, db, causaBase: causa || 'sin base', cobertura, dias };
  const engranajes = [];
  for (const cmp of COMPROBACIONES) {
    let r;
    try { r = cmp.fn(ctx) || { estado: SIN_DATO, dato: 'la comprobación no devolvió nada' }; }
    catch (e) { r = { estado: ROTO, dato: 'la comprobación misma falló: ' + String((e && e.message) || e).slice(0, 140), hacer: 'es un fallo del auditor: avisa' }; }
    engranajes.push({ id: cmp.id, nombre: cmp.nombre, estado: r.estado, dato: r.dato, hacer: r.hacer || null });
  }
  try { if (db) db.close(); } catch { /* ya cerrada */ }
  const cuenta = (e) => engranajes.filter((x) => x.estado === e).length;
  const res = { at: new Date().toISOString(), proyecto: path.basename(root), ventana_dias: dias, total: engranajes.length, ok: cuenta(OK), atencion: cuenta(ATENCION), rotos: cuenta(ROTO), sin_dato: cuenta(SIN_DATO), engranajes };
  res.veredicto = res.rotos ? 'ROTO' : res.atencion ? 'ATENCION' : 'OK';
  return res;
}

/** Calcula y deja el resultado en .agentic/_engranajes.json (lo lee el semáforo de TEAMS). Nunca lanza. */
function refrescar(root, opts) {
  try {
    const r = auditar(root, opts);
    try { fs.mkdirSync(path.join(root, '.agentic'), { recursive: true }); const tmp = ARCHIVO(root) + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(r, null, 2)); fs.renameSync(tmp, ARCHIVO(root)); } catch { /* sin disco */ }
    return r;
  } catch (e) { return { at: new Date().toISOString(), veredicto: 'ROTO', error: String((e && e.message) || e).slice(0, 160), engranajes: [] }; }
}

/** Lo último guardado (o null si no hay o es más viejo que `maxMs`). */
function ultimo(root, maxMs = 30 * 60000) {
  const j = leerJson(ARCHIVO(root));
  if (!j || !j.at) return null;
  return Date.now() - Date.parse(j.at) <= maxMs ? j : null;
}

const ICONO = { [OK]: '🟢', [ATENCION]: '🟡', [ROTO]: '🔴', [SIN_DATO]: '⚪' };
function texto(r) {
  const L = [`ENGRANAJES — ${r.proyecto} · ${r.at.replace('T', ' ').slice(0, 16)} · ventana ${r.ventana_dias} días`, ''];
  for (const g of r.engranajes) {
    L.push(`${ICONO[g.estado]} ${g.nombre}`);
    L.push(`     ${g.dato}`);
    if (g.hacer && g.estado !== OK) L.push(`     → ${g.hacer}`);
  }
  L.push('', `Veredicto: ${r.veredicto} — ${r.ok} bien · ${r.atencion} atención · ${r.rotos} rotos · ${r.sin_dato} sin dato (de ${r.total})`);
  L.push('Un engranaje «sin dato» no está bien: está sin comprobar. Lo que este informe NO dice: si el trabajo estuvo bien hecho, solo si quedó registrado y gira.');
  return L.join('\n');
}

module.exports = { auditar, refrescar, ultimo, texto, COMPROBACIONES, ARCHIVO, OK, ATENCION, ROTO, SIN_DATO };

if (require.main === module) {
  const args = process.argv.slice(2);
  const raiz = args.find((a) => !a.startsWith('--')) || process.cwd();
  const dias = Number((args.find((a) => a.startsWith('--dias=')) || '').split('=')[1]) || 7;
  const r = refrescar(raiz, { dias });
  process.stdout.write(args.includes('--json') ? JSON.stringify(r, null, 2) + '\n' : texto(r) + '\n');
  process.exitCode = r.rotos ? 1 : 0;
}
