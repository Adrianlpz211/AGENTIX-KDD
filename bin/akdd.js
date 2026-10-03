#!/usr/bin/env node
'use strict';

const { init }      = require('../src/init');
const { update }    = require('../src/update');
const { onboard }   = require('../src/onboard');
const { graph }     = require('../src/graph');
const { dashboard } = require('../src/dashboard');
const { mcpSetup, mcpStatus } = require('../src/mcp-setup');
const pkg  = require('../package.json');
const path = require('path');
const fs   = require('fs');
const { spawnSync } = require('child_process');

const args    = process.argv.slice(2);
const command = args[0];
const arg1    = args[1];
const arg2    = args[2];

const HELP = `
  Agentic KDD v${pkg.version}
  Autonomous development pipeline — one developer, full-department output.

  Setup:
    akdd init              Install Agentic KDD in the current project
    akdd update            Update the engine from the INSTALLED package. One command: backs up, migrates the
                           schema (compatible, additive) and VERIFIES that your memory was preserved.
                           Exit 0 only when the result is verifiable.
                           [--ref=<branch|tag|sha>] [--from=<file.tar.gz>] [--sha256=<hex>]
                           [--check] plan only, changes nothing · [--json] structured output
                           [--no-migrate] skip the schema (result is never reported as complete)
                           [--migrate] kept for compatibility (migrating is already the default)
                           [--ack-recovery=<id>] after resolving a RECOVERY_REQUIRED by hand
                           [--deps] · akdd update --rollback  (reverts framework FILES; memory is kept)
    akdd onboard           Analyze existing project + pre-populate memory
    akdd analyze           Cross-artifact consistency check
    akdd locks             Lock Manager status
    akdd locks release-all Release all locks for this instance
    akdd hooks             Install git hooks (registro automático de contratos)
    akdd hooks status      Show git hook status
    akdd health            System health check — what's configured, what's missing
    akdd health --fix      Auto-fix common issues

  ClickUp Bridge (opt-in, off by default — "cu" es alias corto de "clickup"):
    akdd cu on             Activate ClickUp tools (needs CLICKUP_API_TOKEN in .env)
    akdd cu set-list <id>  Configure the ClickUp List this project pulls from
    akdd cu status         Show ClickUp bridge status
    akdd cu sprint         Pull + classify + show the "sprint sólido" (no execution yet)

  Memory & Knowledge:
    akdd sync              Sync memory files to SQLite graph
    akdd graph             Sync + show graph stats
    akdd stats             Show graph stats and HIGH rules
    akdd coala             Show CoALA memory stats (4 layers)
    akdd buscar            Hybrid search across all memory layers
    akdd impacto           Semantic impact of a module/entity
    akdd decay             Apply temporal decay to stale patterns
    akdd audit             Memory audit — stale entries, contradictions, proposals
    akdd forget <id>       Forget a memory entry with documented reason

  AST & Impact Analysis:
    akdd ast               Index project AST (symbols, imports, call graph, PageRank)
    akdd ast stats         Show AST index stats
    akdd ast symbols <f>   Show symbols in a file
    akdd ast-impact <f>    Full impact analysis of a file/module
    akdd why <entity>      Explain why something exists (causal chain)

  Specs & Autonomy:
    akdd spec list         List all module specs
    akdd spec <module>     Show spec status + next wave
    akdd spec create <m>   Create feature spec for a module
    akdd spec create <m> --bugfix  Create bugfix spec

  Knowledge Base:
    akdd adr               Ingest ADRs from docs/adr/
    akdd knowledge         Ingest gotchas/conventions from docs/

  Preservation Intelligence (v3.3):
    akdd contracts             Contract Guard status
    akdd contracts list        List all verified contracts
    akdd contracts blast <f>   Blast radius for a file
    akdd contracts gate        Run Preservation Gate manually
    akdd contracts verify      Revalidate all contracts
    akdd creative              Creative Engine level
    akdd creative suggest      View pending suggestions
    akdd creative apply <id>   Apply a suggestion
    akdd creative wins         View applied creative improvements

  Memory (ranked retrieval):
    akdd recall "query"    Ranked BM25+vector search — replaces full file reads
    akdd reason "query"    ReasoningBank — estrategias de ciclos que funcionaron
    akdd memory stats      Memory retrieval stats (indexed, coverage, mode)
    akdd memory index      Re-index all .agentic/memoria/*.md files
    akdd validate scan     Scan all memory for stale/obsolete/poisoned entries
    akdd validate report   Health report of knowledge base
    akdd telemetry         Telemetry summary (spans, STOPs, recalls)
    akdd telemetry view    View last cycle trace (L4 audit trail)

  Autonomous decisions (L4):
    akdd decide <file>     Analyze a change — STOP/WARN/IMPLEMENT/DEFER decision
    akdd deferred          View deferred queue (end-of-cycle suggestions)
    akdd deferred flush    Show and clear deferred queue
    akdd sprint-plan "obj" Generate sprint plan from business objective

  Effectiveness:
    akdd report            Real data — before vs after comparison across all cycles

  Session continuity:
    akdd historial         Resume context in a new chat — paste output at start
    akdd checkpoint        Save checkpoint now (auto-runs every 5 cycles)

  Memory Governance (v3.2):
    akdd cure              Run MemCurator — TTL, dedup, conflicts, scores
    akdd cure report       Preview what curation would do (no changes)
    akdd llms              Generate llms.txt + knowledge-graph.json
    akdd benchmarks        LongMemEval + Token Reduction + Memory Quality scores
    akdd causal-prune      Prune causal graph to prevent context collapse

  Metrics & Observability:
    akdd metrics           Project KPIs — success rate, rework, autonomy score
    akdd metrics trend     Show trend of last 10 cycles
    akdd trail             Recent decision trails (what changed and why)
    akdd trail <ciclo_id>  Full trail of a specific cycle
    akdd trail why <f>     Why does this file/entity exist?

  Collaborative Mode (Legion) — 🔒 private beta (set AKDD_COLLAB_ENABLED=1 to use):
    akdd collab init       Activate collaborative mode — creates shared DB automatically
    akdd collab invite     Generate a 6-char invite code for a team member (24h, one-use)
    akdd collab join <code>  Join the team with an invite code (e.g. LUMO-X7K2P4)
    akdd collab push       Push your learnings to the team
    akdd collab pull       Pull team's latest learnings
    akdd collab status     Check collaborative sync status

  Intelligence v2.2:
    akdd git-context       Analyze git diff + risk assessment
    akdd predict           Predictive risk patterns from episodic memory
    akdd embed-status      Local embeddings status
    akdd embed-install     Install local embeddings (~23MB, offline)
    akdd jina-install      Install jina-v2-code embeddings (~500MB, code-optimized)
    akdd ci-install        Install GitHub Actions CI/CD workflow
    akdd ci-status         Show last CI/CD reports

  Graph Visualization:
    akdd graph-viz         Open KDD Memory graph — glowing force-directed graph in browser

  Dashboard:
    akdd dashboard         Open visual dashboard in browser

  3.20 — effort, TEAMS, restore, hooks, time:
    akdd effort decide "<task>" [--paths=a,b] [--type=T] [--json]   LOW/MEDIUM/HIGH by difficulty AND risk
    akdd context armar "<goal>" --paths=a,b                          One context package per task
    akdd teams <init|plan <plan.json>|run|status|pending|resolve|pause|resume|disable|goal>
                           Claude Code director + Cursor builder (init needs --aprobar-migracion)
    akdd restore <list|create --label=L [--files=a,b]|show|preview|apply <id> --expected-current-hash=H>
                           Real restore points in private Git refs (HEAD/branch/index untouched)
    akdd host-hooks <status|install|uninstall> [--host=cursor|claude|all]   Optional IDE guard
    akdd ws <activar|estado|desactivar>   Optional WhatsApp notices (needs a real browser session)
    akdd simple            Simplicity gate: duplicated code, deps with native equivalent
    akdd capabilities      What this install can really do (verified vs pending)
    akdd tiempo <inicio "<task>"|pausa|fin|resumen>   Measured task time (worked vs elapsed)
    akdd tiempos [module]  Time per module · akdd rebobina [from] [to] · akdd orden

  3.20.1 — memory with evidence, layered recall, recoverable context:
    akdd memory status|capabilities    What is stored, what is pending, and what each host can really capture
    akdd memory index|detail|timeline|evidence   Layered recall: compact index → batch details → timeline → original evidence
    akdd memory capture|drain|queue    Record an activity; process the durable queue (deterministic, no model calls)
    akdd memory provenance <node>      Which activity and evidence a piece of knowledge comes from
    akdd memory validate <node> --evidence=ev_..  --by=gate|test|user|verifier   Only with CURRENT evidence
    akdd memory project status|adopt|fork   Stable project id: rename (adopt) vs copy (fork), always explicit
    akdd memory health [verify-write]  Independent health states (only verify-write touches the database)
    akdd context compress <file|-> --kind=K --task=T   Compact a tool result; the original stays recoverable
    akdd context recover <reference_id> [--lines=a-b]  Retrieve the original (hash verified)
    akdd effort budget <estado <id>|host [id]>          Cumulative effort budget per task
    akdd benchmark contexto [--json]   Deterministic benchmark of compaction + recovery + effort (net payload, measured honestly)
    akdd teams packet <estado|snapshot|ack|invalidar|cerrar>   Shared director↔builder context packets

  MCP Setup (Cursor / Claude Code / VS Code):
    akdd mcp               Configure MCP for THIS project (Cursor + Claude Code)
    akdd mcp --global      One entry for all projects: ~/.cursor/mcp.json + Claude Code user scope.
                           A launcher opens each project's own server and memory.
    akdd mcp status        Check MCP configuration status

  akdd --version / akdd --help
`;

