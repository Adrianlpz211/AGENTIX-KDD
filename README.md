<div align="center">

<img src="assets/logo.svg" alt="Agentix KDD" width="600">

### The armor for your AI coder.

<p>
<img src="https://img.shields.io/badge/version-3.8.3-3FE2E8?style=for-the-badge&labelColor=0A0E14" alt="version"/>
<img src="https://img.shields.io/badge/license-MIT-D9A33C?style=for-the-badge&labelColor=0A0E14" alt="license"/>
<img src="https://img.shields.io/badge/Claude_Code_·_Cursor-ready-8A97A6?style=for-the-badge&labelColor=0A0E14" alt="compat"/>
</p>

**A development team of one.**

English · [Español](README.es.md)

</div>

---

## What it is

**Agentix KDD** isn't another AI that codes for you. It's the **armor** you put on the AI you already use — natively on **Claude Code and Cursor** — so it **remembers, doesn't break what was working, and doesn't contradict itself**.

It lives **inside your project**: it reads your code, saves every decision and every error to a persistent memory, and uses all of it to make the next task safer than the last. You keep using your editor; Agentix shields it from underneath.

> *KDD = Knowledge-Driven Development — development guided by the project's own accumulated knowledge. (npm package: `agentic-kdd`.)*

---

## The problem it solves

You open Cursor or Claude Code. You explain your project *again*. The AI starts from zero *again*. It breaks something that was working *again*. It changes a business rule without remembering why it was set that way.

You're not coding — you're babysitting the context by hand. **Agentix takes that over.**

---

## The three pieces of the armor

| | Piece | What it does |
|---|-------|--------------|
| ⚓ | **Anchor** — memory | Remembers decisions, rules and errors across sessions. Real semantic search (local embeddings) surfaces what's relevant at the right moment. |
| 🔧 | **Lever** — verification | Before accepting a change, it **runs the tests and confirms nothing that worked got broken**. If something breaks, it says so — it never reports a false "green". |
| 🔨 | **Hammer** — autonomy | Finds and fixes problems on its own (security included) and reports back. You read the result. |

---

## How it works

Agentix uses a **4-layer memory** (CoALA architecture) stored in **SQLite inside your project** — yours, no cloud, no subscription:

```
Working     → context of the current task
Procedural  → patterns, errors and decisions (your project's rules)
Episodic    → what was tried, in what order, why it worked or failed
Semantic    → graph of modules, APIs and dependencies — what breaks what
```

On top of that memory run the **gates** that protect your work:

- **Spec Gate** — stops a change that contradicts a saved business rule (e.g. changing a fixed rate) and asks for confirmation.
- **Regression Guard + TDD Gate** — run the real suite; if a change breaks a test that was passing, they stop.
- **Security Gate** — reviews sensitive files (auth, multi-tenant) before writing.

---

## Quick start

```bash
# 1. Install the CLI
npm install -g agentic-kdd

# 2. In your project
cd your-project
akdd init

# 3. Open in Claude Code or Cursor and type:
aa: configurar
```

Done. Agentix reads your project and configures itself. From there, every task starts with `aa:`.

---

## Compatibility

Agentix is **first-class on Claude Code and Cursor** — that's where it's **battle-tested**. Because its engine is built on **open standards** (`AGENTS.md` and **MCP**), it *should* also work with other agents (VS Code, Windsurf, Kiro, Aider…), but in the interest of honesty: **so far it's only thoroughly tested on Claude Code and Cursor**. If you try it on another IDE and it works, open an issue and we'll add it to the "tested" list.

---

## Commands — what runs on its own vs what you run

> **Legend:** 🟢 automatic (runs by itself) · 🔵 trigger (you type it in chat) · ⚪ manual (terminal, only when needed)

### 🟢 What happens on its own — you type nothing

Since v3.7+, this is recorded **automatically, in the background, at zero token cost**:

| When | What happens automatically |
|------|----------------------------|
| On every git **commit** | Closes the cycle: **registers the cycle**, **accumulates contracts**, indexes the code (incremental AST), syncs the graph |
| Every **5 cycles** | Saves a **checkpoint** to resume in another chat or machine |
| Inside every **`aa:`** | Reads memory, runs tests (TDD Gate), QA, the contract gate, review, and saves what it learned |
| On **`akdd init`** in a project with code | Runs `onboard` + `ast` + `sync` to seed the dashboard |
| On **install / update** | Installs the git hook by itself |

### 🔵 What you type in chat — pipeline triggers

| Command | What it does |
|---------|--------------|
| `aa: [any task]` | Full pipeline: analyze · build · test · learn |
| `aa: sprint — [goal]` | Chains several tasks; memory flows between them |
| `aa: aprende` | Absorbs knowledge from work done outside the pipeline |
| `audit: auditar` · `audit: seguridad` | QA department — audits, **never touches code** |

It also exposes **54 MCP tools** for compatible clients (Claude Code, Cursor, any stdio MCP client).

> The command vocabulary (`aa:`, `audit:`, `akdd buscar`…) is in Spanish — the task you write after `aa:` can be in any language.

---

## ⚪ Full CLI reference (manual)

Everything below is **manual** — run it only when you need it. The automatic behavior is in the section above.

### Setup & lifecycle
```bash
akdd init                      # Deploy Agentix KDD in a new project
akdd onboard                   # Onboard an existing (brownfield) project
akdd update                    # Update the engine from GitHub (memory stays intact)
akdd sync                      # Sync memory + knowledge graph
akdd hooks [status]            # Install / check the automatic git hook
akdd mcp                       # (Re)configure MCP for Cursor / Claude Code / VS Code
akdd health [--fix]            # System diagnostics (--fix repairs what it can)
akdd dashboard                 # Visual board at localhost:3847
```

