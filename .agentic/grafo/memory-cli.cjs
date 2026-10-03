#!/usr/bin/env node
'use strict';
/**
 * `akdd memory ...` — la superficie de línea de comandos de la memoria con procedencia,
 * la recuperación por capas, la cola, las evidencias, la compactación y la salud.
 *
 * Cada subcomando delega en un módulo que ya existe y tiene pruebas; este archivo no
 * contiene reglas propias. La salida es JSON (para que la lea un agente o un script) y el
 * código de salida es 0 solo si el resultado fue ok.
 *
 *   status                         qué hay: disponibilidad, inventario, cola, evidencias, captura por host
 *   capabilities                   qué captura es nativa, cuál es por pipeline y cuál NO existe
 *   capture --host= --session= --type= [--id=] [--task=] [--paths=a,b] [--input=] [--output=] [--required]
 *   drain [--max=N] [--owner=]     procesa la cola con reglas deterministas (sin modelo)
 *   queue stats | retry <job_id>
 *   index|detail|timeline|evidence   recuperación por capas (ver memory-layers.cjs)
 *   evidence get|verify|pin|unpin|gc|stats
 *   provenance <node_id>           de qué actividades y evidencias sale un conocimiento
 *   validate <node_id> --evidence=ev_..[,ev_..] --by=gate|test|user|verifier [--criterion=]
 *   project status|adopt|fork      identidad del proyecto: renombre (adopt) o copia (fork), explícito
 *   health [verify-write]          estados de salud independientes; verify-write es el ÚNICO que escribe
 *   compress <archivo|-> --kind= --task= --purpose=   compactar con original recuperable
 *   recover <reference_id> [--lines=a-b|--offset=N --length=N|--json-path=ruta]
 *
 * La lectura jamás crea ni migra la base: sin las tablas nuevas informa SCHEMA_MISSING y manda a `akdd update`.
 */

const fs = require('fs');
const path = require('path');

const G = __dirname;
const cargar = (n) => require(path.join(G, n));

function parseArgs(argv) {
  const opt = {}; const libres = [];
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/s.exec(a);
    if (m) opt[m[1]] = m[2] === undefined ? true : m[2]; else libres.push(a);
  }
  return { opt, libres };
}

const lista = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const salir = (r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); process.exit(r && r.ok === false ? 1 : 0); };

/** Qué captura existe de verdad por host. No se promete lo que el host no entrega. */
function capacidades(root) {
  const filas = [];
  let hooks = [];
  try { hooks = cargar('host-hooks.cjs').estado(root); } catch { hooks = []; }
  for (const host of ['cursor', 'claude']) {
    const h = hooks.find((x) => x.host === host);
    filas.push({
      host,
      captura: h && h.instalado ? 'NATIVE_PASSIVE' : 'PIPELINE_ONLY',
      detalle: h && h.instalado
        ? 'Los hooks ya instalados entregan shell, edición y MCP ANTES de ejecutarlos: se registra la acción y la decisión de la guardia, no la salida de la herramienta.'
        : 'Sin hooks de ' + host + ' instalados: solo se registran los eventos que pasan por Agentix (aa:, post-cycle, MCP de Agentix, TEAMS). No se reinstalan hooks automáticamente (akdd host-hooks install).',
      verificado: h ? h.verificado : 'NO_VERIFICADO',
      no_observado: ['lecturas y búsquedas internas del IDE', 'salida de herramientas del host', 'razonamiento interno del modelo'],
    });
  }
  filas.push({ host: 'otros', captura: 'UNSUPPORTED', detalle: 'Sin adaptador validado: no se promete captura.', verificado: 'NO_VERIFICADO', no_observado: ['todo lo que no pase por Agentix'] });
  filas.push({ host: 'agentix (pipeline aa:, post-cycle, MCP, TEAMS)', captura: 'PIPELINE', detalle: 'Eventos de rutas realmente ejecutadas por Agentix.', verificado: 'FIXTURE_Y_PRUEBAS', no_observado: [] });
  return filas;
}

