<div align="center">

# Agentic KDD

**A development team of one.**  
**A team becomes a legion.**

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

**Agentic KDD solves this at the infrastructure level.** Not with a bigger context window — with persistent memory that lives inside your project, learns from every cycle, and gets smarter over time.

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

This is why KDD isn't a wrapper around Claude. It's a methodology for making AI-assisted development actually compound over time.

---

## How it works

Agentic KDD lives inside your project as a `.agentic/` directory — a local SQLite database, a set of specialized agents, and a pipeline that runs automatically when you type `aa:`.

```bash
aa: implement JWT authentication with refresh token rotation
```

That single command triggers a pipeline that runs without interrupting you:

```
① Analyst      — reads memory, AST graph, ADRs, specs, plans all phases
② Build        — frontend / backend agents implement within the plan
③ TDD Gate     — runs tests, parses output, self-heals up to 3× automatically
④ QA           — verifies acceptance criteria against the full test suite
⑤ ag:review    — automatic code review against accumulated KDD memory
⑥ Memory       — syncs graph, causal edges, specs, observability
```

**The developer never types `ag: test` or `ag: review`. They run automatically.**

The critical difference from every other agent framework is in step ③. The TDD gate is a deterministic check in Node.js code — not a prompt suggestion. The agent cannot declare tests passing without actually running them. The gate rejects progress without proof.

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
├── EPISODIC MEMORY     Raw history of what happened in every cycle
├── SEMANTIC MEMORY     Project entity graph, AST, module relationships
└── PROCEDURAL MEMORY   Patterns, errors, decisions — rules that apply every cycle
```

Every memory node carries a confidence signal updated automatically:

```
LOW    → suggestion, not enforced
MEDIUM → applied and mentioned in every plan
HIGH   → fixed rule, applied on every cycle without exception

Applied ≥ 3×  +  utility ≥ 70%  →  auto-promoted to MEDIUM
Applied ≥ 7×  +  utility ≥ 80%  →  auto-promoted to HIGH
Unused for 60 cycles             →  auto-degraded (temporal decay)
```

Beyond the four CoALA layers, Agentic KDD adds three knowledge structures specific to software development:

- **AST Graph** — symbols, imports, call graph, PageRank across 12 languages
- **Causal Edges** — `caused_failure`, `was_fixed_by`, `tested_by`, `regressed_by` — bi-temporal, never deleted, only invalidated
- **Knowledge Docs** — ADRs, gotchas, conventions ingested from `docs/adr/`

---

## The five phases

### Phase 0 — Harness

Deterministic enforcement gates. The piece missing from every other agent framework.

`harness.cjs` runs PRE/EXEC/POST checks on every pipeline step. `tdd-gate.cjs` is a Node.js loop that detects your test command, runs it, parses the output (Jest, Vitest, Mocha, pytest), and retries up to three times automatically. The agent cannot lie about test results.

### Phase 1 — Discernment

Before planning any change, the agent has a complete structural map of the project. `ast-indexer.cjs` builds an AST graph across 12 languages with PageRank scoring. `causal-edges.cjs` tracks what broke what, what fixed what, what tests cover what — bi-temporally, with full history preserved.

### Phase 2 — Knowledge Base

`adr-ingestor.cjs` parses Architecture Decision Records in MADR format and converts them to typed graph edges — no LLM required. `knowledge-ingestor.cjs` ingests gotchas, conventions, and runbooks. The agent understands not just what the code does, but why it was built that way.

### Phase 3 — Autonomy

`spec-manager.cjs` implements Kiro-style specs with wave execution. Wave 1 contains tasks with no dependencies. Wave N depends on Wave N-1. The agent executes the right wave every time. `impact-analyzer.cjs` runs a pre-change impact analysis combining AST structure, causal memory, and the knowledge base before touching anything — returning CRITICAL, MEDIUM, or LOW severity.

### Phase 4 — Collaborative Mode

`collab-manager.cjs` syncs the local SQLite memory to a shared Turso database. Multiple developers share one knowledge base. What one developer learns, the agent knows for everyone.

```
Dev A discovers that touching auth.ts breaks session.ts
                        ↓ auto-sync to Turso
