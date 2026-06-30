#!/usr/bin/env node
'use strict';

const { init }      = require('../src/init');
const { update }    = require('../src/update');
const { onboard }   = require('../src/onboard');
const { graph }     = require('../src/graph');
const { dashboard } = require('../src/dashboard');
const { analyze }   = require('../src/analyze');
const { mcpSetup, mcpStatus } = require('../src/mcp-setup');
const pkg  = require('../package.json');
const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const args    = process.argv.slice(2);
const command = args[0];
const arg1    = args[1];
const arg2    = args[2];

const HELP = `
  Agentic KDD v${pkg.version}
  Autonomous development pipeline — one developer, full-department output.

  Setup:
    akdd init              Install Agentic KDD in the current project
    akdd update            Update agents + engine (memory stays intact)
    akdd onboard           Analyze existing project + pre-populate memory
    akdd analyze           Cross-artifact consistency check
    akdd locks             Lock Manager status
    akdd locks release-all Release all locks for this instance
    akdd hooks             Install git hooks (registro automático de contratos)
    akdd hooks status      Show git hook status
    akdd health            System health check — what's configured, what's missing
    akdd health --fix      Auto-fix common issues

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

  Collaborative Mode (Legion):
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

  Dashboard:
    akdd dashboard         Open visual dashboard in browser

  MCP Setup (Cursor / Claude Code / VS Code):
    akdd mcp               Auto-configure MCP in all IDEs (recommended)
    akdd mcp --global      Configure MCP globally for all projects
    akdd mcp status        Check MCP configuration status

  akdd --version / akdd --help
`;

function findGrafo() {
  const p = path.join(process.cwd(), '.agentic', 'grafo', 'grafo.cjs');
  if (!fs.existsSync(p)) { console.log('\n  grafo.cjs not found. Run: akdd update\n'); process.exit(1); }
  return p;
}

function runGrafo(cmd, extra) {
  const grafo = findGrafo();
  const fullCmd = extra ? `node "${grafo}" ${cmd} ${extra}` : `node "${grafo}" ${cmd}`;
  try { execSync(fullCmd, { stdio: 'inherit', cwd: process.cwd() }); }
  catch(e) { process.exit(e.status || 1); }
}

function runModule(name, cmd, extra) {
  const p = path.join(process.cwd(), '.agentic', 'grafo', name);
  if (!fs.existsSync(p)) { console.log(`\n  ${name} not found. Run: akdd update\n`); process.exit(1); }
  const fullCmd = [`node "${p}"`, cmd || '', extra || ''].join(' ').trim().replace(/\s+/g,' ');
  try { execSync(fullCmd, { stdio: 'inherit', cwd: process.cwd() }); }
  catch(e) { process.exit(e.status || 1); }
}

