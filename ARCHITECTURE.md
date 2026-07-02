# Agentix KDD — Architecture

> **One-line summary:** Agentix KDD is a development OS for AI agents — it gives your coding agent persistent memory, enforced quality gates, and a self-healing pipeline across every session.

---

## How it fits together

```
┌─────────────────────────────────────────────────┐
│              Your project (any stack)            │
├───────────────────┬─────────────────────────────┤
│  Memory           │  Gates                       │
│  CoALA 4-layer    │  Spec · TDD · Security ·     │
│  SQLite           │  Regression · Contract        │
├───────────────────┴─────────────────────────────┤
│         Pipeline  →  aa: [task]                  │
│  Analyst → Build → TDD×3 → QA → Review → Memory │
├─────────────────────────────────────────────────┤
│  Engine  (.agentic/grafo/ — 39 modules)          │
├─────────────────────────────────────────────────┤
│  Interfaces: CLI (akdd) · MCP (54 tools) · Dash  │
└─────────────────────────────────────────────────┘
```

---

## Tier 1 — Core

These modules run on every `aa:` cycle. They are the backbone of the system. Do not remove or modify them without understanding their full impact.

| Module | Role |
|---|---|
| `grafo.cjs` | Central dispatcher — coordinates all subcommands |
| `post-cycle.cjs` | 10-step cycle orchestrator — runs after every task |
| `schema.sql` | SQLite schema — 11 tables, 31 indexes |
| `tdd-gate.cjs` | TDD enforcement with self-healing loop (×3) |
| `security-gate.cjs` | Secrets · PII · prompt-injection · auth checks |
| `regression-guard.cjs` | Blocks changes that break verified behaviors |
| `contract-guard.cjs` | Tracks candidate → verified → protected contracts |
| `spec-gate.cjs` | Validates changes against business rules in memory |
| `install-hooks.cjs` | Git post-commit hook — triggers post-cycle in background |
| `git-hooks/post-commit` | Shell hook — always exits 0, never blocks commits |
| `mcp-server.cjs` | MCP server — 54 tools exposed via stdio |
| `embeddings.cjs` | Hybrid memory search (Jina v2 code + BM25 fallback) |

**Entry point for users:** `aa: [task]` → pipeline runs automatically.

---

## Tier 2 — Stable Extensions

These modules are implemented, tested in production use, and add significant capability. They activate automatically inside the pipeline or via explicit `akdd` commands.

| Module | Role | How it activates |
|---|---|---|
| `ast-indexer.cjs` | Indexes code structure (symbols, deps) | `post-cycle` Step 10, `akdd ast` |
| `impact-analyzer.cjs` | Predicts blast radius before changes | Analista phase |
| `causal-edges.cjs` | Tracks what caused what across cycles | Analista phase |
| `spec-manager.cjs` | Creates and enforces module specs | Analista phase |
| `memory-audit.cjs` | Audits memory health and vigencia | `akdd audit` |
| `mem-curator.cjs` | Governs memory decay and consolidation | `akdd cure` |
| `lock-manager.cjs` | Multi-instance collision prevention | `aa:` start/end |
| `harness.cjs` | Property-based test harness | TDD phase |
| `adr-ingestor.cjs` | Ingests architectural decisions | Analista phase |
| `knowledge-ingestor.cjs` | Ingests gotchas and conventions | Analista phase |
| `decision-trail.cjs` | Logs every decision with context | `akdd why <file>` |
| `git-context.cjs` | Enriches memory with git history | `post-cycle` |
| `metrics.cjs` | Project-wide quality metrics | `akdd metrics` |
| `effectiveness-report.cjs` | Measures pattern effectiveness over time | `akdd benchmarks` |
| `health-check.cjs` | System health validation | `akdd health` |
| `llms-generator.cjs` | Generates llms.txt for AI discoverability | `akdd llms` |
| `dashboard.cjs` | Web dashboard — cycles, contracts, memory, audit | `akdd` (opens browser) |
| `collab-manager.cjs` | Multi-developer shared memory *(beta)* | `AKDD_COLLAB_ENABLED=1` |

---

## Tier 3 — Experimental

These modules exist and work, but are newer, less validated in production, or require more usage to reach Tier 2. They will not break the core pipeline if they fail — all are wrapped in try/catch with silent fallback.

| Module | What it does | Status |
|---|---|---|
| `reasoning-bank.cjs` | Learns strategies from successful cycles (EMERGING→PROVEN) | New — Mark 3 |
| `creative-engine.cjs` | Detects improvement opportunities autonomously | Active, limited usage data |
| `autonomous-decision.cjs` | Self-directed decision making across cycles | Active, limited usage data |
| `prediccion.cjs` | Predicts likely failure points before build | Active, limited usage data |
| `cicd.cjs` | CI/CD pipeline integration | Active, not benchmarked |
| `watch-errors.cjs` | Real-time error pattern detection | Active, not benchmarked |
| `session-guard.cjs` | Session isolation and state protection | Active, not benchmarked |
| `knowledge-validator.cjs` | Validates knowledge base consistency | Active, not benchmarked |
| `akdd-analyze.cjs` | Deep project analysis CLI | Active, not benchmarked |

**Promotion path:** A module moves from Tier 3 → Tier 2 when it has been used across 5+ real project cycles without regressions and has measurable impact in `effectiveness-report`.

---

## Agent Layer

Instructions in `.agentic/agentes/` — these define HOW each agent behaves inside the pipeline. They are not code, they are prompts consumed by the AI.

| Agent | Role |
|---|---|
| `01-orquestador.md` | Coordinates the full pipeline |
| `02-analista.md` | Converts task → technical plan (supports Legión parallel mode) |
| `03-front.md` / `04-back.md` | Implements the plan |
| `05-qa.md` | Validates with 4 parallel lenses (Legión mode) |
| `06-tdd.md` | TDD gate enforcement |
| `07-memoria.md` | Syncs knowledge graph after each cycle |
| `08-aprende.md` | Absorbs knowledge from work done outside the pipeline |
| `09-sprint.md` | Chains multiple tasks with shared memory |
| `pro/` | Specialized agents: review, refactor, test, doc |

---

## Memory Schema — 4-layer CoALA

| Layer | What it stores | Tables |
|---|---|---|
| **Working** | Active task context | `working_memory` |
| **Procedural** | Patterns, errors, decisions | `patterns`, `errors`, `decisions` |
| **Episodic** | What was attempted, cycles, contracts | `episodes`, `ciclos`, `verified_contracts` |
| **Semantic** | Module graph, embeddings, causal edges | `semantic_nodes`, `semantic_edges`, `embeddings`, `causal_edges` |

All memory lives in `.agentic/memoria.db` — a local SQLite file. Never committed to git.

---

## What is NOT in this repo

- Cloud backend (all local by default)
- Collab infrastructure (Turso + Cloudflare Worker — separate, opt-in via env var)
- Benchmark project code (separate repository — coming)
- IDE extensions (VS Code extension in `vscode-extension/` — pre-release)