Dev B already knows it before touching auth.ts
Dev C joins the team → gets 6 months of project knowledge from day one
```

Team members join with a single invite code generated by `akdd collab invite` — no credentials to share manually, no Turso account required for team members.

---

## Memory governance — MemCurator

`mem-curator.cjs` is an autonomous governance agent that runs automatically every 10 cycles. It handles what no other agent framework addresses explicitly:

- **TTL enforcement**: episodic memory older than 30 days is compressed into summaries and archived after 90 days
- **Semantic deduplication**: nodes with Jaccard similarity above 0.92 are merged, preserving the higher-confidence version
- **Conflict resolution**: when new code supersedes an old rule, the old rule is marked `HISTORICO` with an explicit supersession link — not deleted
- **Relevance scoring**: every node is scored continuously using `S(k) = similarity × exp(-λ × Δt) × log(1 + usage_count)`
- **Node limit**: active procedural memory is capped at 1000 nodes; low-utility candidates are deprecated automatically

The MemCurator is intentionally decoupled from the development agents. It has no interest in preserving its own past decisions — it only governs quality.

---

## Embeddings

The default embedding model is `jina-embeddings-v2-base-code` — a bimodal NL-PL model trained specifically on code. It understands type relationships, AST structures, and control flow semantics. `all-MiniLM-L6-v2` is available as a lightweight fallback (~23MB vs ~500MB) for environments where storage is constrained.

```bash
akdd jina-install    # bimodal NL-PL model — recommended
akdd embed-install   # all-MiniLM-L6-v2 — lightweight fallback
```

---

## Discoverability

Every `akdd sync` generates three files automatically:

- `.agentic/llms.txt` — structured project map for external agents. Architecture, active rules, known pitfalls, available MCP tools. The equivalent of `robots.txt` but for LLMs.
- `.agentic/llms-full.txt` — expanded version with all active patterns, causal memory, and ADRs.
- `.agentic/knowledge-graph.json` — the full causal graph serialized for Git versioning. The graph travels with the repository.

---

## Installation

```bash
npm install -g agentic-kdd
cd my-project
akdd init
```

`akdd init` detects your stack, downloads the latest files from GitHub, configures the MCP server in Cursor automatically, and optionally registers with Claude Code. Open the project in your IDE and run:

```
aa: configure
```

The system maps your codebase once. After that, every `aa:` cycle builds on accumulated knowledge.

**Requirements:** Node.js 18+, Cursor or Claude Code (or any MCP-compatible client).

---

## CLI reference

### Setup

```bash
akdd init              # Deploy Agentic KDD in the current project
akdd update            # Update agents + modules — memory stays intact
akdd health            # Full system diagnostic
akdd health --fix      # Auto-fix detected issues
akdd mcp               # Auto-configure MCP in Cursor / Claude Code
akdd mcp status        # Check MCP configuration
```

### Memory

```bash
akdd sync              # Sync markdown → SQLite graph
akdd coala             # Stats across all 4 CoALA memory layers
akdd buscar "query"    # Hybrid search across all memory
akdd decay             # Apply temporal decay to inactive patterns
akdd audit             # Memory audit: stale, contradictions, proposals
akdd forget <id>       # Invalidate a memory entry with documented reason
akdd cure              # Run MemCurator — TTL, dedup, conflicts, scores
akdd cure report       # Preview what curation would do (no changes)
```

### AST & impact

```bash
akdd ast               # Index project into the AST graph
akdd ast stats         # AST index stats
akdd ast-impact <file> # Full impact analysis (AST + causal + knowledge)
akdd why <entity>      # Why does this exist? Full causal chain.
akdd causal-prune      # Prune causal graph to prevent context overflow
```

### Specs

```bash
akdd spec list                     # List all module specs
akdd spec <module>                 # Status + next execution wave
akdd spec create <module>          # Create a feature spec
akdd spec create <module> --bugfix # Create a bugfix spec
```

### Knowledge base

```bash
akdd adr               # Ingest ADRs from docs/adr/
akdd knowledge         # Ingest gotchas and conventions
```

### Metrics & observability

```bash
akdd metrics           # Project KPIs: success rate, rework, autonomy score
akdd metrics trend     # Trend across last 10 cycles
akdd trail             # Recent decision trails
akdd trail <cycle_id>  # Full trail: what changed, why, what memory influenced it
akdd trail why <file>  # Why does this file or module exist?
akdd benchmarks        # LongMemEval + Token Reduction + Memory Quality scores
akdd llms              # Generate llms.txt + knowledge-graph.json
```

### Collaborative mode

```bash
akdd collab init              # Activate — creates shared DB automatically
akdd collab invite            # Generate invite code (24h, one use)
akdd collab join <code>       # Join with an invite code
akdd collab push              # Push your learnings to the team
akdd collab pull              # Pull the team's latest learnings
akdd collab status            # Check sync status
```

### Embeddings

```bash
akdd jina-install      # Install jina-embeddings-v2-base-code (~500MB, code-optimized)
akdd embed-install     # Install all-MiniLM-L6-v2 (~23MB, lightweight fallback)
```

### Intelligence

```bash
akdd git-context       # Git diff analysis + risk assessment from episodic memory
akdd predict           # Predictive risk patterns
akdd ci-install        # Install GitHub Actions CI/CD memory workflow
akdd dashboard         # Open interactive knowledge graph dashboard
```

---

## MCP Server — 34 native tools

After `akdd init`, Cursor and Claude Code discover the MCP server automatically. Every capability is available directly in the IDE chat — including commands that previously required a terminal.

**`akdd init` configures MCP automatically** in both Cursor and Claude Code. You don't need to touch any config file.

- **Cursor** — `akdd init` writes `.cursor/mcp.json` at the project root. Cursor reads it automatically. Reload the window and the 34 tools appear in the chat.
- **Claude Code** — `akdd init` runs `claude mcp add agentic-kdd` automatically if the CLI is installed.
- **Switching IDEs / reconfiguring** — `akdd mcp` handles both in one command and prints the exact manual JSON with your real system path (not a placeholder) if you need it.

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

**CLI from chat (6):** `init_project` · `update_project` · `collab_init` · `collab_invite` · `collab_status` · `system_health`

---

## Audit Department

A separate QA system that runs deep project-wide audits, independent from the `aa:` development pipeline. Where `aa:` validates individual tasks, the Audit Department reviews the project as a whole.

```
audit: auditar     # full audit — all 7 agents in parallel
audit: seguridad   # security only — secrets, auth, vulnerabilities
audit: frontend    # frontend only — source maps, keys, build artifacts
audit: backend     # backend only — endpoints, validation, exposed APIs
audit: datos       # database only — schema, RLS, query exposure
audit: performance # performance only — rate limiting, cache, scalability
audit: browser     # real browser QA
audit: codigo      # code quality and Git hygiene
audit: help        # show all available commands
```

Audits run without touching code. Output goes to `_output/audit-[date].md`.

The 7 specialized agents:

| Agent | Focus |
|-------|-------|
| `00-director` | Orchestrates the full audit, consolidates reports |
| `01-seguridad` | Exposed secrets, auth weaknesses, injection risks |
| `02-frontend` | Build artifacts, source maps, client-side key exposure |
| `03-backend` | Endpoint security, input validation, API surface |
| `04-datos` | Database schema, RLS policies, query exposure |
| `05-performance` | Rate limiting, caching strategy, scalability bottlenecks |
| `06-browser` | Real browser QA against the running application |
| `07-codigo` | Code quality, dead code, Git history hygiene |

---

## Pro agents

Beyond the core pipeline, four specialized agents handle operations that run independently:

| Agent | Invocation | What it does |
|-------|------------|--------------|
| `ag:review` | `ag: review <file>` | Code review against KDD memory. Also runs automatically in every `aa:` cycle. |
| `ag:test` | `ag: test <module>` | Generates test suites based on error history and causal edges for the module. |
| `ag:refactor` | `ag: refactor <file>` | Refactors with pre-change impact analysis. Won't proceed if impact is CRITICAL. |
| `ag:doc` | `ag: doc <module>` | Technical documentation generated from code + project memory. |

---

## Switching IDEs

Memory lives in the project, not the IDE. When switching from Cursor to Claude Code or back:

```bash
akdd mcp
```

That's the only step. Everything else is already there.

---

## Updating an existing project

```bash
akdd update
```

Downloads the latest modules from GitHub. Schema migrations run automatically on the next cycle. Memory stays intact.

---

## What Agentic KDD is not

It is not a chat interface, an IDE, or a replacement for Git. It does not require an internet connection after setup. It does not send your code anywhere. It does not depend on a SaaS backend.

It is infrastructure. It runs inside your project, it travels with your repository, and it compounds over time.

---

## Project structure after `akdd init`

```
your-project/
├── .agentic/
│   ├── agentes/              9 specialized agents + 4 pro
│   ├── grafo/                23 Node.js modules
│   │   ├── grafo.cjs              CoALA v3 memory engine
│   │   ├── harness.cjs            deterministic pipeline enforcement
│   │   ├── tdd-gate.cjs           mechanical self-healing loop
│   │   ├── ast-indexer.cjs        AST graph (12 languages)
│   │   ├── causal-edges.cjs       bi-temporal causal memory + pruning
│   │   ├── adr-ingestor.cjs       knowledge base (ADRs)
│   │   ├── spec-manager.cjs       Kiro-style wave execution
│   │   ├── impact-analyzer.cjs    pre-change impact analysis
│   │   ├── decision-trail.cjs     decision observability
│   │   ├── metrics.cjs            project KPIs + benchmarks
│   │   ├── memory-audit.cjs       memory governance + vigencia_tipo
│   │   ├── mem-curator.cjs        autonomous MemCurator agent
│   │   ├── llms-generator.cjs     llms.txt + knowledge-graph.json
│   │   ├── embeddings.cjs         jina-v2-base-code (bimodal NL-PL)
│   │   ├── health-check.cjs       system diagnostics
│   │   ├── mcp-server.cjs         34 MCP tools
│   │   └── collab-manager.cjs     collaborative sync (Turso)
│   ├── memoria/              patterns · errors · decisions (.md)
│   ├── specs/                module specs with wave execution
│   ├── conocimiento/         ADRs · gotchas · conventions
│   ├── llms.txt              structured project map for external agents
│   ├── llms-full.txt         expanded knowledge base for agent context
│   ├── knowledge-graph.json  serialized causal graph for Git versioning
│   ├── config.md             project stack, modules, rules
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
| [`agentic-kdd`](https://www.npmjs.com/package/agentic-kdd) | 3.1.0 | CLI — init, update, health, ast, metrics, trail, collab, cure, llms, benchmarks |
| [`agentic-kdd-mcp`](https://www.npmjs.com/package/agentic-kdd-mcp) | 2.1.0 | Standalone MCP server — 34 tools for Cursor and Claude Code |

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
