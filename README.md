<div align="center">

<img src="https://img.shields.io/badge/Agentic_KDD-v2.2-8b5cf6?style=for-the-badge&labelColor=0a0d14" alt="version"/>

# 🧠 Agentic KDD

### Your AI coding partner that actually remembers.

**Other AI tools forget everything the moment you close the tab.**  
**Agentic KDD builds a living memory of your project — and gets smarter every time you code.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/npm/v/agentic-kdd.svg?color=10b981)](https://www.npmjs.com/package/agentic-kdd)
[![Works with Cursor](https://img.shields.io/badge/Works_with-Cursor-3b82f6)](https://cursor.sh)
[![Works with Claude Code](https://img.shields.io/badge/Works_with-Claude_Code-f59e0b)](https://claude.ai/code)

[**Get Started**](#quick-start) · [**How it works**](#how-it-works) · [**Commands**](#commands) · [**Español**](README.es.md)

---

```
You type one line.
Agentic builds, tests, fixes, learns, and documents — automatically.
```

</div>

---

## The problem nobody talks about

You open Cursor. You open Claude Code. You describe your project *again*. The AI starts fresh *again*. It makes the same mistake it made two weeks ago *again*.

You're not coding — you're babysitting context.

**Agentic KDD fixes this** — permanently.

It lives inside your project. It reads your code, learns from every error, remembers every decision, and uses all of it to make the next task smarter than the last. Session after session. Forever.

---

## What happens when you type `aa: build the payments module`

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                                                                     │
  │  1. Context Guard    Validates the task belongs to this project     │
  │                      Checks if related files have risk history      │
  │                      Runs predictions from past episodic memory     │
  │                                                                     │
  │  2. Analyst          Searches 3 memory layers simultaneously        │
  │                      "auth.service.ts failed 3x without migrations" │
  │                      Loads git diff — knows what changed today      │
  │                                                                     │
  │  3. Front Agent      Builds UI                                      │
  │  4. Back Agent       Builds API + logic                             │
  │                                                                     │
  │  5. TDD + Self-Healing                                              │
  │     Generates tests → EXECUTES → reads output                      │
  │     If fail: searches episodic memory → web search → fix           │
  │     Re-executes → max 3 iterations → never gives up silently       │
  │                                                                     │
  │  6. QA Agent         Full test suite — catches regressions         │
  │  7. Review           Code checked against your own project rules   │
  │  8. Memory Agent     Registers episode → syncs graph               │
  │                      Patterns that worked → promoted to ALTA       │
  │                      Unused patterns → temporal decay applied      │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘

  You read the report. You never touched anything in between.
```

---

## New in v2.2 — The Intelligence Upgrade

Agentic went from reactive (learns after the fact) to **predictive** (prevents failures before they happen).

### ⚡ Predictive Engine

Your episodic memory now works for you *before* you make a mistake.

```
You type: aa: refactor auth service

Agentic checks the history:

  🔴 PREDICTION [HIGH]
  auth.service.ts failed 3/4 times in past episodes
  Known reason: migrations weren't run before touching SessionManager
  Fix that worked: run migrations first (80% success rate when done)

  ✓ Precondition detected: Run migrations first?
```

Not guessing. Reading *your own project's history* and connecting the dots.

### 🔍 Git Context

Every `akdd sync` reads your git diff and checks it against memory.

```
akdd sync

  ⚠️  GIT CONTEXT
  Branch: feature/payments

  🔴 [HIGH]  stripe.service.ts — failed 2x
             Last fix: add STRIPE_WEBHOOK_SECRET to .env.local

  🟡 [MEDIUM] session.ts — 1 past failure, proceed with caution
```

Before the AI touches a single file, it already knows which ones are dangerous and why.

### 🧬 Local Embeddings — 100% Offline

Semantic search without any API key. The `all-MiniLM-L6-v2` model (23MB, runs locally) makes memory retrieval go from keyword matching to *understanding*.

```
You search: "how do I handle expired sessions"

Without embeddings:  finds entries with "expired" or "sessions"
With embeddings:     finds "JWT timeout", "token vencido", "session cleanup",
                     "auth refresh loop" — because they mean the same thing
```

Relevance jumps from ~60% to ~90%. Every `aa:` task benefits automatically.

### 🔁 CI/CD Memory Loop

Your repo writes to your memory — even when you're not working.

```bash
akdd ci-install   # one command → GitHub Actions workflow installed
```

Every failed test in CI registers as an episodic memory entry. You show up the next morning and Agentic already knows what broke in the midnight deploy, and why.

---

## How it works

Agentic KDD is built on the **CoALA memory architecture** (Princeton/CMU) — the same taxonomy used by Mem0, LangChain, and Letta — adapted specifically for software development.

```
4 memory layers, always active:

  Working Memory    → active context of the current task
  Procedural        → patterns, errors, decisions (your project's rules)
  Episodic          → raw trajectories — what was tried, why it worked or failed
  Semantic          → entity graph — modules, APIs, dependencies, what breaks what
```

Everything lives in a **SQLite database inside your project** — yours forever, no cloud, no subscription.

```sql
-- Your project's rules, sorted by proven reliability
SELECT * FROM nodos WHERE area = 'auth' AND confianza = 'ALTA';
-- Returns: only rules applied 7+ times with 80%+ success rate

-- Every time this file caused a problem, and exactly what fixed it
SELECT * FROM episodios WHERE archivos_tocados LIKE '%auth.service%' AND resultado = 'fallo';
```

The Analyst queries all 3 layers in **under 5ms** before planning any task.

---

## For everyone — experienced dev or first-time vibe coder

You don't need to understand how any of this works internally.

**If you're new to AI coding:** install it, type `aa: configurar`, describe what you want to build. Agentic handles the rest.

**If you're an experienced dev:** no more re-explaining architecture. No more "the AI ignored my patterns again." Your rules are enforced automatically, every single time.

**Cursor user:** works natively — CLAUDE.md activates everything.  
**Claude Code user:** works natively — type `aa:` in the terminal.  
**Both at the same time:** `_LOCKS.md` coordinates parallel agents.

---

## Quick Start

### Option A — MCP (most automatic) ⭐

```bash
npm install -g agentic-kdd
npm install -g agentic-kdd-mcp
```

Add to Cursor → Settings → Tools & MCPs:
```json
{
  "mcpServers": {
    "agentic-kdd": {
      "command": "node",
      "args": ["YOUR_GLOBAL_PATH/node_modules/agentic-kdd-mcp/server.js"]
    }
  }
}
```

> Find your path: `npm root -g` → append `/agentic-kdd-mcp/server.js`

For Claude Code:
```bash
claude mcp add agentic-kdd -- node $(npm root -g)/agentic-kdd-mcp/server.js
```

Then open any project and type:
```
aa: configurar
```
Done. Agentic reads your project and configures itself.

---

### Option B — CLI

```bash
npm install -g agentic-kdd
cd your-project
akdd init
```

Open in Cursor or Claude Code → type `aa: configurar`

---

### Option C — Manual (no install)

1. Download and unzip to your project root
2. Open in Cursor or Claude Code
3. Type `aa: configurar`

> SQLite works automatically: tries `better-sqlite3` → falls back to `node:sqlite` (Node 22+) → falls back to `sql.js`. Zero configuration needed.

---

### Auto-detected stacks

| Stack | Auto-detected | Pre-loaded rules |
|-------|--------------|-----------------|
| Next.js 14 | ✓ | App Router, Server Components, Supabase |
| Laravel | ✓ | Services, Repositories, Form Requests |
| Node/Express | ✓ | Services layer, error handling |
| React | ✓ | Hooks, state management, API services |
| PHP | ✓ | PDO queries, validation |
| Python/FastAPI | ✓ | Pydantic, SQLAlchemy, pytest |

---

## Commands

### `aa:` — The main pipeline

```bash
aa: configurar              # first-time setup — reads your project automatically
aa: [any task]              # full autonomous cycle
aa: continúa — [answer]     # resume after a STOP
aa: aprende                 # absorb knowledge from work done outside the pipeline
aa: aprende — error: [x]    # register a specific error
aa: aprende — decisión: [x] # register an architectural decision
```

### `aa: sprint` — Chain multiple tasks

```bash
# Explicit chain
aa: sprint — full quality cycle for auth module
  → task 1: audit and generate issues report
  → task 2: fix the BLOCKERs found
  → task 3: generate tests for the failing cases
  → task 4: update documentation

# Short form — Agentic plans the tasks and proposes before executing
aa: sprint — build payments module from zero
aa: sprint skip    # skip current task
aa: sprint abort   # cancel sprint, keep completed work
```

Memory flows between all tasks. Output of task 1 informs task 2. Persists across sessions.

### `ag:` — Improve existing code

```bash
ag: refactor [file]   # respects every architectural decision
ag: test [file]       # tests based on real known errors — not generic templates
ag: doc [file]        # documents the WHY, not just the what
ag: review [file]     # BLOCKER / REQUIRED / SUGGESTED vs your own project rules
```

### `audit:` — 7 independent QA subagents

```bash
audit: auditar      # full audit — all 7 subagents
audit: seguridad    # secrets, auth, vulnerabilities
audit: frontend     # source maps, exposed keys, build artifacts
audit: backend      # endpoints, validation, APIs
audit: datos        # RLS, data leaks, access control
audit: performance  # rate limiting, cache, scaling
audit: codigo       # code quality and Git hygiene
```

### CLI — full command list

```bash
# Setup
akdd init              # install in current project
akdd update            # update engine + agents (memory stays intact)

# Daily
akdd sync              # sync memory + decay + episodic consolidation
akdd analyze           # analyze code → fill semantic entity graph
akdd dashboard         # visual dashboard at localhost:3847

# Memory
akdd coala             # stats: all 4 memory layers
akdd buscar "query"    # hybrid search across all layers
akdd impacto "Module"  # what breaks if you touch this?
akdd predict           # predictive patterns from episodic history

# v2.2 Intelligence
akdd git-context            # risk analysis of current git diff
akdd git-context --install-hook   # auto-run on every branch switch
akdd embed-install          # install local embeddings (23MB, offline)
akdd embed-status           # check embedding engine
akdd ci-install             # install GitHub Actions workflow
akdd ci-status              # last CI/CD reports in memory
```

---

## Visual Dashboard

```bash
akdd dashboard   # http://localhost:3847
```

- **Neural graph** — D3 interactive map of all knowledge and their connections
- **Metrics** — Goal Attainment Rate, Autonomy Ratio, Handoff Integrity, Drift Index
- **Timeline** — every decision and module spec, chronologically
- **Patterns** — usage bars and confidence levels
- **Errors** — known issues with resolution history
- **Onboarding** — setup progress for new team members

---

## The STOP Protocol — honest over hallucinated

When something can't be completed after 2 attempts, Agentic stops with a precise report. Never loops. Never invents.

```
🛑 STOP — Back agent

Task:     persist expiry_date in warehouse table
Phase:    2 of 3
Attempts: 2

Error:    "Invalid column name 'expiry_date'"
Reason:   Column doesn't exist. Migration not run.

→ aa: continúa — run: ALTER TABLE warehouse ADD expiry_date DATE NULL
```

---

## Autonomy level

```
L1  You re-explain everything every session
L2  Basic memory — it remembers some things
L3  ← Agentic KDD v2.2
        Prevents failures before they happen
        Learns from CI/CD automatically
        Semantic search always loaded
L4  Full project autonomy
L5  Self-improving codebase
```

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT — use it, fork it, build on it.

---

<div align="center">

**The AI that finally remembers your project.**

Made with 🧠 by [@Adrianlpz211](https://github.com/Adrianlpz211)

[npm](https://www.npmjs.com/package/agentic-kdd) · [GitHub](https://github.com/Adrianlpz211/Agentic-KDD) · [Español](README.es.md)

*If Agentic KDD saved you time → ⭐*

</div>