function findGrafo() {
  const p = path.join(process.cwd(), '.agentic', 'grafo', 'grafo.cjs');
  if (!fs.existsSync(p)) { console.log('\n  grafo.cjs not found. Run: akdd update\n'); process.exit(1); }
  return p;
}

/* Cada argumento viaja como un elemento de argv, sin shell: un nombre con
   espacios, comillas, backticks o $() es un dato, no un comando. */
function ejecutar(script, argv, { tolerante = false } = {}) {
  const limpio = argv.filter((a) => a !== '' && a != null).map(String);
  const r = spawnSync(process.execPath, [script, ...limpio], { stdio: 'inherit', cwd: process.cwd() });
  if (tolerante) return;
  if (r.error) { console.error(`  ${path.basename(script)}: ${r.error.message}`); process.exit(1); }
  if (r.status) process.exit(r.status);
  if (r.signal) process.exit(1);
}

function runGrafo(...argv) { ejecutar(findGrafo(), argv); }

function runModule(name, ...argv) {
  const p = path.join(process.cwd(), '.agentic', 'grafo', name);
  if (!fs.existsSync(p)) { console.error(`\n  ${name} not found. Run: akdd update\n`); process.exit(1); }
  ejecutar(p, argv);
}

function uso(texto) { console.error(`\n  Uso: ${texto}\n`); process.exitCode = 1; }