async function main() {
  const [sub, ...resto] = process.argv.slice(2);
  const { opt, libres } = parseArgs(resto);
  const root = path.resolve(opt.root || process.cwd());
  const core = cargar('memory-core.cjs');

  switch (sub) {
    case 'status': {
      const q = cargar('memory-queue.cjs'); const st = cargar('evidence-store.cjs');
      return salir({ ok: true, root, availability: core.disponibilidad(root), identity: core.identidad(root), inventory: core.inventario(root), queue: q.estadisticas(root), evidence: st.estadisticas(root), capture: capacidades(root) });
    }
    case 'capabilities': return salir({ ok: true, contract_version: 1, capture: capacidades(root), layers: (() => { try { return cargar('mcp-memory-tools.cjs').capabilities(root); } catch { return null; } })() });
    case 'capture': {
      if (!opt.host || !opt.session || !opt.type) return salir({ ok: false, code: 'USO', message: 'capture --host= --session= --type= [--id=] [--task=] [--paths=a,b] [--input=] [--output=]' });
      return salir(core.capturar(root, { host: opt.host, session_id: opt.session, host_event_id: opt.id, event_type: opt.type, task_id: opt.task, role: opt.role, paths: lista(opt.paths), input: opt.input, output: opt.output }, { required: !!opt.required }));
    }
    case 'drain': return salir(await cargar('memory-queue.cjs').drenar(root, { owner: opt.owner, max: Number(opt.max) || 25 }));
    case 'queue': {
      const q = cargar('memory-queue.cjs');
      if (libres[0] === 'retry' && libres[1]) return salir(q.reintentar(root, libres[1]));
      return salir({ ok: true, ...q.estadisticas(root) });
    }
    case 'index': case 'detail': case 'timeline': case 'evidence': {
      // 'akdd memory evidence ev_… --lines=a-b' es la forma corta de 'evidence get ev_…'.
      if (sub === 'evidence' && /^ev_/.test(libres[0] || '')) libres.unshift('get');
      if (sub === 'evidence' && ['get', 'verify', 'pin', 'unpin', 'gc', 'stats'].includes(libres[0])) {
        const st = cargar('evidence-store.cjs'); const id = libres[1];
        if (libres[0] === 'stats') return salir({ ok: true, ...st.estadisticas(root) });
        if (libres[0] === 'gc') return salir(st.limpiar(root, { dry_run: !!opt['dry-run'], max_bytes: opt['max-bytes'] ? Number(opt['max-bytes']) : undefined }));
        if (libres[0] === 'verify') return salir(st.verificar(root, id));
        if (libres[0] === 'pin') return salir(st.fijar(root, id, opt['owner-kind'] || 'task', opt['owner-id']));
        if (libres[0] === 'unpin') return salir(st.soltar(root, opt['owner-kind'] || 'task', opt['owner-id']));
        const sel = opt['json-path'] ? { json: { path: opt['json-path'], fields: lista(opt.fields), offset: opt.offset ? Number(opt.offset) : undefined, limit: opt.limit ? Number(opt.limit) : undefined } }
          : (opt.lines ? { line_from: Number(String(opt.lines).split('-')[0]), line_to: Number(String(opt.lines).split('-')[1]) } : { offset: opt.offset ? Number(opt.offset) : 0, length: opt.length ? Number(opt.length) : undefined });
        return salir(st.obtener(root, id, sel));
      }
      const layers = cargar('memory-layers.cjs');
      // ejecutarCli imprime su propio JSON y devuelve el código de salida (0 OK/NO_RESULTS, 1 fallo, 2 uso).
      process.exit(layers.ejecutarCli([sub, ...resto]));
    }
    case 'provenance': return salir(core.procedencia(root, libres[0]));
    case 'validate': return salir(core.validarConocimiento(root, libres[0], { evidence_ids: lista(opt.evidence), validated_by: opt.by, criterio: opt.criterion }));
    case 'project': {
      const a = libres[0] || 'status';
      if (a === 'adopt') return salir(core.adoptarRaiz(root));
      if (a === 'fork') return salir(core.bifurcarIdentidad(root));
      return salir({ ok: true, ...core.identidad(root) });
    }
    case 'health': {
      const salud = cargar('memoria-salud.cjs');
      if (libres[0] === 'verify-write') return salir(await salud.verificarEscritura(root));
      return salir(await salud.leer(root));
    }
    case 'compress': {
      const comp = cargar('context-compressor.cjs');
      const origen = libres[0];
      if (!origen || !opt.kind || !opt.task) return salir({ ok: false, code: 'USO', message: 'compress <archivo|-> --kind=log|test|json|search|doc|code --task=T [--purpose=orient|edit|audit|debug|verify|gate]' });
      const contenido = origen === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(root, origen), 'utf8');
      const r = await comp.comprimir(root, { content: contenido, source_kind: opt.kind, task_id: opt.task, purpose: opt.purpose || 'orient', path: origen === '-' ? undefined : origen });
      return salir({ ok: !!(r && r.envelope), ...r });
    }
    case 'recover': {
      const comp = cargar('context-compressor.cjs');
      const sel = opt['json-path'] ? { json: { path: opt['json-path'], fields: lista(opt.fields) } }
        : (opt.lines ? { line_from: Number(String(opt.lines).split('-')[0]), line_to: Number(String(opt.lines).split('-')[1]) } : { offset: opt.offset ? Number(opt.offset) : 0, length: opt.length ? Number(opt.length) : undefined });
      return salir(await comp.recuperar(root, libres[0], sel, { task_id: opt.task }));
    }
    default:
      process.stderr.write('\n  Uso: akdd memory <status|capabilities|capture|drain|queue|index|detail|timeline|evidence|provenance|validate|project|health|compress|recover> [opciones]\n\n');
      process.exit(2);
  }
}

if (require.main === module) main().catch((e) => { process.stdout.write(JSON.stringify({ ok: false, code: e.code || 'MEMORY_CLI_ERROR', message: e.message }, null, 2) + '\n'); process.exit(1); });

module.exports = { capacidades, parseArgs };
