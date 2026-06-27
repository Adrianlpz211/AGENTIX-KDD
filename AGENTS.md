# AGENTS.md — Agentic KDD

> Canonical instruction file for all AI coding agents.
> Adopted standard by the Linux Foundation (AAIF), read natively by:
> Codex CLI, Cursor, Windsurf, GitHub Copilot, Zed, Warp, Aider, Devin, Jules, Kiro, RooCode and more.
>
> This file is the single source of truth.
> Derived files: CLAUDE.md, .cursor/rules/agentic.mdc, .github/copilot-instructions.md, GEMINI.md

---

## What is this project

This project uses **Agentic KDD (Knowledge-Driven Development)** — a framework where every development session accumulates knowledge into a persistent graph that all future cycles build on.

The `.agentic/` directory contains:
- `memoria.db` — SQLite knowledge graph (patterns, errors, decisions, causal edges)
- `grafo/` — 28 Node.js modules (memory, AST, pipeline, preservation, telemetry)
- `agentes/` — agent instructions per role
- `telemetria/` — append-only JSONL execution traces (L4 audit requirement)
- `checkpoint.md` — session continuity across chat resets

---

## Development protocol: `aa:`

**Trigger:** any message starting with `aa:` initiates the full autonomous pipeline.

```
aa: implement JWT authentication with refresh token rotation
aa: fix the dashboard data loading issue
aa: refactor the payment module to use the new Stripe API
```

**What happens automatically** (developer never types these):
1. **Analyst** — reads memory via `recall()`, plans phases
2. **Build** — implements within the plan
3. **TDD Gate** — runs tests, self-heals up to 3×
4. **QA** — verifies acceptance criteria
5. **Preservation Gate** — verifies verified contracts still pass
6. **Review** — automatic code review against KDD memory
7. **Memory** — syncs graph via `remember()`, causal edges, telemetry
8. **Creative Engine** — detects improvement opportunities

**Auto-detection (when `aa:` is forgotten):**
If a message starts with an action verb without `aa:`, treat it as `aa:` and execute the pipeline.
Print before executing: `🔄 Detected development task — running as aa:`

Action verbs: implement, create, fix, add, modify, refactor, connect, integrate, build, develop, correct, update, generate, implementa, crea, arregla, agrega, añade, modifica, conecta, construye, desarrolla, corrige, actualiza

Do NOT treat as `aa:` if: ends in `?`, starts with explain/what/how/why, or is a status query.

---

## Session recovery

If the user pastes a block starting with `# Checkpoint Agentic KDD`:
1. Load the context from the checkpoint
2. Respond: "✅ Context recovered — continuing from: [last task]"
3. Proceed with full context

---

## Other agents

```
ag: review <file>     — code review against KDD memory (also auto-runs in every aa:)
ag: test <module>     — generate test suites from error history
ag: refactor <file>   — refactor with pre-change impact analysis
ag: doc <module>      — technical documentation from code + memory
```

---

## Audit department

```
audit: auditar        — full audit (7 agents in parallel)
audit: seguridad      — security only
audit: backend        — backend only
audit: performance    — performance only
```

---

## CLI tools (callable from chat via MCP)

```
akdd health           — system diagnostic
akdd dashboard        — open visual knowledge graph
akdd contracts        — contract guard status
akdd contracts blast <file>  — blast radius before touching a file
akdd historial        — session checkpoint for chat recovery
akdd report           — effectiveness report (before/after comparison)
akdd decide <file>    — autonomous decision: STOP/WARN/IMPLEMENT/DEFER
akdd collab invite    — generate team invite code
```

---

## Memory protocol

Agents use ranked retrieval — NOT full file reads.

**Reading memory** (at start of every `aa:` cycle):
```
Tool: recall(query, top_k=10)
Returns: top-K ranked entries by BM25 + vector similarity + temporal decay
Do NOT read errores.md, patrones.md, decisiones.md directly
```

**Writing memory** (at end of every `aa:` cycle):
```
Tool: remember(entry, { tipo, area, confianza, archivos })
Validates: no duplicate, hash_contexto computed, frontmatter added
```

**Validating before applying** (for patterns > 30 days old):
```
Tool: validate_knowledge(node_id)
Returns: { trusted, status, recommendation }
If status === SOSPECHOSO → verify before applying
If status === OBSOLETO → do not apply
```

---

## Guardrails (always active)

- **Preservation Gate**: if a change would break a PROTECTED contract → STOP
- **Blast radius**: if blast radius is CRITICAL → STOP
- **Prerequisite chain**: if a dependency has broken contracts → fix prerequisite first
- **NEVER** modify files listed in `.agentic/protected_files` directly
- **NEVER** run `rm -rf`, database migrations, or deploys without explicit confirmation

---

## Dry-run mode

```
aa: --dry-run implement JWT authentication
```

Pipeline runs Analyst→Build but outputs a **proposed diff** without writing files.
Use before risky changes to validate the plan.

---

## Telemetry

Every `aa:` cycle writes to `.agentic/telemetria/trace_[ciclo_id].jsonl`.
Every STOP is recorded with full reason.
Every `recall()` and `remember()` is recorded.
This is the L4 audit trail.

---

## Important project files

```
.agentic/config.md       — project stack, rules, conventions
.agentic/memoria.db      — knowledge graph (SQLite)
.agentic/checkpoint.md   — last session checkpoint
.agentic/telemetria/     — execution traces (JSONL, append-only)
.agentic/agentes/        — per-role agent instructions
CLAUDE.md               — Claude Code specific (derived from this file)
.cursorrules             — Cursor specific (derived from this file)
```

---

*Agentic KDD — A development team of one. A team becomes a legion.*
*npm: agentic-kdd | agentic-kdd-mcp*