### Memory & knowledge graph
```bash
akdd buscar "query"            # Hybrid semantic + BM25 search across memory
akdd recall "query"            # Recall relevant memory for a task
akdd historial                 # Resume checkpoint — paste into a new chat
akdd checkpoint                # Create a session checkpoint now
akdd graph                     # Knowledge graph summary
akdd stats                     # Memory statistics
akdd why <file|entity>         # Why does this exist — decision trail
akdd trail <id>                # Full decision trail for an entity
akdd forget <id> "<reason>"    # Remove a memory node (audited)
akdd decay                     # Apply time-decay to stale nodes
akdd cure [run|report]         # MemCurator — autonomous memory governance
akdd memory                    # Memory overview
```

### Contracts & gates (Preservation Layer)
```bash
akdd contracts                 # Contract Guard status (protected/verified/candidate)
akdd contracts gate            # Run the contract gate manually
akdd validate                  # Validate knowledge consistency
akdd predict <file>            # Predict regression risk before editing
akdd impacto <file|module>     # Impact analysis — what breaks if this changes
akdd ast-impact <file>         # AST-level impact analysis
```

### Creative Engine
```bash
akdd creative suggest          # Generate improvement suggestions
akdd creative apply <id>       # Apply a suggestion
akdd creative dismiss <id>     # Dismiss a suggestion
akdd creative level            # Show autonomy level (assisted → autonomous)
akdd creative wins             # Show applied improvements
akdd creative stats            # Creative Engine statistics
```

### AST & code intelligence
```bash
akdd ast index [target]        # Index the codebase (symbols, dependencies)
akdd ast stats                 # AST index statistics
akdd ast symbols <file>        # List symbols in a file
akdd git-context               # Current git context for the agent
```

### QA / Audit department 🔵 (in chat — audits only, never touches code)
```bash
audit: auditar                 # Full audit — 7 subagents in parallel
audit: seguridad               # Security — secrets, auth, vulnerabilities
audit: frontend                # Frontend — source maps, leaked keys, build
audit: backend                 # Backend — endpoints, validation, APIs
audit: datos                   # Data — RLS, exposed DB, leaks
audit: performance             # Performance — rate limiting, cache, scalability
audit: browser                 # Real-browser QA
audit: codigo                  # Code quality & Git
audit: help                    # Show the audit menu
```
> Reports are saved to `_output/audit-[date].md` and `.audit/reporte-actual.md`.
> To fix a finding: `aa: corrige el hallazgo SEG-01` (or just ask in chat).

### Observability ⚪ (terminal)
```bash
akdd audit                     # Memory audit report (stale / conflicting nodes)
akdd telemetry                 # Telemetry report
akdd report                    # Effectiveness report (before/after)
akdd metrics                   # Project metrics
```

### Multi-instance (Lock Manager)
```bash
akdd locks                     # Lock status — who owns what
akdd locks acquire --module=X  # Acquire a module lock
akdd locks release --module=X  # Release a module lock
akdd locks check --files=...   # Check if files are locked
akdd locks acquire-schema      # Acquire the schema lock (before migrations)
akdd locks release-schema      # Release the schema lock
akdd locks wait --module=X     # Block until a module is free
akdd locks release-all         # Release all locks (session cleanup)
```

### Collaboration (team sync) — 🔒 private beta
> Shared **team memory** is in **private beta** and not enabled for public use yet. Everything
> else in Agentix works **100% locally, no account required** — collaboration is the only piece
> that's still gated. Want it for your team? [Open an issue](https://github.com/Adrianlpz211/AGENTIX-KDD/issues).

### Specs & planning
```bash
akdd spec create <module>      # Create a spec for a module
akdd spec                      # List specs
akdd sprint-plan               # Plan a multi-phase sprint
akdd benchmarks                # Run / view benchmarks
```

### Embeddings (semantic search)
```bash
akdd embed-status              # Embedding index status
akdd embed-install             # Install embedding support
akdd jina-install              # Install jina-embeddings-v2 model (heavy download)
```

### CI/CD
```bash
akdd ci-install                # Install CI integration
akdd ci-status                 # CI status
akdd ci-report                 # CI report
akdd llms                      # Generate llms.txt + knowledge-graph.json
```

---

## Benchmark results

Across a 19-phase run building a real multi-tenant SaaS (same Claude model in both modes), with vs. without Agentix:

| Metric | Without | With |
|--------|---------|------|
| Errors per phase | 2.6 | ~0 |
| Phases with a repeated error | 3 | 0 |
| Tests passing first try | 79% | 100% |
| Refactor cascade correct | 4/7 | 11/11 |

> ⚠️ **Honesty first:** these are **N=1, directional, not peer-reviewed** — a single project. They show direction, not absolute truth. Reproduce the benchmark yourself in `benchmark/`.

---

## Status & transparency

Agentix is **young, evolving software**. All 48 engine files were audited and **30+ bugs were fixed** (memory, gates, vector search, packaging). Even so, **an audit doesn't certify zero defects** — if you find something, open an issue.

What **does work today**: the `aa:` pipeline, automatic registration of cycles and contracts (via the git hook), persistent memory with real semantic search, the gates (Spec / Regression / TDD / Security), the dashboard with real metrics, the MCP server, and multi-instance coordination.

---

## License

MIT — use it, fork it, build on it.

<div align="center">

Made by [@Adrianlpz211](https://github.com/Adrianlpz211)

*If Agentix saved you time → ⭐*

</div>