const ANALYZE_SUBS = ['run', 'contracts', 'memory', 'spec'];

switch (command) {

  case 'init':    init(); break;
  case 'update': {
    const flag = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : undefined; };
    if (args.includes('--rollback')) require('../src/update').rollback({ json: args.includes('--json'), salir: true });
    else update({ ref: flag('ref'), archivo: flag('from'), sha256: flag('sha256'), migrate: args.includes('--migrate'), noMigrate: args.includes('--no-migrate'), check: args.includes('--check'), json: args.includes('--json'), ackRecovery: flag('ack-recovery'), deps: args.includes('--deps') });
    break;
  }
  case 'onboard': onboard(); break;
  case 'analyze': {
    const sub = arg1 || 'run';
    if (!ANALYZE_SUBS.includes(sub)) { uso(`akdd analyze [${ANALYZE_SUBS.join('|')}]`); break; }
    runModule('akdd-analyze.cjs', sub);
    break;
  }
  case 'locks':   runModule('lock-manager.cjs', arg1 || 'status', ...args.slice(2)); break;
  case 'effort': {
    const sub = arg1;
    if (['decide', 'reevaluar', 'show'].includes(sub)) runModule('effort-router.cjs', ...args.slice(1));
    else if (sub === 'budget') runModule('effort-budget.cjs', ...args.slice(2));
    else uso('akdd effort <decide "<tarea>" [--paths=a,b] [--type=T] [--json]|reevaluar <id> <EVENTO>|show <id>|budget <estado <id>|registrar <id> <kind>|host [id]>>');
    break;
  }
  case 'host-hooks': {
    if (['install', 'uninstall', 'status'].includes(arg1 || 'status')) runModule('host-hooks.cjs', arg1 || 'status', ...args.slice(2));
    else uso('akdd host-hooks <install|uninstall|status> [--host=cursor|claude|all]');
    break;
  }
  case 'simple': runModule('simple-gate.cjs', ...args.slice(1)); break;
  case 'teams': {
    const sub = arg1 || 'status';
    if (['init', 'plan', 'run', 'status', 'pause', 'resume', 'disable', 'pending', 'resolve', 'import', 'verify', 'views'].includes(sub)) runModule('teams-manager.cjs', sub, ...args.slice(2));
    else if (sub === 'goal') runModule('goal-check.cjs', ...args.slice(2));
    else if (sub === 'watch') runModule('teams-watch.cjs', ...args.slice(2));
    else if (sub === 'packet') runModule('teams-packets.cjs', ...args.slice(2));
    else if (sub === 'vigilar') runModule('builder-inactividad.cjs', ...args.slice(2));
    else uso('akdd teams <init [--aprobar-migracion]|plan <plan.json>|run|status|pause|resume|disable|pending|resolve <id> <decisión>|import <archivo>|verify <id> --gates=<json>|views|packet <estado|snapshot|ack|invalidar|cerrar>|goal|watch --rol=R>');
    break;
  }
  case 'ws': {
    const sub = arg1 || 'estado';
    if (['activar', 'contacto', 'elegir', 'reintentar', 'desactivar', 'estado', 'politica', 'procesar', 'teams'].includes(sub)) runModule('whatsapp-manager.cjs', sub, ...args.slice(2));
    else uso('akdd ws <activar|contacto <id> <número o nombre>|elegir <id> <n>|reintentar <id>|desactivar|estado|politica|procesar|teams>');
    break;
  }
  case 'restore': {
    const sub = arg1 || 'list';
    if (['list', 'create', 'show', 'preview', 'apply', 'resume', 'invalidate'].includes(sub)) runModule('restore-manager.cjs', sub, ...args.slice(2));
    else uso('akdd restore <list|create --label=L [--files=a,b]|show <id>|preview <id>|apply <id> --expected-current-hash=H [--confirmar]|resume|invalidate <id> <motivo>>');
    break;
  }
  case 'memory': runModule('memory-cli.cjs', ...args.slice(1)); break;
  case 'benchmark': {
    if (arg1 === 'contexto') runModule('benchmark-contexto.cjs', 'run', ...args.slice(2));
    else uso('akdd benchmark contexto [--seed=N] [--only=A,B] [--json]   (determinista, sin datos de usuario; las campañas con modelos reales quedan NO_EJECUTADO)');
    break;
  }
  case 'context': {
    if (arg1 === 'armar') runModule('context-pack.cjs', ...args.slice(1));
    else if (['leer', 'stats', 'limpiar'].includes(arg1)) runModule('context-reuse.cjs', ...args.slice(1));
    else if (arg1 === 'compress') runModule('memory-cli.cjs', 'compress', ...args.slice(2));
    else if (arg1 === 'recover') runModule('memory-cli.cjs', 'recover', ...args.slice(2));
    else uso('akdd context <armar "<objetivo>" --paths=a,b [--task=T] [--rol=builder|qa|analyst]|leer <archivo> [--task=T]|stats|limpiar|compress <archivo|-> --kind=K --task=T|recover <reference_id>>');
    break;
  }
  case 'clickup': case 'cu': {
    const sub = arg1;
    if (sub === 'on')            runModule('clickup-bridge.cjs', 'on');
    else if (sub === 'status')   runModule('clickup-bridge.cjs', 'status');
    else if (sub === 'set-list') runModule('clickup-bridge.cjs', 'set-list', arg2);
    else if (sub === 'pull' || sub === 'sprint') runModule('clickup-bridge.cjs', 'pull', args.includes('--auto') ? '--auto' : '');
    else if (sub === 'done')     runModule('clickup-bridge.cjs', 'done', arg2, args.find(a => a.startsWith('--status=')));
    else if (sub === 'comment')  runModule('clickup-bridge.cjs', 'comment', arg2, args.slice(3).filter(a => !a.startsWith('--')).join(' '));
    else uso('akdd cu <on|set-list <id>|status|sprint [--auto]|done <id>|comment <id> "texto">');
    break;
  }
  case 'hooks': {
    const sub = arg1 || 'install';
    if (sub === 'uninstall')   runModule('install-hooks.cjs', '--uninstall');
    else if (sub === 'status') runModule('install-hooks.cjs', '--status');
    else                       runModule('install-hooks.cjs', args.includes('--compose') ? '--compose' : '');
    break;
  }
  case 'reason': {
    if (!arg1 || arg1 === 'status') runModule('reasoning-bank.cjs', 'status');
    else runModule('reasoning-bank.cjs', 'recall', arg1, arg2);
    break;
  }

  // ── v3.0: Health ──────────────────────────────────────────────────────
  case 'health': runModule('health-check.cjs', args.includes('--fix') ? '--fix' : ''); break;

  // ── v3.16.9: Doctor (reparación generalizada) ───────────────────────────
  case 'doctor': runModule('doctor.cjs'); break;
  case 'capabilities': runModule('capabilities.cjs', ...args.slice(1)); break;

  // ── v3.17.0: CSS Token Gate ──────────────────────────────────────────────
  // Sin args → scan (inventario de tokens + oportunidades de tokenización).
  // Con archivos → gate sobre esos archivos (WARN si hay valores hardcodeados
  // que ya existen como token).
  case 'tokens': runModule('css-token-gate.cjs', ...args.slice(1)); break;

  // ── v3.18.0: Línea de tiempo (cuánto tomó cada tarea) ───────────────────
  // El CLAUDE.md ya rutea estos nombres desde el chat; aquí existen también en
  // terminal, que es donde el CHANGELOG los anuncia.
  case 'tiempo':
    runModule('linea-tiempo.cjs', ...args.slice(1));
    break;
  case 'tiempos':
    runModule('linea-tiempo.cjs', 'tiempos', args.slice(1).join(' '));
    break;
  case 'rebobina':
    runModule('linea-tiempo.cjs', 'ventana', ...args.slice(1));
    break;
  case 'orden':
    runModule('linea-tiempo.cjs', 'orden');
    break;

  // ── Core memory ───────────────────────────────────────────────────────
  case 'sync':    runGrafo('sync'); break;
  case 'graph':   graph(); break;
  case 'stats':   runGrafo('stats'); break;
  case 'coala':   runGrafo('coala'); break;
  case 'metricas': runGrafo('metricas'); break;
  case 'decay':   runGrafo('decay'); break;

  case 'buscar':
    if (!arg1) { uso('akdd buscar "query" [area]'); break; }
    runGrafo('buscar', arg1, arg2);
    break;

  case 'impacto':
    if (!arg1) { uso('akdd impacto "NombreModulo"'); break; }
    runGrafo('impacto', arg1);
    break;

  // ── v3.0: Memory Audit ────────────────────────────────────────────────
  case 'audit': runModule('memory-audit.cjs', 'report'); break;

  case 'forget': {
    const reason = args.slice(2).join(' ');
    if (!arg1 || !reason) { uso('akdd forget <id> "<razón>"'); break; }
    runModule('memory-audit.cjs', 'forget', arg1, reason);
    break;
  }

  // ── v3.0: AST ─────────────────────────────────────────────────────────
  case 'ast': {
    const sub = arg1 || 'index';
    if (sub === 'stats') runModule('ast-indexer.cjs', 'stats');
    else if (sub === 'symbols') {
      if (!arg2) { uso('akdd ast symbols <archivo>'); break; }
      runModule('ast-indexer.cjs', 'symbols', arg2);
    } else {
      runModule('ast-indexer.cjs', 'index', arg2);
    }
    break;
  }

  case 'ast-impact':
    if (!arg1) { uso('akdd ast-impact <archivo_o_módulo>'); break; }
    runModule('impact-analyzer.cjs', 'analyze', arg1);
    break;

  case 'why':
    if (!arg1) { uso('akdd why <archivo_o_entidad>'); break; }
    runModule('decision-trail.cjs', 'why', arg1);
    break;

  // ── v3.0: Specs ───────────────────────────────────────────────────────
  case 'spec': {
    const sub = arg1;
    const mod = arg2;
    const bugfix = args.includes('--bugfix') ? '--bugfix' : '';
    if (!sub || sub === 'list') runModule('spec-manager.cjs', 'list');
    else if (sub === 'create')   { if (!mod) { uso('akdd spec create <módulo> [--bugfix]'); break; } runModule('spec-manager.cjs', 'create', mod, bugfix); }
    else if (sub === 'waves')    { if (!mod) { uso('akdd spec waves <módulo>'); break; } runModule('spec-manager.cjs', 'waves', mod); }
    else if (sub === 'validate') { if (!mod) { uso('akdd spec validate <módulo>'); break; } runModule('spec-manager.cjs', 'validate', mod); }
    else runModule('spec-manager.cjs', 'status', sub);
    break;
  }

  case 'spec-create':
    if (!arg1) { uso('akdd spec-create <módulo> [--bugfix]'); break; }
    runModule('spec-manager.cjs', 'create', arg1, args.includes('--bugfix') ? '--bugfix' : '');
    break;

  // ── v3.0: Knowledge ───────────────────────────────────────────────────
  case 'adr':
    runModule('adr-ingestor.cjs', 'ingest', arg1 || 'docs/adr');
    break;

  case 'knowledge':
    runModule('knowledge-ingestor.cjs', 'ingest', arg1);
    break;

  // ── v3.0: Metrics ─────────────────────────────────────────────────────
  case 'metrics':
    runModule('metrics.cjs', arg1 || 'summary');
    break;

  // ── v3.0: Decision Trail ──────────────────────────────────────────────
  case 'trail': {
    if (!arg1)                    runModule('decision-trail.cjs', 'recent', '5');
    else if (arg1 === 'why')      { if (!arg2) { uso('akdd trail why <entidad>'); break; } runModule('decision-trail.cjs', 'why', arg2); }
    else if (arg1 === 'timeline') { if (!arg2) { uso('akdd trail timeline <módulo>'); break; } runModule('decision-trail.cjs', 'timeline', arg2); }
    else runModule('decision-trail.cjs', 'ciclo', arg1);
    break;
  }

  // ── v3.3: Contract Guard ────────────────────────────────────────────────────
  case 'contracts': {
    const sub = arg1 || 'status';
    if (sub === 'list')     runModule('contract-guard.cjs', 'list', arg2);
    else if (sub === 'blast')  { if (!arg2) { uso('akdd contracts blast <archivo>'); break; } runModule('contract-guard.cjs', 'blast', arg2); }
    else if (sub === 'gate')   runModule('contract-guard.cjs', 'gate', ...args.slice(2));
    else if (sub === 'verify') runModule('contract-guard.cjs', 'verify', arg2);
    else if (sub === 'promote')runModule('contract-guard.cjs', 'promote');
    else runModule('contract-guard.cjs', 'status');
    break;
  }

  // ── v3.3: Creative Engine ───────────────────────────────────────────────────
  case 'creative': {
    const sub = arg1 || 'level';
    if (sub === 'suggest')  runModule('creative-engine.cjs', 'suggest', arg2);
    else if (sub === 'apply')   { if (!arg2) { uso('akdd creative apply <id>'); break; } runModule('creative-engine.cjs', 'apply', arg2); }
    else if (sub === 'dismiss') { if (!arg2) { uso('akdd creative dismiss <id>'); break; } runModule('creative-engine.cjs', 'dismiss', arg2); }
    else if (sub === 'wins')    runModule('creative-engine.cjs', 'wins');
    else runModule('creative-engine.cjs', 'level');
    break;
  }

  // ── v3.4: KDD Memory, Knowledge Validator, Telemetry ─────────────────────
  case 'recall':
    runModule('kdd-memory.cjs', 'recall', args.slice(1).join(' '));
    break;
  case 'memory': {
    const sub = arg1 || 'stats';
    if (sub === 'index')  runModule('kdd-memory.cjs', 'index');
    else if (sub === 'sync') runModule('kdd-memory.cjs', 'sync');
    else runModule('kdd-memory.cjs', 'stats');
    break;
  }
  case 'validate': {
    const vsub = arg1 || 'report';
    if (vsub === 'scan')       runModule('knowledge-validator.cjs', 'scan');
    else if (vsub === 'report') runModule('knowledge-validator.cjs', 'report');
    else runModule('knowledge-validator.cjs', 'validate', arg1);
    break;
  }
  case 'telemetry': {
    const tsub = arg1 || 'summary';
    if (tsub === 'view')    runModule('telemetry.cjs', 'view', arg2);
    else runModule('telemetry.cjs', 'summary');
    break;
  }

  // ── v3.3: Autonomous Decision Engine ──────────────────────────────────────
  case 'decide': {
    const files = args.slice(1);
    if (!files.length) { uso('akdd decide <archivo> [archivos...]'); break; }
    runModule('autonomous-decision.cjs', 'analyze', ...files);
    break;
  }
  case 'deferred': {
    const sub = arg1 || 'queue';
    runModule('autonomous-decision.cjs', sub === 'flush' ? 'flush' : 'queue');
    break;
  }
  case 'sprint-plan': {
    const objective = args.slice(1).join(' ');
    if (!objective) { uso('akdd sprint-plan "objetivo del sprint"'); break; }
    runModule('autonomous-decision.cjs', 'sprint', '--objective', objective);
    break;
  }

  // ── v3.3: Effectiveness Report ──────────────────────────────────────────────
  case 'report':
    runModule('effectiveness-report.cjs');
    break;

  // ── v3.3: Session Guard ────────────────────────────────────────────────────
  case 'historial':
    runModule('session-guard.cjs', 'historial');
    break;
  case 'checkpoint':
    runModule('session-guard.cjs', 'checkpoint');
    break;

  // ── v3.2: MemCurator ───────────────────────────────────────────────────────
  case 'cure': {
    const sub = arg1 || 'run';
    runModule('mem-curator.cjs', sub);
    break;
  }

  // ── v3.2: llms.txt generator ───────────────────────────────────────────────
  case 'llms': {
    const sub = arg1 || 'all';
    runModule('llms-generator.cjs', sub);
    break;
  }

  // ── v3.2: Report benchmarks ────────────────────────────────────────────────
  case 'benchmarks': {
    runModule('metrics.cjs', 'benchmarks');
    break;
  }

  // ── v3.2: Causal prune ─────────────────────────────────────────────────────
  case 'causal-prune': {
    runModule('causal-edges.cjs', 'prune');
    break;
  }

  // ── v3.0: Collaborative Mode (Legion) ────────────────────────────────
  case 'collab': {
    const sub = arg1 || 'status';
    if (sub === 'init') {
      runModule('collab-manager.cjs', 'init');
    } else if (sub === 'invite') {
      runModule('collab-manager.cjs', 'invite');
    } else if (sub === 'join') {
      if (!arg2) {
        console.log('\n  Uso: akdd collab join <código>\n');
        console.log('  El código lo genera el jefe con: akdd collab invite\n');
        break;
      }
      runModule('collab-manager.cjs', 'join', arg2);
    } else if (sub === 'push') {
      runModule('collab-manager.cjs', 'push');
    } else if (sub === 'pull') {
      runModule('collab-manager.cjs', 'pull');
    } else {
      runModule('collab-manager.cjs', 'status');
    }
    break;
  }

  // ── Graph Visualization ───────────────────────────────────────────────
  case 'graph-viz': {
    runModule('graph-server.cjs', process.cwd());
    break;
  }

  // ── Dashboard ─────────────────────────────────────────────────────────
  case 'dashboard': dashboard(); break;

  // ── v2.2: Intelligence ────────────────────────────────────────────────
  case 'git-context': runGrafo('git-context', args.includes('--install-hook') ? '--install-hook' : ''); break;
  case 'predict':     runGrafo('predict'); break;
  case 'embed-status': runGrafo('embed-status'); break;
  case 'embed-install': runGrafo('embed-install'); break;

  case 'jina-install':
    runModule('embeddings.cjs', 'install-jina');
    break;

  case 'ci-install': runGrafo('ci-install'); break;
  case 'ci-status':  runGrafo('ci-status'); break;

  case 'ci-report': {
    const grafo = path.join(process.cwd(), '.agentic', 'grafo', 'grafo.cjs');
    if (!fs.existsSync(grafo)) { process.exit(0); }
    const esExito = args.includes('--success');
    const outIdx  = args.indexOf('--output');
    const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
    /* El reporte de CI nunca tumba el job: por eso es tolerante. */
    ejecutar(grafo, ['ci-report', esExito ? '--success' : '', ...(outFile ? ['--output', outFile] : [])], { tolerante: true });
    break;
  }

  // ── v3.0: MCP Setup ───────────────────────────────────────────────────
  case 'mcp': {
    const sub = arg1;
    const opts = { global: args.includes('--global') };
    if (sub === 'status') mcpStatus(process.cwd());
    else mcpSetup(process.cwd(), opts);
    break;
  }

  case '--version': case '-v':
    console.log(pkg.version); break;

  case '--help': case '-h': case undefined:
    console.log(HELP); break;

  default:
    console.error(`\n  Unknown command: ${command}`);
    console.error('  Run akdd --help for usage\n');
    process.exit(1);
}
