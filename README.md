<div align="center">

```
 █████╗  ██████╗ ███████╗███╗   ██╗████████╗██╗ ██████╗     ██╗  ██╗██████╗ ██████╗ 
██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██║██╔════╝     ██║ ██╔╝██╔══██╗██╔══██╗
███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║██║          █████╔╝ ██║  ██║██║  ██║
██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║██║          ██╔═██╗ ██║  ██║██║  ██║
██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██║╚██████╗     ██║  ██╗██████╔╝██████╔╝
╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝ ╚═════╝     ╚═╝  ╚═╝╚═════╝ ╚═════╝

                      A development team of one.
                       A team becomes a legion.
```

[![npm](https://img.shields.io/npm/v/agentic-kdd?color=8b5cf6&style=flat-square&label=agentic-kdd)](https://www.npmjs.com/package/agentic-kdd)
[![mcp](https://img.shields.io/npm/v/agentic-kdd-mcp?color=3b82f6&style=flat-square&label=agentic-kdd-mcp)](https://www.npmjs.com/package/agentic-kdd-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square)](https://nodejs.org)
[![Cursor](https://img.shields.io/badge/Cursor-compatible-0ea5e9?style=flat-square)](https://cursor.sh)
[![Claude Code](https://img.shields.io/badge/Claude_Code-compatible-f97316?style=flat-square)](https://claude.ai/code)

</div>

---

## The problem

Every AI coding tool today has the same fundamental flaw: **the agent forgets everything when you close the chat.**

Session 1: the agent explores your codebase, learns that touching `auth.ts` breaks the session manager, figures out your conventions, understands your architecture.  
Session 2: it knows nothing. It explores again. It makes the same mistake.

This isn't a model problem. It's an architecture problem. No amount of context window size fixes a system that starts from zero every time.

**Agentic KDD solves this at the infrastructure level** — with persistent memory that lives inside your project, learns from every cycle, and gets smarter over time.

---

## What is KDD?

**Knowledge-Driven Development** is the methodology at the core of Agentic KDD.

Traditional AI development treats each session as independent. KDD treats knowledge as a first-class artifact: every pattern discovered, every error resolved, every architectural decision made is stored in a structured knowledge graph and fed back into every future cycle.

The agent doesn't re-learn your project. It already knows it.

```
Without KDD:
  Session 1 → agent learns → session ends → forgotten
  Session 2 → start over → same mistakes → same time lost

With KDD:
  Session 1 → agent learns → stored in .agentic/memoria.db
  Session 2 → agent already knows → builds on top of everything
  Session N → the system is smarter than it was on day one
```

---

## How it works

Agentic KDD lives inside your project as a `.agentic/` directory — a local SQLite database, 25 specialized modules, and a pipeline that runs automatically when you type `aa:`.

```bash
aa: implement JWT authentication with refresh token rotation
```

That single command triggers a complete pipeline without interrupting you:

```
① Analyst           reads memory, AST graph, ADRs, specs — plans all phases
② Build             frontend / backend agents implement within the plan
③ TDD Gate          runs tests, self-heals up to 3× automatically
④ QA                verifies acceptance criteria
⑤ Preservation Gate checks that verified contracts still pass (no collateral damage)
⑥ ag:review         automatic code review against KDD memory
⑦ Memory            syncs graph, causal edges, specs, observability
⑧ Creative Engine   detects improvement opportunities for the next cycle
```

**The developer never types `ag: test`, `ag: review`, or `akdd contracts gate`. They run automatically.**

The critical difference from every other agent framework is step ③. The TDD gate is a deterministic check in Node.js code — not a prompt suggestion. The agent cannot declare tests passing without actually running them.

```
Cursor rules:   "prefer running tests before delivering"
                → the agent follows this when it feels like it

Agentic KDD:    if (tests_passing === false) { STOP("gate rejected") }
                → the code rejects progress without proof of compliance
```

---

## Memory architecture

Four persistent memory layers, fully offline, in SQLite, inside your project.

```
.agentic/memoria.db
│
├── WORKING MEMORY      Active session buffer
├── EPISODIC MEMORY     Raw history of every cycle
├── SEMANTIC MEMORY     Project entity graph, AST, module relationships
└── PROCEDURAL MEMORY   Patterns, errors, decisions — rules applied every cycle
```

Every node carries a confidence signal updated automatically:

```
LOW    → suggestion, not enforced
MEDIUM → applied and mentioned in every plan
HIGH   → fixed rule, applied on every cycle without exception

Applied ≥ 3×  +  utility ≥ 70%  →  auto-promoted to MEDIUM
Applied ≥ 7×  +  utility ≥ 80%  →  auto-promoted to HIGH
Unused for 60 cycles             →  auto-degraded (temporal decay)
```

Three additional knowledge structures specific to software development:

- **AST Graph** — symbols, imports, call graph, PageRank across 12 languages
- **Causal Edges** — `caused_failure`, `was_fixed_by`, `tested_by`, `regressed_by`, `verifies`, `protects` — bi-temporal, never deleted
- **Knowledge Docs** — ADRs, gotchas, conventions from `docs/adr/`

---

## The five phases

### Phase 0 — Harness

Deterministic enforcement gates. `harness.cjs` runs PRE/EXEC/POST checks on every pipeline step. `tdd-gate.cjs` is a Node.js loop that detects your test command, runs it, parses output (Jest, Vitest, Mocha, pytest), and retries up to three times automatically.

### Phase 1 — Discernment

`ast-indexer.cjs` builds an AST graph across 12 languages with PageRank scoring. `causal-edges.cjs` tracks what broke what, what fixed what — bi-temporally, with full history preserved. Includes semantic pruning to prevent context overflow.

### Phase 2 — Knowledge Base

`adr-ingestor.cjs` parses Architecture Decision Records in MADR format into typed graph edges — no LLM required. `knowledge-ingestor.cjs` ingests gotchas, conventions, and runbooks.

### Phase 3 — Autonomy

`spec-manager.cjs` implements Kiro-style specs with wave execution. `impact-analyzer.cjs` runs pre-change impact analysis — CRITICAL, MEDIUM, or LOW severity before touching anything.

### Phase 4 — Collaborative Mode

`collab-manager.cjs` syncs the local SQLite memory to a shared Turso database. Multiple developers share one knowledge base.

```
Dev A discovers that touching auth.ts breaks session.ts
                        ↓ auto-sync to Turso
Dev B already knows it — before touching auth.ts
Dev C joins the team   — gets 6 months of project knowledge from day one
```

Team members join with a single invite code — no Turso account required.

---

## Preservation Intelligence Layer

The most critical gap in AI-assisted development: **the agent learns what not to do, but doesn't protect what already works.**

```
Bug A → Fix A → ✅ OK
Bug B → Fix B → ✅ OK — but login is now broken (collateral damage)
Agent: "I didn't repeat Bug A" — true, but irrelevant
```

### Contract Guard

`contract-guard.cjs` maintains a live list of verified behavioral contracts — things that must keep working regardless of what changes.

Contracts are auto-generated from passing tests. No developer input required.

```
Promotion path:
  candidate  (< 3 consecutive passes)
  verified   (≥ 3 passes, failure rate ≤ 5%)
  protected  (≥ 7 passes, failure rate ≤ 2%) — never allowed to break
```

**Preservation Gate** runs as step ⑤ of every pipeline. It only checks contracts in the blast radius of the modified files — not the full test suite.

```
aa: fix session expiration

Impact Analyzer: auth.ts modified
AST query: which contracts protect auth.ts?
→ AUTH-001, AUTH-004, AUTH-006

TDD Gate: scope tests → PASS
Preservation Gate: AUTH-001 → FAIL
→ STOP: "protected contract broken — AUTH-001: valid login generates session"
```

**Blast radius** — before touching any file:

```bash
akdd contracts blast src/auth.ts
→ Contracts at risk: 14
→ Severity: HIGH
→ Protected: 8 | Verified: 6
→ Manual review required before proceeding
```

### Creative Engine

`creative-engine.cjs` detects improvement opportunities during each cycle and proposes them — without ever applying them unsolicited at Level 1.

```
Level 0 — STRICT          execute exactly what was asked, no suggestions
Level 1 — ASSISTED        execute + suggest improvements (default from day one)
Level 2 — CREATIVE_CONTROLLED   auto-applies low-risk improvements (auto-elevates at 10+ contracts)
Level 3 — EXPLORATORY     maximum inference for undocumented projects (manual only)
```

Guardrails always active regardless of level:
- Never touches PROTECTED contracts
- CRITICAL blast radius → blocks any creative action
- Every creative action is audited and reversible
- Successful improvements stored as `creative_wins` in memory

---

## Memory governance — MemCurator

`mem-curator.cjs` runs autonomously every 10 cycles:

- **TTL enforcement** — episodic memory > 30 days compressed, > 90 days archived
- **Deduplication** — nodes with >92% similarity merged, preserving higher confidence
- **Conflict resolution** — superseded rules marked `HISTORICO` with explicit link to replacement
- **Relevance scoring** — `S(k) = similarity × exp(-λ × Δt) × log(1 + usage_count)`
- **Node limit** — active procedural memory capped at 1,000 nodes

---

## Embeddings

Default model: `jina-embeddings-v2-base-code` — bimodal NL-PL, trained on code. Understands type relationships, AST structures, and control flow semantics.

```bash
akdd jina-install    # bimodal NL-PL — recommended
akdd embed-install   # all-MiniLM-L6-v2 — lightweight fallback
```

---

## Discoverability

Every `akdd sync` auto-generates:

- `.agentic/llms.txt` — structured project map for external agents
- `.agentic/llms-full.txt` — full knowledge base with all active patterns
- `.agentic/knowledge-graph.json` — causal graph serialized for Git versioning

---

## Installation

```bash
npm install -g agentic-kdd
cd my-project
akdd init
```

`akdd init` detects your stack, downloads the latest files from GitHub, auto-configures MCP in Cursor (writes `.cursor/mcp.json`), and registers with Claude Code if the CLI is installed. Run one command to finish:

```
aa: configure
```

**Requirements:** Node.js 18+, Cursor or Claude Code (or any MCP client).

---

## CLI reference

### Setup

```bash
akdd init              # Deploy Agentic KDD
akdd update            # Update modules — memory stays intact
akdd health            # Full system diagnostic
akdd health --fix      # Auto-fix detected issues
akdd mcp               # Auto-configure MCP in Cursor / Claude Code
akdd mcp status        # Check MCP configuration
```

### Memory

```bash
akdd sync              # Sync markdown → SQLite + generate llms.txt
akdd coala             # Stats across all 4 CoALA layers
akdd buscar "query"    # Hybrid search across all memory
akdd audit             # Memory audit: stale, contradictions, proposals
akdd forget <id>       # Invalidate a memory entry with reason
akdd cure              # Run MemCurator — TTL, dedup, conflicts, scores
akdd cure report       # Preview curation (no changes)
```

### AST & impact

```bash
akdd ast               # Index project into AST graph
akdd ast-impact <file> # Full impact analysis (AST + causal + knowledge)
akdd why <entity>      # Why does this exist? Full causal chain.
akdd causal-prune      # Prune causal graph to prevent context overflow
```

### Preservation Intelligence

```bash
akdd contracts             # Contract Guard status
akdd contracts list        # List all verified contracts
akdd contracts blast <f>   # Blast radius — contracts at risk if this file changes
akdd contracts gate        # Run Preservation Gate manually
akdd contracts verify      # Revalidate all contracts
akdd creative              # Creative Engine level
akdd creative suggest      # View pending improvement suggestions
akdd creative apply <id>   # Apply a suggestion
akdd creative wins         # View applied creative improvements
```

### Specs & knowledge

```bash
akdd spec list                     # List all module specs
akdd spec <module>                 # Status + next execution wave
akdd spec create <module>          # Create a feature spec
akdd spec create <module> --bugfix # Create a bugfix spec
akdd adr                           # Ingest ADRs from docs/adr/
akdd knowledge                     # Ingest gotchas and conventions
```

### Metrics & observability

```bash
akdd metrics           # Project KPIs
akdd metrics trend     # Trend across last 10 cycles
akdd trail             # Recent decision trails
akdd trail <cycle_id>  # Full trail: what changed, why, what influenced it
akdd benchmarks        # LongMemEval + Token Reduction + Memory Quality
akdd llms              # Regenerate llms.txt + knowledge-graph.json
```

### Collaborative mode

```bash
akdd collab init              # Activate — creates shared DB automatically
akdd collab invite            # Generate invite code (24h, one use)
akdd collab join <code>       # Join with an invite code
akdd collab push              # Push learnings to the team
akdd collab pull              # Pull team's latest learnings
akdd collab status            # Check sync status
```

### Intelligence

```bash
akdd git-context       # Git diff analysis + risk from episodic memory
akdd predict           # Predictive risk patterns
akdd jina-install      # Install jina-embeddings-v2-base-code (~500MB)
akdd embed-install     # Install all-MiniLM-L6-v2 (~23MB fallback)
akdd ci-install        # Install GitHub Actions CI/CD memory workflow
akdd dashboard         # Open interactive knowledge graph dashboard
```

---

## MCP Server — 42 native tools

After `akdd init`, Cursor and Claude Code discover the MCP server automatically. **`akdd init` configures MCP automatically** — writes `.cursor/mcp.json` for Cursor and runs `claude mcp add` for Claude Code. If you need to reconfigure: `akdd mcp`.

```json
// .cursor/mcp.json — written automatically by akdd init
{
  "mcpServers": {
    "agentic-kdd": {
      "command": "node",
      "args": [".agentic/grafo/mcp-server.cjs"]
    }
  }
}
```

**Memory (8):** `grafo_buscar` · `registrar_episodio` · `grafo_sync` · `grafo_impacto` · `registrar_entidad` · `grafo_coala` · `grafo_predecir` · `verdad_vigente`

**AST & Impact (5):** `ast_impact` · `ast_index` · `ast_symbols` · `impact_precheck` · `impact_diff`

**Specs (3):** `spec_waves` · `spec_status` · `spec_create`

**Knowledge (2):** `knowledge_query` · `adr_ingest`

**Causal (3):** `causal_add` · `causal_query` · `causal_prune`

**Observability (4):** `decision_trail` · `decision_why` · `recent_ciclos` · `metrics_summary`

**Governance (5):** `mem_curate` · `mem_score` · `memory_audit` · `memory_forget` · `report_benchmarks`

**Discoverability (1):** `generate_llms_txt`

**Preservation Intelligence (8):** `contracts_status` · `contracts_list` · `contracts_blast` · `contracts_gate` · `creative_level` · `creative_suggest` · `creative_apply` · `creative_wins`

**CLI from chat (6):** `init_project` · `update_project` · `collab_init` · `collab_invite` · `collab_status` · `system_health`

---

## Audit Department

A separate QA system for deep project-wide audits, independent from the `aa:` pipeline.

```
audit: auditar     # full audit — all 7 agents in parallel
audit: seguridad   # security — secrets, auth, vulnerabilities
audit: frontend    # frontend — source maps, keys, build artifacts
audit: backend     # backend — endpoints, validation, exposed APIs
audit: datos       # database — schema, RLS, query exposure
audit: performance # performance — rate limiting, cache, scalability
audit: browser     # real browser QA
audit: codigo      # code quality and Git hygiene
audit: help        # show all commands
```

| Agent | Focus |
|-------|-------|
| `00-director` | Orchestrates full audit, consolidates reports |
| `01-seguridad` | Exposed secrets, auth weaknesses, injection risks |
| `02-frontend` | Build artifacts, source maps, client-side key exposure |
| `03-backend` | Endpoint security, input validation, API surface |
| `04-datos` | Database schema, RLS policies, query exposure |
| `05-performance` | Rate limiting, caching, scalability bottlenecks |
| `06-browser` | Real browser QA against the running application |
| `07-codigo` | Code quality, dead code, Git history hygiene |

---

## Pro agents

| Agent | Invocation | What it does |
|-------|------------|--------------|
| `ag:review` | `ag: review <file>` | Code review against KDD memory. Also runs automatically in every `aa:` cycle. |
| `ag:test` | `ag: test <module>` | Generates test suites based on error history and causal edges. |
| `ag:refactor` | `ag: refactor <file>` | Refactors with pre-change impact analysis. Blocked if impact is CRITICAL. |
| `ag:doc` | `ag: doc <module>` | Technical documentation from code + project memory. |

---

## Switching IDEs

Memory lives in the project, not the IDE. When switching between Cursor and Claude Code:

```bash
akdd mcp
```

---

## Updating an existing project

```bash
akdd update
```

Downloads latest modules from GitHub. Schema migrations run automatically. Memory stays intact.

---

## What Agentic KDD is not

It is not a chat interface, an IDE, or a replacement for Git. It does not require internet after setup. It does not send your code anywhere. It does not depend on a SaaS backend.

It is infrastructure. It runs inside your project, travels with your repository, and compounds over time.

---

## Project structure

```
your-project/
├── .agentic/
│   ├── agentes/              9 specialized agents + 4 pro
│   ├── grafo/                25 Node.js modules
│   │   ├── grafo.cjs              CoALA v3 memory engine
│   │   ├── harness.cjs            deterministic pipeline enforcement
│   │   ├── tdd-gate.cjs           mechanical self-healing loop
│   │   ├── ast-indexer.cjs        AST graph (12 languages)
│   │   ├── causal-edges.cjs       bi-temporal causal memory + pruning
│   │   ├── contract-guard.cjs     Preservation Intelligence Layer
│   │   ├── creative-engine.cjs    Directed Creative Autonomy
│   │   ├── adr-ingestor.cjs       knowledge base (ADRs)
│   │   ├── spec-manager.cjs       Kiro-style wave execution
│   │   ├── impact-analyzer.cjs    pre-change impact analysis
│   │   ├── decision-trail.cjs     decision observability
│   │   ├── metrics.cjs            KPIs + benchmarks
│   │   ├── memory-audit.cjs       memory governance
│   │   ├── mem-curator.cjs        autonomous MemCurator agent
│   │   ├── llms-generator.cjs     llms.txt + knowledge-graph.json
│   │   ├── embeddings.cjs         jina-v2-base-code (bimodal NL-PL)
│   │   ├── health-check.cjs       system diagnostics
│   │   ├── mcp-server.cjs         42 MCP tools
│   │   └── collab-manager.cjs     collaborative sync (Turso)
│   ├── llms.txt              structured project map for external agents
│   ├── llms-full.txt         full knowledge base for agent context
│   ├── knowledge-graph.json  causal graph serialized for Git
│   ├── config.md             project stack and rules
│   └── memoria.db            SQLite — all memory lives here
├── .cursor/mcp.json          auto-configured by akdd init
├── .audit/                   7 specialized QA agents
├── dashboard.cjs             interactive knowledge graph dashboard
├── CLAUDE.md                 activates aa: / ag: / audit: / akdd
└── .cursorrules              Cursor rules
```

---

## Packages

| Package | Version | Description |
|---------|---------|-------------|
| [`agentic-kdd`](https://www.npmjs.com/package/agentic-kdd) | 3.2.0 | CLI — 40+ commands |
| [`agentic-kdd-mcp`](https://www.npmjs.com/package/agentic-kdd-mcp) | 2.2.0 | MCP server — 42 tools |

---

## Compatibility

| IDE / Client | Support |
|---|---|
| **Cursor** | ✅ Full — MCP auto-configured on `akdd init` |
| **Claude Code** | ✅ Full — `claude mcp add` runs automatically |
| **VS Code** | ✅ Via extension scaffold |
| **Windsurf** | ✅ Via MCP manual config |

---

## License

MIT © [Adrianlpz211](https://github.com/Adrianlpz211)

---

<div align="center">

**[npm](https://www.npmjs.com/package/agentic-kdd)** · **[mcp](https://www.npmjs.com/package/agentic-kdd-mcp)** · **[github](https://github.com/Adrianlpz211/Agentic-KDD)**

*A development team of one.*  
*A team becomes a legion.*

</div>
