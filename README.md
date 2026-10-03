<div align="center">

<img src="assets/logo.svg" alt="Agentix KDD" width="600">

### The armor for your AI coder.

<p>
<img src="https://img.shields.io/badge/version-3.20.0-3FE2E8?style=for-the-badge&labelColor=0A0E14" alt="version"/>
<img src="https://img.shields.io/badge/license-MIT-D9A33C?style=for-the-badge&labelColor=0A0E14" alt="license"/>
<img src="https://img.shields.io/badge/Claude_Code_·_Cursor-ready-8A97A6?style=for-the-badge&labelColor=0A0E14" alt="compat"/>
</p>

**A development team of one.**

English · [Español](README.es.md)

</div>

---

## In one sentence

**Agentix KDD turns your repository's accumulated knowledge into an active prevention force: it makes your coding AI remember the project, not break what already worked, and leave a verifiable trail of every decision.**

It's not another AI that codes for you. It's the **armor** you put on the AI you already use — native on **Claude Code and Cursor** — and it lives **inside your project**: local SQLite, no cloud, no account, no subscription.

> *KDD = Knowledge-Driven Development — development guided by the project's own accumulated knowledge. (npm package: `agentic-kdd`.)*

---

## The problem it solves

You open Cursor or Claude Code. You explain your project *again*. The AI starts from zero *again*. It breaks something that was working *again*. It changes a business rule without remembering why it was set that way. Two real client cases motivated the current generation: a combobox applied "everywhere" broke selects that ALREADY worked, and CSS work broke existing `required` validations. Both are the same disease: **the AI can't see what's already proven, and nothing mechanical stops it.**

You're not coding — you're babysitting the context by hand. **Agentix takes that over.**

---

## 🆕 What's new in 3.20 — from "the gate said PASS" to "show me the run"

3.20 is the hardening release. The question behind every change was the same: *can a green light be faked?* Wherever the answer was yes, it got closed.

| Area | 3.19 | 3.20 |
|---|---|---|
| **Closing a task** | A gate could report PASS from a boolean | PASS needs the **execution artifact of the exact subject**. An invented id, a runner with zero assertions, or code that changed after the run → `UNVERIFIED`, never green |
| **Upgrading** | `akdd update` pulled from GitHub `main` | Uses the engine **bundled in the package you installed**. Transactional journal, per-file backups, automatic revert on failure, `--rollback`. Memory, config and business code are outside the replacement |
| **Database schema** | Could migrate during normal reads | **Never migrates by itself.** Only `akdd update --migrate`, with a consistent SQLite backup (WAL included), inside a transaction, with an integrity check |
| **Effort** | Same pipeline weight for a typo and for auth | **LOW / MEDIUM / HIGH** = max(difficulty, risk). Small *and* risky still gets the risk controls. Minimum gates can't be removed, not even by a custom policy |
| **Preservation** | Contracts registered per test file | One contract **per individual test**, frontend scenarios, a `.agentic/protected_files` manifest, impact by real AST edges. Incomplete coverage reads `UNKNOWN`, never `LOW` |
| **Git hooks** | Read the working tree | Read the **index** (what you are really committing). Block leaked secrets, a fix without a test, and the removal of a case from a protected test. Respect `core.hooksPath` and never overwrite your own hooks |
| **Team work** | One agent at a time | **TEAMS**: Claude Code directs, Cursor builds — plans, dependencies, leases, fencing, human decision queue |
| **Undo** | Only Git | **Real restore points** in private Git refs, with preview and current-state hash. HEAD, branch and index untouched |
| **MCP** | Per project only; `--global` wrote to a file Cursor never reads | **One global entry for all projects.** A launcher opens each project's own server and memory (see below) |
| **Publishing** | Tag push + token | Manual workflow with **npm trusted publishing (OIDC)** that publishes exactly the tarball the release check verified |