switch (command) {

  case 'init':    init(); break;
  case 'update':  update(); break;
  case 'onboard': onboard(); break;
  case 'analyze': runModule('akdd-analyze.cjs', args[0] || 'run'); break;
  case 'locks':   runModule('lock-manager.cjs', args[0] || 'status', args[1] || ''); break;
  case 'hooks': {
    const sub = arg1 || 'install';
    if (sub === 'uninstall')   runModule('install-hooks.cjs', '--uninstall');
    else if (sub === 'status') runModule('install-hooks.cjs', '--status');
    else                       runModule('install-hooks.cjs', '');
    break;
  }
  case 'analyze': analyze(); break;

  // ── v3.0: Health ──────────────────────────────────────────────────────
  case 'health': {
    const fixFlag = args.includes('--fix') ? '--fix' : '';
    runModule('health-check.cjs', fixFlag);
    break;
  }

  // ── Core memory ───────────────────────────────────────────────────────
  case 'sync':    runGrafo('sync'); break;
  case 'graph':   graph(); break;
  case 'stats':   runGrafo('stats'); break;
  case 'coala':   runGrafo('coala'); break;
  case 'metricas': runGrafo('metricas'); break;
  case 'decay':   runGrafo('decay'); break;

  case 'buscar':
    if (!arg1) { console.log('\n  Uso: akdd buscar "query" [area]\n'); break; }
    runGrafo('buscar', `"${arg1}"${arg2 ? ' ' + arg2 : ''}`);
    break;

  case 'impacto':
    if (!arg1) { console.log('\n  Uso: akdd impacto "NombreModulo"\n'); break; }
    runGrafo('impacto', `"${arg1}"`);
    break;

  // ── v3.0: Memory Audit ────────────────────────────────────────────────
  case 'audit': runModule('memory-audit.cjs', 'report'); break;

  case 'forget': {
    if (!arg1) { console.log('\n  Uso: akdd forget <id> "<razón>"\n'); break; }
    const reason = args.slice(2).join(' ');
    if (!reason) { console.log('\n  Uso: akdd forget <id> "<razón>"\n'); break; }
    runModule('memory-audit.cjs', 'forget', `${arg1} "${reason}"`);
    break;
  }

  // ── v3.0: AST ─────────────────────────────────────────────────────────
  case 'ast': {
    const sub = arg1 || 'index';
    const tgt = arg2 || '';
    if (sub === 'stats') runModule('ast-indexer.cjs', 'stats');
    else if (sub === 'symbols') {
      if (!tgt) { console.log('\n  Uso: akdd ast symbols <archivo>\n'); break; }
      runModule('ast-indexer.cjs', 'symbols', `"${tgt}"`);
    } else {
      runModule('ast-indexer.cjs', 'index', tgt);
    }
    break;
  }

  case 'ast-impact':
    if (!arg1) { console.log('\n  Uso: akdd ast-impact <archivo_o_módulo>\n'); break; }
    runModule('impact-analyzer.cjs', 'analyze', `"${arg1}"`);
    break;

  case 'why':
    if (!arg1) { console.log('\n  Uso: akdd why <archivo_o_entidad>\n'); break; }
    runModule('decision-trail.cjs', 'why', `"${arg1}"`);
    break;

  // ── v3.0: Specs ───────────────────────────────────────────────────────
  case 'spec': {
    const sub = arg1;
    const mod = arg2;
    if (!sub || sub === 'list') runModule('spec-manager.cjs', 'list');
    else if (sub === 'create') {
      if (!mod) { console.log('\n  Uso: akdd spec create <módulo> [--bugfix]\n'); break; }
      runModule('spec-manager.cjs', 'create', `"${mod}"${args.includes('--bugfix') ? ' --bugfix' : ''}`);
    }
    else if (sub === 'waves')    { if (!mod) { console.log('\n  Uso: akdd spec waves <módulo>\n'); break; } runModule('spec-manager.cjs', 'waves', `"${mod}"`); }
    else if (sub === 'validate') { if (!mod) { console.log('\n  Uso: akdd spec validate <módulo>\n'); break; } runModule('spec-manager.cjs', 'validate', `"${mod}"`); }
    else runModule('spec-manager.cjs', 'status', `"${sub}"`);
    break;
  }

  case 'spec-create':
    if (!arg1) { console.log('\n  Uso: akdd spec-create <módulo> [--bugfix]\n'); break; }
    runModule('spec-manager.cjs', 'create', `"${arg1}"${args.includes('--bugfix') ? ' --bugfix' : ''}`);
    break;

  // ── v3.0: Knowledge ───────────────────────────────────────────────────
  case 'adr':
    runModule('adr-ingestor.cjs', 'ingest', arg1 || 'docs/adr');
    break;

  case 'knowledge':
    runModule('knowledge-ingestor.cjs', 'ingest', arg1 || '');
    break;

  // ── v3.0: Metrics ─────────────────────────────────────────────────────
  case 'metrics':
    runModule('metrics.cjs', arg1 || 'summary');
    break;

  // ── v3.0: Decision Trail ──────────────────────────────────────────────
  case 'trail': {
    if (!arg1)                    runModule('decision-trail.cjs', 'recent', '5');
    else if (arg1 === 'why')      { if (!arg2) { console.log('\n  Uso: akdd trail why <entidad>\n'); break; } runModule('decision-trail.cjs', 'why', `"${arg2}"`); }
    else if (arg1 === 'timeline') { if (!arg2) { console.log('\n  Uso: akdd trail timeline <módulo>\n'); break; } runModule('decision-trail.cjs', 'timeline', `"${arg2}"`); }
    else runModule('decision-trail.cjs', 'ciclo', `"${arg1}"`);
    break;
  }



  // ── v3.3: Contract Guard ────────────────────────────────────────────────────
  case 'contracts': {
    const sub = arg1 || 'status';
    if (sub === 'list')     runModule('contract-guard.cjs', 'list', arg2 || '');
    else if (sub === 'blast')  { if (!arg2) { console.log('\n  Uso: akdd contracts blast <archivo>\n'); break; } runModule('contract-guard.cjs', 'blast', `"${arg2}"`); }
    else if (sub === 'gate')   runModule('contract-guard.cjs', 'gate');
    else if (sub === 'verify') runModule('contract-guard.cjs', 'verify', arg2 || '');
    else if (sub === 'promote')runModule('contract-guard.cjs', 'promote');
    else runModule('contract-guard.cjs', 'status');
    break;
  }

  // ── v3.3: Creative Engine ───────────────────────────────────────────────────
  case 'creative': {
    const sub = arg1 || 'level';
    if (sub === 'suggest')  runModule('creative-engine.cjs', 'suggest', arg2 || '');
    else if (sub === 'apply')   { if (!arg2) { console.log('\n  Uso: akdd creative apply <id>\n'); break; } runModule('creative-engine.cjs', 'apply', `"${arg2}"`); }
    else if (sub === 'dismiss') { if (!arg2) { console.log('\n  Uso: akdd creative dismiss <id>\n'); break; } runModule('creative-engine.cjs', 'dismiss', `"${arg2}"`); }
    else if (sub === 'wins')    runModule('creative-engine.cjs', 'wins');
    else runModule('creative-engine.cjs', 'level');
    break;
  }

  // ── v3.4: KDD Memory, Knowledge Validator, Telemetry ─────────────────────
  case 'recall':
    runModule('kdd-memory.cjs', 'recall', args.slice(1).join(' '));
    break;
  case 'memory':
    const sub = arg1 || 'stats';
    if (sub === 'index')  runModule('kdd-memory.cjs', 'index');
    else if (sub === 'sync') runModule('kdd-memory.cjs', 'sync');
    else runModule('kdd-memory.cjs', 'stats');
    break;
  case 'validate':
    const vsub = arg1 || 'report';
    if (vsub === 'scan')       runModule('knowledge-validator.cjs', 'scan');
    else if (vsub === 'report') runModule('knowledge-validator.cjs', 'report');
    else runModule('knowledge-validator.cjs', 'validate', arg1);
    break;
  case 'telemetry':
    const tsub = arg1 || 'summary';
    if (tsub === 'view')    runModule('telemetry.cjs', 'view', arg2 || '');
    else runModule('telemetry.cjs', 'summary');
    break;

  // ── v3.3: Autonomous Decision Engine ──────────────────────────────────────
  case 'decide': {
    const files = args.slice(1);
    if (!files.length) { console.log('\n  Uso: akdd decide <archivo> [archivos...]\n'); break; }
    runModule('autonomous-decision.cjs', 'analyze', files.map(f => `"${f}"`).join(' '));
    break;
  }
  case 'deferred': {
    const sub = arg1 || 'queue';
    runModule('autonomous-decision.cjs', sub === 'flush' ? 'flush' : 'queue');
    break;
  }
  case 'sprint-plan': {
    const objective = args.slice(1).join(' ');
    if (!objective) { console.log('\n  Uso: akdd sprint-plan "objetivo del sprint"\n'); break; }
    runModule('autonomous-decision.cjs', 'sprint', `--objective "${objective}"`);
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
      runModule('collab-manager.cjs', 'join', `"${arg2}"`);
    } else if (sub === 'push') {
      runModule('collab-manager.cjs', 'push');
    } else if (sub === 'pull') {
      runModule('collab-manager.cjs', 'pull');
    } else {
      runModule('collab-manager.cjs', 'status');
    }
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
    const flags   = [esExito ? '--success' : '', outFile ? `--output "${outFile}"` : ''].filter(Boolean).join(' ');
    try { execSync(`node "${grafo}" ci-report ${flags}`, { stdio: 'inherit', cwd: process.cwd(), timeout: 60000 }); }
    catch(e) { process.exit(0); }
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
    console.log(`\n  Unknown command: ${command}`);
    console.log('  Run akdd --help for usage\n');
    process.exit(1);
}
