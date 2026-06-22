<div align="center">

<img src="https://img.shields.io/badge/Agentic_KDD-v3.0-8b5cf6?style=for-the-badge&labelColor=0a0d14" alt="version"/>

# 🤖 Agentic KDD

### The AI Development Framework

**Stop managing context. Start building.**

Agentic KDD is the opinionated framework for building software with AI agents.
It lives inside your project, learns from every cycle, and gets smarter over time.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/npm/v/agentic-kdd.svg?color=10b981)](https://www.npmjs.com/package/agentic-kdd)
[![Works with Cursor](https://img.shields.io/badge/Works_with-Cursor-3b82f6?logo=cursor)](https://cursor.sh)
[![Works with Claude Code](https://img.shields.io/badge/Works_with-Claude_Code-f59e0b?logo=anthropic)](https://claude.ai/code)
[![KDD Methodology](https://img.shields.io/badge/Methodology-KDD-8b5cf6)](docs/kdd-methodology.md)

[**Docs**](#commands) · [**Install**](#quick-start) · [**Dashboard**](#visual-dashboard) · [**Español**](README.es.md)

---

```
Laravel  →  how to build in PHP
Kiro     →  how to build with specs
Agentic  →  how to build with AI and project memory
```

</div>

---

## The problem with AI coding today

Every new session starts from zero. You re-explain the project, re-describe the architecture, re-state the rules. The AI makes the same mistakes it made last week. Context windows fill up, agents lose the thread, and you end up doing more explaining than building.

**Agentic KDD solves this.** It builds a living knowledge graph of your project — errors learned, patterns discovered, decisions documented — and uses it to make every subsequent cycle smarter than the last.

---

## What happens when you type `aa: build the payments module`

```
  You type one line. The system does the rest.

  ┌─────────────────────────────────────────────────────────────────────┐
  │  1. Context Guard     Validates instruction belongs to this project │
  │  2. Analyst           CoALA hybrid search across 3 memory layers   │
  │                       Semantic impact: what breaks if we touch X?  │
  │  3. Front Agent       Implements UI                                 │
  │  4. Back Agent        Implements API + logic                        │
  │  5. TDD + Self-Healing Generates tests → EXECUTES → if fail:       │
  │                        search episodic memory → web search → fix   │
  │                        → re-execute · max 3 iterations             │
  │  6. QA Agent          Runs full test suite · no regressions        │
  │  7. ag:review (auto)  Reviews code against KDD memory              │
  │  8. Memory Agent      Registers episode → syncs graph              │
  │                       Episodic consolidation → decay applied       │
  └─────────────────────────────────────────────────────────────────────┘

  You read the final report. You never touched anything in between.
```

---

## Core innovations

### 1. 🧠 CoALA Memory Architecture — 4 layers

The most advanced memory system for AI coding agents. Implements the **CoALA taxonomy** (Princeton/CMU, arXiv:2309.02427) used by Mem0, LangChain, and Letta — adapted specifically for software development.

```
Working Memory   → active context of the current session
Procedural       → patterns, errors, decisions (classic KDD)
Episodic         → raw trajectories: what was attempted, in what order, why it failed/worked
                   NOT summarized at write time — preserves the full signal
Semantic         → entity graph: modules, APIs, dependencies, what breaks when you touch X
```

**Automatic between every cycle:**
```
akdd sync  → episodic consolidation + temporal decay applied
akdd analyze → fills entities + semantic relations from real code
aa: [task] → Analyst queries all 3 layers simultaneously in <5ms
             Memory Agent registers the episode at cycle end
```

**Hybrid retrieval** (inspired by agentmemory's 95.2% R@5):
- Keyword scoring (BM25-like) across all 3 memory layers
- Temporal decay boost (recent + frequently used wins)
- Confidence boost (ALTA × 2.0, MEDIA × 1.5)
- Semantic impact: before touching any file, checks what depends on it

### 2. 🔬 TDD + Self-Healing Loop

```
GENERATE tests → EXECUTE (real) → READ output → PASS?
  YES → report ✓
  NO  → diagnose failure type
        → search episodic memory first (same error solved before?)
        → if not found: web_search "[error]" [framework] [version] fix
        → apply fix → RE-EXECUTE
        → max 3 iterations → STOP with exact report
```

When a fix works → registers as episodic memory → next time goes straight to solution.

### 3. 🧠 Knowledge Graph — SQLite
The heart of the system. A SQLite database inside your project connecting errors, patterns, and decisions with typed relationships and confidence signals.

```sql
-- The schema that powers the memory
CREATE TABLE nodos (
  tipo          TEXT,    -- error | patron | decision
  titulo        TEXT,
  area          TEXT,    -- which module this belongs to
  confianza     TEXT,    -- BAJA | MEDIA | ALTA
  aplicado      INTEGER, -- how many times applied
  util          INTEGER, -- how many times it actually helped
  ultima_validacion TEXT, -- auto-deprecated if unused 30+ cycles
  estado        TEXT     -- ACTIVO | OBSOLETO | CONSOLIDADO
);

CREATE TABLE relaciones (
  desde_id INTEGER, tipo TEXT, hacia_id INTEGER, peso REAL
  -- Error →resuelto_por→ Pattern →origino→ Decision
);

CREATE TABLE ciclos (
  -- Full observability: every aa: cycle tracked
  goal_attainment REAL, autonomy_ratio REAL,
  handoff_integrity REAL, drift_index REAL
);
```

**Compound indexes for millisecond queries:**
```sql
CREATE INDEX idx_nodos_area_tipo        ON nodos(area, tipo);
CREATE INDEX idx_nodos_tipo_confianza   ON nodos(tipo, confianza);
CREATE INDEX idx_nodos_area_tipo_estado ON nodos(area, tipo, estado);
```

Before (flat files): Analyst reads errores.md (100 lines) → filters mentally → slow
After (graph): `query "errors in auth module"` → 2 exact results in **<5ms**

### 2. 🛡️ Context Guard
Before executing anything, the system validates the instruction belongs to the project.

```
aa: load the medicines catalog

Context Guard checks:
  config.md ............. ✗ this is an auto parts system
  knowledge graph ....... ✗ no "medicines" entity found
  existing code ......... ✗ zero references

🔍 CONTEXT STOP — "medicines" has no backing in this project.
A) Typo — did you mean "parts"?
B) New feature — describe it to continue
```

No more blind execution of out-of-scope instructions.

### 3. ⚡ Layered Reading Architecture
Agents read only what they need — never the whole project on every message.

```
Without layered reading:  5 modules × 3 phases × full re-read = 45+ reads
With Agentic KDD:
  Startup:      3 files (once per session)
  Phase change: 1 line of PLAN.md
  Within phase: 0 reads (context already loaded)
  ──────────────────────────────────────────────
  Total:        5 reads for a complete 3-phase module
```

### 4. 📈 Confidence Signals
The knowledge base self-improves based on what actually helps.

```
BAJA  →  new entry, used as suggestion only
MEDIA →  Applied 3+, useful rate >70% — used in planning
ALTA  →  Applied 7+, useful rate >80% — permanent rule, always applied
         Patterns unused 30+ cycles → auto-deprecated to MEDIA
         Patterns unused 60+ cycles → marked OBSOLETE
```

### 5. 🔍 Independent QA Verifier
QA reads only acceptance criteria — not the implementation. Catches what the implementer misses.

### 6. 🔄 Automatic Memory Compression
Every 10 cycles: HIGH-confidence errors become permanent patterns. Duplicate entries are merged. Outdated decisions are archived. Zero manual maintenance.

### 7. 📊 Full Observability
Every `aa:` cycle is tracked with four key metrics:

| Metric | Measures | Target |
|--------|----------|--------|
| **Goal Attainment Rate** | % cycles completed successfully | >80% |
| **Autonomy Ratio** | % cycles without STOP | Rising over time |
| **Handoff Integrity** | % phases with context preserved | >90% |
| **Drift Index** | Avg review blockers per cycle | Trending to 0 |
| **Guardrail Violations** | Context STOPs triggered | Very low |

### 8. 🔬 Spec-Driven Memory (Kiro-style)
Every completed module generates a `.agentic/specs/[module].md` automatically. The Orchestrator reads this spec as the **source of intent** before planning new work — ensuring no decision contradicts a previous architectural choice.

### 9. 🎯 Automatic Error Capture
The `watch-errors.cjs` script observes your dev server and registers errors in KDD memory automatically — no manual intervention needed.

---

## What runs automatically inside every `aa:`

You never trigger these. They run on their own:

```
✓ ag:test + Self-Healing  Generates tests → executes → fixes failures → re-executes
✓ ag:review               Reviews code against decisions + HIGH patterns
✓ Test gate               Phase doesn't close if tests fail
✓ Episodic memory         Every cycle registers raw trajectory in SQLite
✓ Episodic consolidation  Resolved episodes → patterns (auto on every sync)
✓ Temporal decay          Unused patterns lose relevance automatically
✓ Semantic graph          Entities + relations updated by akdd analyze
✓ Spec sync               .agentic/specs/[module].md updated after every module
✓ Graph sync              SQLite synced at every cycle end
✓ Cycle log               _output/log-YYYY-MM.md written automatically
✓ Vigency check           Patterns unused 30+ cycles flagged
✓ Compression             Every 10 cycles: memory cleaned automatically
```

---

## Quick Start

### Option A — CLI (recommended)
```bash
npm install -g agentic-kdd
cd your-project
akdd init
```

Then open in Cursor or Claude Code:
```
aa: configurar
```

### Option B — Manual (no CLI required)
1. Copy the ZIP contents to your project root
2. Install the graph dependency:
```bash
npm install better-sqlite3
```
3. Open in Cursor or Claude Code
4. Type `aa: configurar`

> **Note:** If `better-sqlite3` fails to install (requires Visual Studio Build Tools on Windows), the graph will automatically use `node:sqlite` (built into Node.js 22+) or `sql.js` as fallback — no action needed.

### Auto-detected stacks
`akdd init` detects your stack automatically and pre-configures everything:

| Stack | Auto-detected | Pre-configured rules |
|-------|--------------|---------------------|
| Next.js 14 | ✓ | App Router, Server Components, Supabase patterns |
| Laravel | ✓ | Services, Repositories, Form Requests |
| Node.js / Express | ✓ | Services layer, error handling |
| React | ✓ | Hooks, state management, API services |
| PHP | ✓ | PDO queries, validation |
| Python / FastAPI | ✓ | Pydantic, SQLAlchemy, pytest |

---

## Commands

### `aa: sprint` — Chain multiple tasks
```bash
aa: sprint — full quality cycle for auth module
  → task 1: audit and generate issues report
  → task 2: fix the BLOCKERs found
  → task 3: generate tests for the failing cases
  → task 4: update documentation

# Short form — system infers tasks and proposes
aa: sprint — build payments module from zero
aa: sprint skip    # skip current task, continue
aa: sprint abort   # cancel sprint, keep completed
```
KDD memory flows between all tasks. Output of task 1 informs task 2. Persists forever.

### `aa:` — Build (autonomous pipeline)
```bash
aa: configurar              # first-time setup — reads your project automatically
aa: [any task]              # full autonomous cycle
aa: continúa — [answer]     # resume after a STOP
aa: sprint — [objective]    # chain multiple tasks with shared KDD memory
aa: aprende                 # absorb knowledge from work done outside the pipeline
aa: aprende — módulo [x]    # learn from a specific module
aa: aprende — error: [x]    # register a specific error
aa: aprende — decisión: [x] # register an architectural decision
aa: help                    # show all commands
```

### `aa: sprint` — Chained autonomous tasks
The most powerful mode. Chain multiple tasks where the output of each feeds the next — with full KDD memory flowing between all tasks. No user input between tasks.

```bash
# Explicit task list
aa: sprint — full quality cycle for auth module
  → task 1: audit auth module and generate issues report
  → task 2: fix the BLOCKERs found in the audit
  → task 3: generate tests for the cases that failed
  → task 4: update documentation with the changes

# Short form — system infers tasks and proposes before executing
aa: sprint — build payments module from zero
aa: sprint — migrate JWT auth to Supabase
aa: sprint — audit, fix and document the session system
```

**Why sprint beats `/goal`:**
```
/goal (Claude Code)       aa: sprint (Agentic KDD)
────────────────────────  ─────────────────────────────────────
Reactive loop             Proactive plan with defined tasks
No memory between turns   KDD memory flows between all tasks
Session-only — ephemeral  Specs + memory persist forever
Only in Claude Code       Works in Cursor + Claude Code
Vague condition = loop    Clear tasks = clean handoff
External evaluator        QA agent with project context
```

### `ag:` — Improve existing code (Pro Subagents)
Each reads `decisions.md + patterns.md + errors.md` before acting.
```bash
ag: refactor [file/module]  # refactor respecting every architectural decision
ag: test [file/module]      # generate tests from known errors — not templates
ag: doc [file/module]       # document the WHY, not just the what
ag: review [file/PR]        # BLOCKER/REQUIRED/SUGGESTED review vs KDD memory
ag: help
```

**The KDD difference:**
```
Generic review:   "this code is well structured"
KDD review:       "line 47 violates decision: Queries only in lib/supabase/queries/"
                  "line 89 ignores HIGH pattern: Dark admin vs white cards — applied 5x"

Generic tests:    "endpoint returns 200"
KDD tests:        "endpoint doesn't fail when hora=null" ← from errors.md, ALTA confidence

Generic refactor: rename variables, extract functions
KDD refactor:     Category A (violates decisions — BLOCKER)
                  Category B (ignores HIGH patterns — REQUIRED)
                  Category C (technical debt — SUGGESTED)
                  Category D (DO NOT TOUCH — documented reason why)
```

### `audit:` — Quality & Security (QA Department)
7 independent subagents audit in parallel without touching code.
```bash
audit: auditar     # full audit — all 7 subagents
audit: seguridad   # secrets, auth, vulnerabilities
audit: frontend    # source maps, exposed keys, build artifacts
audit: backend     # endpoints, validation, APIs
audit: datos       # RLS, data leaks, access control
audit: performance # rate limiting, cache, scaling
audit: browser     # real browser QA
audit: codigo      # code quality and Git hygiene
```

### CLI commands
All commands available via `npm install -g agentic-kdd`

```bash
# Setup
akdd init          # install in current project (auto-detects stack)
akdd update        # update ALL system files (agents, graph, dashboard)

# Daily use
akdd graph         # sync memory + show graph stats
akdd sync          # sync + decay + episodic consolidation (automatic)
akdd analyze       # analyze code → fill entities + semantic relations

# CoALA memory inspection (optional — runs automatically inside aa:)
akdd coala         # show stats: procedural + episodic + semantic layers
akdd buscar "q"    # hybrid search across all 3 memory layers
akdd impacto "X"   # what breaks if you touch module X?
akdd decay         # force temporal decay on stale patterns

# Metrics + Dashboard
akdd metricas      # show agent KPIs (Goal Attainment, Autonomy, etc.)
akdd dashboard     # open visual dashboard in browser
akdd semantico     # semantic search (needs API key)
```

> All `node .agentic/grafo/grafo.cjs` commands are also available directly as `akdd` commands — no need to remember the full path.

### Knowledge graph — direct commands
```bash
node .agentic/grafo/grafo.cjs sync             # sync memory files to SQLite
node .agentic/grafo/grafo.cjs stats            # view graph stats + HIGH rules
node .agentic/grafo/grafo.cjs query [area]     # query by module area
node .agentic/grafo/grafo.cjs metricas         # view agent KPIs
node .agentic/grafo/grafo.cjs semantico [q]    # semantic search (needs API key)
node .agentic/grafo/grafo.cjs analizar         # analyze project code
```

### Watch errors — automatic error capture
Observes your dev server and registers errors in KDD memory automatically.

```bash
# Node.js / Next.js / any npm project
npm run dev 2>&1 | node .agentic/grafo/watch-errors.cjs

# Laravel artisan serve
php artisan serve 2>&1 | node .agentic/grafo/watch-errors.cjs
```

Add to your `package.json` so you never have to remember:
```json
"dev:kdd": "npm run dev 2>&1 | node .agentic/grafo/watch-errors.cjs"
```

**For XAMPP / Laragon / Apache** — open a separate terminal:
```bash
# XAMPP Windows
node .agentic/grafo/watch-errors.cjs --watch-log "C:/xampp/apache/logs/error.log"

# Laragon
node .agentic/grafo/watch-errors.cjs --watch-log "C:/laragon/logs/php_error.log"

# Laravel log file
node .agentic/grafo/watch-errors.cjs --watch-log "storage/logs/laravel.log"
```

Detects: TypeScript · Next.js · Node.js · SQL/Supabase/Prisma · Laravel · PHP · Python/FastAPI

---

## Visual Dashboard

```bash
node dashboard.cjs    # opens at http://localhost:3847
```

### 🧠 Knowledge Graph
Interactive D3 neural graph of everything your project learned.

- **Divine nodes ⚡** — most connected, everything flows through them
- **Surprising connections ✨** — cross-area links the system detected
- **Node size** — proportional to accumulated knowledge
- **Click any node** — see content, relations, confidence signal
- **Tab: Nodes** — filterable list by type, confidence, divine
- **Tab: Report** — divine nodes + surprising connections + suggested questions
- **Tab: Stats** — breakdown by type and confidence level

### 📚 Project Docs
Living architecture documentation, updated automatically after every cycle.

| Section | Content |
|---------|---------|
| Project | Description, Graph Report, getting started guide |
| Stack | Framework, runtime, database, commands |
| Modules | Neural graph — implemented vs pending |
| Rules | Project rules applied automatically |
| Patterns | Learned patterns with usage bars |
| Decisions | Architectural decisions and their reasoning |
| Errors | Known error patterns with solutions |
| For New Devs | Onboarding guide with suggested questions |
| 📊 Metrics | Goal Attainment, Autonomy Ratio, Handoff Integrity, Drift Index |
| 🕐 Timeline | Chronological decision history + auto-generated specs |
| 🚀 Onboarding | Setup progress bar with exact next steps |

Dark/light theme · English/Spanish · Export to PDF

---

## The STOP Protocol

When an agent fails after 2 attempts, it stops with a precise report — never loops.

```
🛑 STOP — Back agent

Task:     persist expiry_date in warehouse table
Phase:    2 of 3
Attempts: 2

Error:   "Invalid column name 'expiry_date'"
Why:     Column doesn't exist. Migration not run.

→ aa: continúa — run: ALTER TABLE warehouse ADD expiry_date DATE NULL
```

The STOP is not a failure — it's the system being honest. It prefers stopping and asking over continuing incorrectly.

---

## Project memory structure

```
your-project/
├── .agentic/
│   ├── config.md            ← project configuration (stack, modules, rules)
│   ├── PLAN.md              ← active cycle plan
│   ├── memoria.db           ← SQLite: procedural + episodic + semantic + working memory
│   ├── agentes/             ← the 9 pipeline agents
│   │   ├── 00-setup.md
│   │   ├── 01-orquestador.md
│   │   ├── 02-analista.md   ← CoALA hybrid retrieval from 3 memory layers
│   │   ├── 03-front.md
│   │   ├── 04-back.md
│   │   ├── 05-qa.md         ← self-healing loop with real test execution
│   │   ├── 06-tdd.md        ← TDD + self-healing + web search on failure
│   │   ├── 07-memoria.md    ← episodic + semantic registration
│   │   ├── 08-aprende.md    ← absorb knowledge from outside the pipeline
│   │   ├── 09-sprint.md     ← chain multiple tasks with shared KDD memory
│   │   └── pro/             ← ag: subagents (refactor/test/doc/review)
│   ├── grafo/
│   │   ├── grafo.cjs        ← SQLite graph engine
│   │   ├── watch-errors.cjs ← automatic error capture
│   │   └── schema.sql       ← database schema
│   ├── memoria/
│   │   ├── errores.md       ← learned errors with confidence
│   │   ├── patrones.md      ← discovered patterns with confidence
│   │   └── decisiones.md    ← architectural decisions and reasoning
│   ├── specs/               ← auto-generated module specs
│   └── conocimiento/        ← drop your docs here (PDF, MD, specs)
├── .audit/                  ← QA department (7 subagents)
├── dashboard.cjs            ← visual dashboard
├── _output/                 ← audit reports + cycle logs
├── CLAUDE.md                ← activates aa: / ag: / audit:
└── .cursorrules             ← Cursor rules
```

---

## Works with any stack. Any project.

| | New project | Existing project |
|---|---|---|
| **With code** | Setup asks 3 questions | Setup reads everything, configures itself |
| **With docs** | Drop files in `.agentic/conocimiento/` | Same |
| **Without anything** | Describe it in chat | Setup maps the codebase |

**Switch IDEs** → zero reconfiguration. Knowledge lives in files, not the IDE.
**Cursor + Claude Code simultaneously** → `_LOCKS.md` coordinates shared files.
**ESM projects** (Next.js, Vite) → use `.cjs` files, they work everywhere.

---

## Real project benchmarks

### Glowly (Beauty SaaS) — Next.js 14 + Supabase
14 nodes · 48 relations · 5 HIGH confidence rules (permanent)

```
Design system before new UI ............... ALTA — always applied
Queries only in lib/supabase/queries/ ..... ALTA — always applied
Floating menus with auto flip ............. ALTA — always applied
Dark admin background vs white cards ...... ALTA — always applied
Appointments by turn, time at confirmation  ALTA — always applied
```

### Query latency comparison

| System | Type | Latency |
|--------|------|---------|
| Agentic KDD v3.0 | CoALA hybrid: procedural+episodic+semantic | <5ms |
| Agentic KDD v2.1 | SQLite + compound indexes | <5ms |
| Agentic KDD v2.0 | SQLite basic indexes | 10–50ms |
| GBrain | PGLite indexed graph | <5ms |
| Claude + Obsidian | Markdown files | 200–2000ms |

---

## The KDD Methodology

| | TDD | BDD | DDD | **KDD** |
|---|---|---|---|---|
| Driven by | Tests | Behavior | Domain | **Accumulated knowledge** |
| Artifact | Test suite | Scenarios | Domain model | **Living knowledge graph** |
| Written by | Devs | Business+Dev | Domain experts | **AI agents** |
| Improves | Manually | Manually | Manually | **Automatically** |

→ [Read the full KDD methodology](docs/kdd-methodology.md)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for full version history.

## License

MIT — use it, fork it, build on it.

---

<div align="center">

**If Agentic KDD saved you time, give it a ⭐**

Made with 🧠 by [@Adrianlpz211](https://github.com/Adrianlpz211)

[npm](https://www.npmjs.com/package/agentic-kdd) · [GitHub](https://github.com/Adrianlpz211/Agentic-KDD)

</div>