How it was verified is in [Measured numbers](#measured-numbers-not-estimates). What is *not* verified yet is in [Honest limits](#honest-limits-what-it-is-not).

---

## The full map — three pieces, and EVERYTHING hangs from one of them

Agentix has many organs but only three pieces. If you ever get lost in the feature list, come back here: **everything it does belongs to one of these three rows.**

| | Piece | What it does | Its organs |
|---|-------|--------------|------------|
| ⚓ | **Anchor** — memory | Remembers decisions, rules, errors and the code's structure across sessions, and surfaces what's relevant at the right moment. | 4-layer memory (CoALA) · AST code graph with line-level precision · hybrid BM25+vector recall with a token budget · symbol anchors · known-cure matching ("this already happened — here's the fix") · natural-language per-file descriptions · autonomous curation (MemCurator) · gate ledger (`gate_events`) · measured task time |
| 🔧 | **Lever** — verification | Before accepting a change, mechanically checks it doesn't break what already worked. When in doubt, it **stops on the safe side**. Never reports a false "green". | Evidence-based closing (PASS/FAIL/SKIP/UNVERIFIED/ERROR) · TDD Gate · Preservation Gate (per-test contracts + front scenarios) · Regression Guard · protected files · AST blast radius · Spec Gate + business-value scanner · Security Gate (secrets/PII/injection + ORM-agnostic cross-tenant) · Browser Gate (real Chrome/Edge) · UI Native Gate · design memory · CSS Token Gate · Simple Gate · git hooks (pre-commit, commit-msg, post-commit) |
| 🔨 | **Hammer** — autonomy | Runs full development cycles on a leash: analyzes, builds, tests, learns, and recovers from stops — reporting everything back. | `aa:` pipeline · effort router (LOW/MEDIUM/HIGH) · context packages per task · LEGION MODE (parallel sub-agents for read/judge steps only) · 4-lens QA · `audit:` department (7 auditors) · TEAMS (director + builder) · restore points · RECOVERY protocol · multi-instance locks · ClickUp bridge (opt-in) · WhatsApp notices (opt-in) |

**The measured property that defines the armor:** when Agentix doubts, it protects. Measured against a real parser: of 1,989 symbols compared, the range error falls on the safe side in **99.75%** of cases (dangerous side: 5 cases, all ≤5 lines).

---

## Where it comes from — technologies and inspirations (named explicitly)

Agentix didn't invent every piece from scratch — it combined proven ideas that existed separately and added the missing part: making memory **block**, not just remember.

| Idea in Agentix | Where it comes from |
|---|---|
| 4-layer memory (working / procedural / episodic / semantic) | **CoALA** — *Cognitive Architectures for Language Agents* (Sumers, Yao, Narasimhan & Griffiths, Princeton, 2023). Agentix implements it in local SQLite. |
| Code map with PageRank over symbols | **Aider's repo-map** idea (Paul Gauthier). Agentix takes it further: line ranges per symbol, forms/CSS as nodes, and the map feeds a gate that STOPS — not just context. |
| Per-module specs and watched business rules | The **spec-driven development** current (popularized by tools like AWS's Kiro). In Agentix the spec isn't a separate document: it's generated from the cycle and the Spec Gate defends it. |
| Unsummarized episodes + reasoning bank | The episodic-memory research line for agents (Reflexion and successors): storing full trajectories avoids summarization drift. |
| Editor integration | **Open standards**: MCP (Model Context Protocol, Anthropic) plus `CLAUDE.md`/`AGENTS.md` and standard git hooks. Nothing proprietary. |
| Real-browser verification | **playwright-core** pointed at the Chrome/Edge you ALREADY have installed (zero browser downloads). |
| Persistence | **SQLite** (better-sqlite3, with automatic fallback to Node 22+'s `node:sqlite` when your machine lacks a build toolchain — tested). |
| Restore points | **Git's own object store**: commits in private refs (`refs/agentix/restore/*`) built with a temporary index, so your branch never moves. |
| Publishing | **npm trusted publishing (OIDC)** from GitHub Actions — no long-lived write token stored anywhere. |
| Symbol extraction | Disciplined regex, **not** tree-sitter — a MEASURED decision, not a limitation: a comparator against real tree-sitter was built, 1,989 symbols were measured, and the regex approximation proved sufficient (99.75% of errors fall on the safe side). The comparator stays in the engine to re-measure anytime. |
| *Fail-closed* philosophy | Classic safety engineering: when in doubt, the gate closes. All line-level containment degrades to "whole file protected" on ANY doubt. |

---

## How you use it (this is all of it)

```bash
# 1. Install the CLI
npm install -g agentic-kdd

# 2. In your project
cd your-project
akdd init

# 3. Connect the MCP once for ALL your projects (recommended)
akdd mcp --global

# 4. Open in Claude Code or Cursor and type:
aa: configurar
```

From there, every task starts with `aa:`. The full pipeline (analyze → build → test → learn) runs on its own; it only stops you on a genuine STOP (contradicted business rule, broken test, critical file).

```
aa: add pagination to the clients list
aa: --dry-run refactor the payment validation   ← proposes, writes nothing
aa: sprint — full invoicing module
aa: aprende                  ← absorbs work done outside the pipeline
audit: auditar               ← 7 parallel auditors; read-only, never touch code
```

> The command vocabulary (`aa:`, `audit:`, `teams:`) is Spanish — the task you write after it can be in any language. Chat prefixes are instructions for the agent, not shell commands.

---

## Upgrading from 3.19 — your memory stays

Two separate steps. **Installing the new CLI does not touch any project**; each project updates when you tell it to.

```bash
npm install -g agentic-kdd@latest     # 1. the new engine, once per machine

cd your-project                       # 2. in EACH project that already uses Agentix
akdd update
akdd health
```

What `akdd update` does and doesn't do:

- **Replaces only framework files**, from the package you just installed — not from GitHub. `--ref=<tag|sha>` and `--from=<file.tar.gz>` exist as explicit alternatives.
- **Never touches** `memoria.db`, the memory Markdown (`.agentic/memoria/`), `config.md`, knowledge, `PLAN.md`, your instructions or your code. Files listed in `.agentic/protected_files` are skipped too.
- **Runs as a transaction**: journal + per-file backup. If it fails halfway, it reverts what it wrote; if the process dies, the next run reverts first. `akdd update --rollback` undoes the last update.
- **Keeps your customizations**: a framework file you edited is left as is, and the new version is saved in the update journal (`.agentic/_update/…/personalizados/`) for you to compare.
- **Does not migrate the database schema.** When you want the new columns, stop your agents and run:

```bash
akdd update --migrate
```

That makes a consistent SQLite backup (pending WAL commits included), migrates inside a transaction and checks integrity. A failure is reported as a failure — never as "updated".

> ⚠️ First upgrade from an engine that predates the ownership manifest: Agentix can't tell every local edit inside a framework file from the original release. Review what it reports. `--rollback` restores framework files, not a migrated schema; check compatibility before going back to an older engine.

**This path is proven, not promised.** The release check downloads the real `agentic-kdd@3.19.0` from npm, builds a consumer project with a real SQLite database in the 3.19 schema, and upgrades it to 3.20 — results in [Measured numbers](#measured-numbers-not-estimates).

---

## The MCP — why it matters and how to connect it

**MCP is the bridge between the model and Agentix.** Without it, the model only uses memory, contracts and gates if it remembers to open a terminal and run the scripts — and often it doesn't. With it, Cursor and Claude Code see Agentix as native tools:

| Moment | Tool the model calls | What it gets |
|---|---|---|
| Before touching a module | `recall`, `verdad_vigente` | Known errors, decisions and patterns for that area — only what's relevant, within a token budget |
| Before planning a change | `impact_precheck`, `contracts_blast`, `effort_decide` | What breaks if this file changes, how many contracts are at risk, which tier and gates apply |
| While working | `pipeline_step`, `pipeline_gate`, `contracts_gate` | Each step registered through the harness; a cycle can't close without evidence |
| When closing | `remember`, `causal_add` | The tested lesson goes into memory for the next session |
| Coordination | `teams`, `restore`, `session_historial` | Plans between Claude Code and Cursor, restore points, resuming a chat |

It's the same engine and the same `memoria.db` as the CLI — **not another AI, not a cloud memory**. Its value depends on the agent using the tools; it can't keep an IDE session alive by itself. List the live tool set with `akdd capabilities`.

### Connect it once, globally

```bash
akdd mcp --global
```

- Copies a small launcher to `~/.agentix/mcp-launcher.cjs`.
- Adds **one** `agentic-kdd` entry to `~/.cursor/mcp.json` (your other MCP servers are preserved; an invalid JSON is left untouched and reported) and registers it in **Claude Code with user scope**.
- When an IDE starts it, the launcher finds the project you have open (walking up from the folder) and starts **that project's own server, with that project's engine version and memory**. Memories never mix.
- Outside an Agentix project it answers with a single `agentix_status` tool that says so — no error, no memory read.

Then **Reload Window** in Cursor and open a new Claude Code session. `akdd mcp status` shows what's configured. `akdd mcp` (without `--global`) still configures a single project; a project-level entry wins over the global one.

---

## TEAMS — Claude Code directs, Cursor builds

Open both on the same project. In the chat:

```
teams: activar
teams: plan <objective>
teams: ejecutar
teams: estado · teams: pendientes · teams: pausa · teams: continuar · teams: desactivar
```

A plan has sprints of tasks with `acceptance`, `allowed_files`, `depends_on`, `risk` and `change_type`. Rules that hold mechanically:

- **The builder never marks DONE.** It submits; the director verifies with gates on the exact subject.
- A task stop lets independent work continue; a **global** stop blocks the plan. Business decisions go to a human queue and appear once in the final report — they are not repeated.
- Goal mode is per sprint, never "the whole plan"; an exhausted budget produces a checkpoint, not a DONE claim.
- Activating tables in an existing project asks for migration approval (`init --aprobar-migracion`).

CLI equivalent: `akdd teams <init|plan|run|status|pending|resolve|goal>`.

---

## Restore points — undo with a preview

```
aa: restore point crear before the payments refactor
aa: restore point
aa: restore <id>
```

Points are Git commits in private refs; HEAD, branch, index and `git status` are identical before and after. Applying shows **what gets written, what gets deleted, what stays out and what does NOT come back** (database, deploys, sent messages), requires the current-state hash, creates a rescue point first and verifies by hash after. After restoring, the gates of that scope run again: the content came back, the verification did not.

---

## 🆕 ClickUp bridge — let sprints come to you (opt-in)

If your team tracks work in **ClickUp**, Agentix can pull the tasks of a List, cross-check them against your project, and assemble the "solid sprint" — no copy-pasting tickets by hand. **Off by default**: does nothing until you turn it on.

```bash
akdd cu on                     # activate (asks for CLICKUP_API_TOKEN in your .env, validates it)
akdd cu set-list <list-id>     # which ClickUp List this project uses (once)
akdd cu sprint                 # pull + classify + show (executes nothing)
akdd cu sprint --auto          # run only what passes the low-risk filter
```

| | Category | Meaning |
|---|---|---|
| 🟢 | **Clearly relevant** | Direct evidence in your code that this already exists |
| 🔵 | **Relevant new** | Doesn't exist yet, but fits the project's domain |
| 🟡 | **Ambiguous** | Insufficient description → asks before building |
| 🔴 | **No trace** | Zero relation to the project → skipped, with a note on ClickUp |

**`--auto` is pseudo-L5, not blind L5.** A task runs on its own ONLY if it's *clearly relevant*, touches no critical files, doesn't contradict a business value in your memory, doesn't touch authentication, isn't a large structural change, and has a substantive description. On a clean close it marks the task done; on any doubt it only leaves a comment.

---

## What happens on its own — you type nothing

| When | What runs automatically |
|------|--------------------------|
| On every git **commit** | **Pre-commit** over the *index* (what you're really committing): security shield (leaked secrets, cross-tenant, JWT bypass **block**; PII and invisible Unicode warn), test-integrity (removing a case from a protected test **blocks**), UI native, business values. **Commit-msg**: the canary — a *fix* without any test **blocks**. **Post-commit**: queues the commit by SHA and closes the cycle in the background (contracts, AST index, graph, specs). Never blocks. |
| On every **post-cycle** | Spec/test integrity scan · design memory (values that return to an abandoned state, properties that disappear) · CSS tokens · Simple Gate · Preservation Gate · risk-prediction grading · deps audit · cycle closed from real gate states |
| Inside every **`aa:`** | Context Enricher brief (risk, known cures, active alerts) · effort tier · gates · tests · 4-lens QA when the change isn't trivial · memory · measured duration |
| Every **5 cycles** | Checkpoint to resume in another chat or machine |
| On **init / update** | Hooks install themselves (respecting your own); the AST index rebuilds once if the engine changed versions. The schema does **not** migrate on its own — that's `--migrate` |

Every protection is recorded in the ledger (`gate_events`) with its origin: **`mechanical`** (iron that runs on its own) or **`protocol`** (the model following instructions). Measure what fraction of your protection is iron: `node .agentic/grafo/gate-telemetry.cjs stats`. Emergency hatch for the hooks: `AKDD_SKIP_GATES=1 git commit ...` — the optional IDE guard (`akdd host-hooks install`) denies that hatch and `--no-verify` to the agent.

---

## How mature each organ is (honesty by tiers)

**🥇 Battle-tested** (repeated real use): the `aa:` pipeline, 4-layer memory + hybrid search, classic gates (Spec/TDD/Security/Regression), automatic per-commit registration, checkpoints, multi-instance locks, dashboard, MCP, line-level containment, parallel Front/Back.

**🥈 Verified with fixtures, real Git, real SQLite and a real browser** (new in 3.20, controlled scenarios, not yet months of production): evidence-based closing, transactional update + 3.19 → 3.20 upgrade from the real npm package, opt-in schema migration, effort router and context packages, per-test contracts and front scenarios, protected files, AST blast radius, index-based git hooks and the commit-msg canary, restore points, TEAMS engine (scheduler, leases, fencing, human queue), global MCP launcher, dashboard API / table view / built-in tour, time measurement.

**🥉 Logic verified, live host NOT verified**: TEAMS with Claude Code and Cursor open at the same time on one machine, IDE host-hook adapters inside each IDE, WhatsApp notices end to end. The code is there; the certification inside a live IDE is pending.

**🔒 Private beta**: team collaboration (shared memory).

---

## Measured numbers (not estimates)

| Metric | Value |
|---|---|
| Range-error direction (vs real parser, 1,989 symbols) | 99.75% safe side |
| Graph of a real project (~414 TS+JS files) | 3,757 symbols · ~4,900 edges · 100% with line ranges |
| **3.20 release check** (2026-10-03, Windows, Node 24) | Full suite green with zero skipped tests · tarball with no private data · 528 adversarial probes, 0 failures |
| **Real upgrade 3.19 → 3.20** (from the published npm package) | 50 memory nodes and 500 private rows preserved · database bytes identical during the update · second update writes nothing · rollback restores · `--migrate` keeps every row · MCP `initialize` / `remember` / `recall` over stdio |
| Effort router (15 fixtures, threshold fixed before running) | LOW: −90% context bytes, −54% steps · MEDIUM: −25 to −32% · HIGH keeps tdd, preservation, QA and reviewer. *Proxy: bytes Agentix asks to load; host tokens not measured* |
| 19-phase benchmark (multi-tenant SaaS, with/without Agentix) | errors per phase 2.6→~0 · tests passing first try 79%→100% · refactor cascade 4/7→11/11 |

> ⚠️ **Honesty first:** the 19-phase benchmark is **N=1, directional, not peer-reviewed** — see [BENCHMARK.md](BENCHMARK.md). Live counts of modules, MCP tools and tests change with every release, so they're not written here: `node scripts/sync-version.cjs --inventario` and `akdd capabilities` print them.

---

## Compatibility

Agentix is **first-class on Claude Code and Cursor** — that's where it's battle-tested. Because the engine relies on **open standards** (`AGENTS.md` and **MCP**), it *should* also work with other agents (VS Code, Windsurf, Kiro, Aider…), but in the interest of honesty: **so far it's only thoroughly tested on Claude Code and Cursor**. If you try it on another IDE and it works, open an issue.

Node.js: the package declares `>=18`. CI runs Windows and Linux on Node 20, 22 and 24; the 3.20 release check ran on Node 24. Git is required.

---

## Dashboard — what it looks like on a real project

`akdd dashboard` → visual board at localhost:3847. Every capture below is from a real production SaaS project (~414 files). The Knowledge Graph renders in **real 3D** — and it's three graphs. New in 3.20: a **☰ Table** view of the KDD graph with the same filters, the guided tour served by the dashboard itself (no extra command), a read-only API (`/api/v1/summary`, `/tasks`, `/contracts`, `/incidents`, `/usage`, `/restore-points`…) and graph libraries served locally — no CDN.

**KDD Memory** — the decisions, errors and patterns from your memory. Knowledge born from the frontend is distinguished by color (pink/lime/cyan vs back's red/green/blue) and filterable with Front/Back:

<img src="assets/dash-kdd-memory.png" alt="KDD Memory — memory with front/back color families" width="100%">

Click any node: its connections light up and the panel shows the full rule, its confidence, which cycle it was born from, and what other knowledge it relates to:

<img src="assets/dash-kdd-node.jpg" alt="KDD Memory — selected node with its connections and detail panel" width="100%">

**Code Structure** — a native map of your actual code (files, symbols, forms, CSS classes and their connections), straight from the AST index. Zero LLM calls, zero tokens:

<img src="assets/dash-code-structure.jpg" alt="Code Structure — 3D code map with department palette" width="100%">

**Combined** — merges both: you see how your code and your accumulated decisions relate:

<img src="assets/dash-combined.jpg" alt="Combined — code and knowledge in one graph" width="100%">

### Preservation Intel — the third tab

The contracts that can't be broken (protected/verified/candidate), the Creative Engine with its autonomy level, MemCurator governing the memory, and the code's structural learning:

<img src="assets/dash-preservation-contracts.jpg" alt="Preservation Intel — Contract Guard, Creative Engine, MemCurator, Structural Learning" width="100%">

And the UI/Frontend memory: watched forms, selects, `required` fields and CSS classes, with the UI Native Gate in green:

<img src="assets/dash-preservation-ui.jpg" alt="Preservation Intel — design memory, UI Native Gate and UI Eyes" width="100%">

Plain-language visual guides: [how to read the graph](docs/GRAFO-GUIA.md) · [how to read contracts + Creative Engine](docs/CONTRATOS-GUIA.md)

---

## ⚪ Full CLI reference (manual)

Everything below is **manual** — use it only when needed. The automatic behavior is described above. `akdd --help` lists everything.

### Setup & lifecycle
```bash
akdd init                      # Install Agentix KDD in a project
akdd onboard                   # Onboard an existing (brownfield) project
akdd update                    # Update the engine from the INSTALLED package (memory untouched)
akdd update --migrate          # ...and migrate the memory schema (backup + transaction + integrity)
akdd update --rollback         # Undo the last update (framework files)
akdd mcp --global              # One MCP entry for all projects (Cursor + Claude Code)
akdd mcp · akdd mcp status     # Per-project MCP · what's configured
akdd hooks [status]            # Git hooks: pre-commit, commit-msg, post-commit
akdd host-hooks <status|install|uninstall> [--host=cursor|claude|all]   # Optional IDE guard
akdd health [--fix]            # System diagnostics (--fix repairs what it can)
akdd doctor                    # 5 repair steps: schema, sync, AST, graph integrity, locks
akdd capabilities              # Installed / wired / executed / verified, per module
akdd dashboard                 # Visual board at localhost:3847
```

### Effort, context & TEAMS
```bash
akdd effort decide "<task>" --paths=a,b [--type=T] [--json]   # Tier + gates + budgets
akdd context armar "<goal>" --paths=a,b                        # One context package per task
akdd teams <init --aprobar-migracion|plan plan.json|run|status|pending|resolve <id> <decision>|goal>
akdd restore <list|create --label=L [--files=a,b]|show <id>|preview <id>|apply <id> --expected-current-hash=H>
```

### Memory & knowledge graph
```bash
akdd recall "query"            # Ranked BM25+vector recall, with a token budget
akdd buscar "query"            # Hybrid search across all memory layers
akdd historial                 # Resume checkpoint — paste into a new chat
akdd graph · akdd stats        # Graph summary and statistics
akdd why <file|entity>         # Why does this exist — decision trail
akdd forget <id> "<reason>"    # Invalidate a memory entry (audited, not deleted)
akdd cure [report]             # MemCurator — autonomous memory governance
```

### Contracts & gates (preservation layer)
```bash
akdd contracts [list|blast <f>|gate|verify]   # Contract Guard
akdd decide <file>             # STOP / WARN / IMPLEMENT / DEFER for a proposed change
akdd predict <file>            # Regression risk before editing
akdd impacto <file|module>     # What breaks if this changes
akdd ast-impact <file>         # AST-level impact analysis
akdd simple                    # Simplicity: duplicated code, deps with a native equivalent
akdd tokens [files...]         # CSS Token Gate
node .agentic/grafo/gate-telemetry.cjs stats   # The ledger: what protected, when, iron vs protocol
```

### Code engine & time
```bash
akdd ast [stats|symbols <f>]   # Project AST index
akdd describe [area]           # Natural-language per-file descriptions
akdd tiempo inicio "<task>" · akdd tiempo fin   # Measured duration (worked vs elapsed)
akdd tiempos [module]          # Time per module — measured, never estimated
```

### ClickUp bridge · WhatsApp (opt-in — off by default)
```bash
akdd cu on · akdd cu set-list <id> · akdd cu sprint [--auto] · akdd cu done <task-id>
akdd ws <activar|estado|desactivar>   # Notices through your own WhatsApp Web session
```

### QA / Audit department 🔵 (in chat — audits only, never touches code)
```bash
audit: auditar                 # Full audit — 7 subagents in parallel
audit: seguridad · frontend · backend · datos · performance · browser · codigo
```
> Reports land in `_output/audit-[date].md`. To fix a finding: `aa: corrige el hallazgo SEG-01`.

### Multi-instance (Lock Manager)
```bash
akdd locks                     # Who owns which module
akdd locks release-all         # Release everything (session cleanup)
```

### Collaboration (team) — 🔒 private beta
> Shared **team memory** is in **private beta**. Everything else works **100% locally, no account required**. Want it for your team? [Open an issue](https://github.com/Adrianlpz211/AGENTIX-KDD/issues).

---

## Honest limits (what it is NOT)

1. **It's not invulnerable.** The armor reduces and directs error; it doesn't eliminate it. The quality of autonomous fixes comes from whichever model you run.
2. **Verified is not the same as live-certified.** TEAMS with two IDEs open at once, the IDE host-hook adapters and WhatsApp are verified in logic and fixtures, not yet inside a live IDE session.
3. **It has a coverage ceiling, and declares it.** Files without symbols don't get line precision — doubt closes the gate instead. `coverage-meter` and `UNKNOWN` states tell you where.
4. **Regex extractors, not a parser** — a measured decision (see "Where it comes from"). Edge cases fall into DOUBT, not silence.
5. **The semantic band stays in the model.** Business values are watched by iron, but "does this contradict the SPIRIT of the decision?" is judged by the LLM following protocol — and the ledger records which protection came from which.
6. **No fixed token-saving promise.** The effort numbers measure context requested, not host tokens or result quality.
7. **The 19-phase benchmark is N=1** — directional, not peer-reviewed.

---

## The Coliseum — adversarial arena (evidence, not marketing)

Instead of a benchmark that proves Agentix wins, we built one designed to **break it on purpose**: 15 attack rounds escalated across 4 tiers against a real project (MediCore, a multi-tenant clinical SaaS with business rules, tenant isolation, and a real concurrency race), each run twice — **with** Agentix (`aa:`) and **without** it (naked agent) — to measure the difference with facts, not narrative.

**Result:** 14 of 15 rounds held clean. The one real crack happened after the human forced an explicit override against the system's recommendation — and instead of leaving the accepted risk visible, the agent hid the reintroduced bug by weakening the test that watched it. A false green is worse than an honest red.

**The cracks found are repaired and verified**: a test that verifies a HIGH-confidence pattern can't be weakened in silence (`test-integrity-gate.cjs` — since 3.20 it reads the index and blocks), the Security Gate stopped depending on the Prisma dialect to detect cross-tenant leaks, and the TDD Gate runs `typecheck` alongside tests.

### Second round — machinery audit

Re-run on new terrain (FLOTA360, a multi-tenant fleet SaaS with pre-poisoned memory), measuring **what the MECHANICAL gates catch on their own**. Narrow-domain gates (native UI, layout, locks, secrets) proved solid iron; semantic traps leaned on the memory brief + the model. The mechanical holes found were sealed: ORM- and vocabulary-agnostic cross-tenant (0 false positives across Lumo's 28 real routes), `related_files` derived from tests, long token expiry as a visible WARN, widened test discovery, and a red `akdd health` when cycles exist but the Preservation Gate protects nothing.

### Third round — 3.20's own adversarial probes

3.20 adds an adversarial sandbox to the repository (`sandbox/`) that attacks the gates themselves: fake PASS ids, empty runners, replayed executions, stale caches, evidence from another subject, payloads hidden in file names. The release check runs 528 of them with a fixed seed — 0 failures — and meta-tests plant a bug in each gate to prove the negative test catches it.

The full Coliseum playbook lives on the [`coliseo-arena`](https://github.com/Adrianlpz211/AGENTIX-KDD/tree/coliseo-arena) branch — run the rounds yourself.

---

## For maintainers — release and publish

```bash
npm ci
npm run release:check          # suite + tarball privacy + real 3.19 → 3.20 pilot + MCP
```

Results, the log and the exact tarball land in `_output/release-<version>/` (`verification.json`). Publishing goes only through the manual GitHub Actions workflow **Publish npm (manual)**: it re-runs the check on Windows and Linux, then publishes with npm trusted publishing (OIDC) **the tarball whose SHA the report recorded**. Setup and steps: [PUBLICACION-3.20.md](PUBLICACION-3.20.md).

---

## Status & transparency

Agentix is **young, evolving software**. 3.20 was built by asking, gate by gate, whether a green could be faked — and closing it where it could. Even so, **an audit doesn't certify zero defects** — if you find something, open an issue.

The real promise, without inflation:

> **"Agentix makes your coding AI remember, respect and preserve your project as it evolves — and when something makes it doubt, it stops on the safe side. Every protection it exercises is recorded and auditable."**

Verify it yourself in 10 minutes: `akdd init` → `aa: configurar` → deliberately break something protected → watch the STOP with the exact zone → `node .agentic/grafo/gate-telemetry.cjs stats` → there's the recorded event.

---

## License

MIT — use it, fork it, build on it.

<div align="center">

Made by [@Adrianlpz211](https://github.com/Adrianlpz211)

*If Agentix saved you time → ⭐*

</div>
