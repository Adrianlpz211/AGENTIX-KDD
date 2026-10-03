<div align="center">

<img src="assets/logo.svg" alt="Agentix KDD" width="600">

### The armor for your AI coder.

<p>
<img src="https://img.shields.io/badge/version-3.20.1-3FE2E8?style=for-the-badge&labelColor=0A0E14" alt="version"/>
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

## 🆕 3.20.1 — one safe update, and it proves what it did

Until now, upgrading a project meant two commands and a leap of faith: `akdd update` replaced the engine, a second `--migrate` touched the database, and nothing said — in a way you could check — that your memory had survived. 3.20.1 closes that:

```bash
npm install -g agentic-kdd@latest
cd your-project
akdd update
```

That is the whole upgrade. `akdd update` now **inspects → backs up → applies → verifies → reports**, and it only exits `0` when the result is something it can back with evidence:

| Step | What happens |
|---|---|
| **Inspect** | Reads the package you installed, your files and the *real* structure of `memoria.db` (tables, columns, indexes) — not just `config.md` or the npm version. An old database with no migration registry is inspected by capability; `user_version = 0` is never assumed to mean "empty". |
| **Exclude writers** | A per-project lock (owner token, heartbeat, abandoned-lock recovery). Engine writers, git-hook workers and the MCP server pause and **acknowledge**; if a live service doesn't, the update stops before touching anything. Cursor, Claude and your other processes are never killed. |
| **Back up** | A consistent SQLite backup (`VACUUM INTO`, so commits still sitting in the `-wal` are included), **opened and integrity-checked** before the first change. Space and write permission are checked first. |
| **Apply** | Compatible, **additive** schema migrations in **one transaction**, recorded in a registry (stable id, checksum, version that introduced it, date, result). Nothing is destructive and nothing is hidden behind an empty `catch`. Framework files are replaced through a journal; yours are not. |
| **Verify** | `integrity_check`, `foreign_key_check` against what already existed, the full required schema, your records **compared by content** (a multiset hash per table that tells `NULL` from `''`, a `BLOB` from text, and keeps 64-bit integers exact), your own tables / indexes / triggers / views, your own files, then a real recall search, an MCP handshake and a rolled-back write on an isolated copy. |
| **Report** | `.agentic/_update/last-result.json` and a per-operation `verification.json`, a status below, and a card in the dashboard. |

| Status | Meaning | Exit |
|---|---|---|
| `VERIFIED` | Updated and verified | 0 |
| `VERIFIED_WITH_WARNINGS` | Updated and verified; warnings don't affect compatibility (e.g. a file of yours was kept) | 0 |
| `NO_CHANGES_VERIFIED` | Already up to date, and that was checked | 0 |
| `BLOCKED` | Nothing was applied — and it says why | 1 |
| `UNVERIFIED` | Something could not be demonstrated (e.g. `--no-migrate` left the schema incomplete) | 2 |
| `ROLLED_BACK` | It failed and recovery was **verified** | 3 |
| `RECOVERY_REQUIRED` | Recovery needs a person; the next update refuses to run until you resolve it | 4 |

Options: `--check` (plan only — changes nothing), `--json` (one JSON document on stdout), `--no-migrate` (the result is **never** reported as complete if the schema is missing), `--migrate` (kept for compatibility; migrating is already the default), `--from=` / `--sha256=` / `--ref=` (unchanged), `--rollback`.

**What gets preserved.** `memoria.db` content, the memory Markdown, `config.md`, knowledge, `PLAN.md`, your instructions, your code, and any rule you added (`.cursor/rules/`, `.audit/`, …). Every framework file is classified against a *verifiable* base — the hashes Agentix recorded when it installed it, or the hashes of the published releases. A file with your changes (or with no reliable base) is **kept**, and the new version is saved beside it. If a kept file is indispensable for the new engine, the update **blocks before applying anything** rather than leave a half-old engine. Text under the `INSTRUCCIONES DEL PROYECTO` marker in `CLAUDE.md` is moved without losing a heading, a comment or a segment; if two versions of your instructions exist, both originals are kept and merged.

**What can block it.** A schema newer than this engine; an unreadable or corrupt database; a database held by a process that doesn't follow the protocol; a service that won't pause; not enough disk space; a framework folder that is a link pointing outside the project; an indispensable engine file you customized; no SQLite driver that passes the real capability checks.

**Rollback, and its limit.** `akdd update --rollback` reverts the **files** of the last update and never restores an old database over newer learnings. It refuses if the schema changed after that update. Restoring historical data is a different, explicit operation — the verified backup stays on disk for it.

**See it.** `akdd dashboard` also serves **/actualizacion**: installed version, schema compatibility, the last verification, memory and customizations preserved, the available backup, conflicts and what to do. It separates "the service responds" from "the memory can work", is read-only and paginated, and never shows file contents. Your graphs are unchanged.

**Requirements.** The update needs a SQLite driver that passes the real checks (read-only, transactions, locking, backup with WAL, BLOB, 64-bit integers, multi-process, clean close): `node:sqlite` on Node ≥ 22.13, or a compatible `better-sqlite3`. `sql.js` re-exports the whole file from memory and is **not** accepted for an update. Without one, the update refuses before writing and explains how to fix it. In this release the verified driver is `node:sqlite`: the optional `better-sqlite3@^9` has no prebuilt binary for Node 24 and failed to compile there, so that path is **unverified**.

## 🆕 3.20.1 — memory you can trace, recall by layers, context that keeps its original

The safe update ships together with a memory upgrade. Everything below is **native**: no Claude-Mem, no Headroom proxy, no cloud service, no extra daemon and no paid call by default. Other projects inspired some ideas; the mechanisms are Agentix's own and live in the same `memoria.db`.

New tables arrive **only through `akdd update`** (the schema catalog, with the same backup and verification). Reading never creates or migrates anything: on an old database the memory commands say `SCHEMA_MISSING` and point to `akdd update`. Existing nodes keep their IDs (INTEGER or TEXT) and their content; nothing is regenerated.

### Memory with provenance

| Piece | What it is |
|---|---|
| **Activity** | A raw event from a real action: tool run, phase, gate result. Idempotent by project + host + session + host event id: resending one event keeps **one** activity and **one** job; two identical runs at different moments are **two** activities. |
| **Observation** | A bounded reading of one or more activities (test failure, files touched, explicit decision, gate result). Many reads of the same file become **one** grouped observation. |
| **Knowledge** | A KDD node with a state: *proposed → validated → suspect → obsolete*, mapped onto the existing node states. |
| **Evidence** | A verifiable artifact: id, SHA-256, size, scope, retention. |

**An observation or a summary never validates anything.** Validation needs *current* evidence (its hash is re-checked at that moment) and a validator that is a gate, a test, the user or a verifier. It is deliberately **not** exposed to the model over MCP: `akdd memory validate <node> --evidence=ev_… --by=gate`. When related code changes, validated knowledge becomes *suspect*. Identical knowledge in the same scope adds an occurrence instead of a new node; similar knowledge becomes a *review candidate*, never a merge; contradictions keep both origins. Records from before 3.20.1 are shown as `LEGACY_UNVERIFIED_PROVENANCE` when read — they are neither rewritten nor downgraded.

**Privacy comes first.** Text is classified *authorized / redacted / private / unknown* and redacted **before** it reaches the database, the queue, a cache, the delivered context or the dashboard. Redaction **fails closed** (a redactor error stores nothing, never the original). Private paths (`.env`, keys, credentials…) keep metadata only. Add your own denied paths and fields in `.agentic/privacy-policy.json`. Regular expressions cannot guarantee they catch every secret — that is why deny lists exist; treat the redactor as risk reduction, not as a DLP.

**What is captured depends on the host** — `akdd memory capabilities` prints the real picture:

| Host | Capture | What it sees |
|---|---|---|
| Claude Code / Cursor **with the host hooks installed** (`akdd host-hooks install`, never automatic) | `NATIVE_PASSIVE` | Shell, edit and MCP actions **before** they run, and the guard's decision — not the tool's output |
| Same hosts **without** hooks | `PIPELINE_ONLY` | Only what goes through Agentix: `aa:`, post-cycle, Agentix MCP tools, TEAMS |
| Any other host | `UNSUPPORTED` | Nothing is promised |

It does **not** see an IDE's internal reads and searches, tool output, or the model's reasoning.

**Durable queue.** Capture inserts the event and its job in **one transaction**; a worker claims it with a lease and a fencing token, processes it with deterministic rules (no model call), retries with backoff and finally parks it as *dead-letter*, visible and retryable (bounded). A full queue answers `BACKPRESSURE` and does not claim "captured". Capture never blocks Shell/Edit: if it fails, it reports a degraded state.

### Recall by layers

```bash
akdd memory index --query="refund rule"        # 1. compact index: id, title, state, provenance, estimated cost
akdd memory detail --ids=12,40                 # 2. details of the chosen ids, in a bounded batch
akdd memory timeline --node=12                 # 3. chronology around an activity or node, paginated
akdd memory evidence ev_…  --lines=100-140     # 4. authorized original, with hash
```

Every answer carries explicit states (`OK`, `NO_RESULTS`, `NO_DB`, `SCHEMA_MISSING`, `ERROR`, `INSUFFICIENT_BUDGET`), a known total, `has_more`/cursor and *why* something was omitted. Budgets are **cumulative per task** (changing role or asking again does not reset them) and follow the effort tier. Applicable **protected contracts are never dropped silently** by a budget. Lexical search works without embeddings and never creates the FTS index while querying. The same layers are MCP tools (`memory_index`, `memory_detail`, `memory_timeline`, `memory_evidence`); `recall` and `remember` are unchanged.

### Compaction that keeps the original

`akdd context compress <file|-> --kind=log|test|json|search|doc|code --task=T` compacts a large tool result **deterministically** (no model, no Python, no ML) and stores the authorized original; `akdd context recover <reference_id> --lines=a-b` returns it with its hash verified.

- Logs group exact repetitions and keep the context around errors; test runs keep **every** failure; JSON is delivered as an explicitly labeled *sample* with the original counts; searches keep all affected paths.
- **Code you are about to edit, audit, debug or verify is delivered whole**, as is gate evidence. Only orientation uses the AST index.
- **A sample can never prove absence.** "No failures" requires the complete original (`verificarAusencia` scans it locally and returns only the result).
- A malformed, empty or inflationary compaction returns the original with a warning. Without room to keep the original, it is **not** compacted. An expired or changed reference answers `EXPIRED` / `EVIDENCE_CHANGED` — never reconstructed content. Gate evidence is durable; originals used by an active task or sprint are pinned; only unpinned cache expires.

### Effort that really changes, and shared context in TEAMS

`LOW` now means less: no global search and no needless delegation — while scope, protected files, security and leases stay in every tier, and a "small change" to auth, payments or a migration stays `HIGH`. Reads of unchanged files are reused, and a changed hash always invalidates. In TEAMS the director and the builder exchange **versioned packets** (snapshot, or a delta only against the revision the receiver acknowledged); an out-of-order ACK or a restarted receiver gets a full snapshot, and the director **re-verifies the original evidence** — an invented PASS or evidence from an older version is rejected. `akdd effort budget …` and `akdd teams packet …` expose it. Controlling the *provider's* reasoning effort needs an explicit integration that is **not installed**; Agentix declares `HOST_NATIVE_UNCONTROLLED` and never promises to shrink a host's internal thinking.

### See it

`akdd dashboard` serves two more pages next to the graphs (which are untouched): **/memoria** (what is stored, queue, provenance, legacy records) and **/contexto** (tier, budget, net reduction and its measurement type, host coverage). Health shows independent states — service, readable, schema, search, last verified write, queue, update — and the dashboard is **not green** if the schema is broken even when HTTP answers 200. `akdd memory health verify-write` is the only command that exercises a write (in an isolated copy); opening the page never writes. Missing data is "not available", never `0`.

### What was measured (deterministic, no user data)

`akdd benchmark contexto` runs eight cases against the real modules — baseline (nothing compacted) vs optimized, same task, same acceptance. Recovering an original **counts against** the saving.

| Case | Net payload saved | Note |
|---|---|---|
| A · text change under `LOW` | 94.1 % | no global search, no delegation, guards intact |
| B · one error in 20,000 log lines | 99.8 % | the error stays visible, original recoverable |
| C · "small change" in auth/payments | **0 %** | **by design**: stays `HIGH` with every control |
| D · refactor with protected contracts | 95.2 % | all 30 protected contracts listed; under a tight cap it answers `INSUFFICIENT_BUDGET` instead of dropping any |
| E · rare critical record in a long JSON | 99.4 % | found over the complete original |
| F · empty / malformed / secret / code to edit | 41.4 % | edges: nothing lost, nothing leaked |
| G · TEAMS, restarts and a changed evidence | 71.3 % | simulated receiver; protocol and database are real |
| H · 4,000-node memory | 99.3 % | index + two details, never a dump |

All 31 acceptance criteria held. This is a **payload** reduction (bytes exact; tokens are `bytes/4` *estimates*), not a saving of session, reasoning or money. A campaign with real models is `NO_EJECUTADO` (it costs money and needs your authorization), and none of this was measured inside Cursor or Claude Code.

## 🆕 What's new in 3.20 — from "the gate said PASS" to "show me the run"

3.20 is the hardening release. The question behind every change was the same: *can a green light be faked?* Wherever the answer was yes, it got closed.

| Area | 3.19 | 3.20 |
|---|---|---|
| **Closing a task** | A gate could report PASS from a boolean | PASS needs the **execution artifact of the exact subject**. An invented id, a runner with zero assertions, or code that changed after the run → `UNVERIFIED`, never green |
| **Upgrading** | `akdd update` pulled from GitHub `main` | Uses the engine **bundled in the package you installed**. Since 3.20.1 it is one verified command (see below). Transactional journal, per-file backups, automatic revert on failure, `--rollback`. Memory, config and business code are outside the replacement |
| **Database schema** | Could migrate during normal reads | **Never migrates while the engine works.** In 3.20.0 that needed a second `akdd update --migrate`; since 3.20.1 `akdd update` migrates by itself (see below), with a consistent SQLite backup (WAL included), inside a transaction, with an integrity check |
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

## Upgrading from 3.19 or 3.20 — your memory stays

Two separate steps. **Installing the new CLI does not touch any project**; each project updates when you tell it to.

```bash
npm install -g agentic-kdd@latest     # 1. the new engine, once per machine
akdd mcp --global                     #    refresh the global MCP launcher (once)

cd your-project                       # 2. in EACH project that already uses Agentix
akdd update --check                   #    optional: see the plan, change nothing
akdd update                           #    one command: backup, migrate, verify
akdd health
```

`akdd update` is the only command you need. It replaces framework files from the package you installed — **not** from GitHub (`--ref=<tag|sha>` and `--from=<file.tar.gz>` are explicit alternatives) — migrates the memory schema in a compatible, additive way, and verifies the result. See [3.20.1](#-3201--one-safe-update-and-it-proves-what-it-did) for the steps, statuses and what can block it.

- **Never touches** your memory content, `config.md`, knowledge, `PLAN.md`, your instructions or your code. Files in `.agentic/protected_files` are skipped too.
- **Runs as a journaled transaction**: if it fails halfway it reverts what it wrote and verifies the recovery; if the process dies, the next run recovers first. Replaced files are re-checked right before writing, and a recovery never overwrites an edit made after the update wrote that file.
- **Keeps your customizations**: a framework file you edited is left as is and the new version is saved in the update journal (`.agentic/_update/tx/<id>/personalizados/`) for you to compare.
- **Backs up before the first change** and keeps the backups out of Git and npm (`.agentic/_update/` ignores itself). Retention never deletes the backup of an operation in progress, the last verified one, or one you mark with a `.keep` file.

> ⚠️ First upgrade from an engine that predates the ownership manifest: Agentix classifies each framework file against the hashes of the *published releases* (3.15.0 → 3.20.0). A file that matches none of them is treated as yours. Review what it reports.

**This path is proven, not promised.** The release check installs the tarball it is about to publish in a clean directory, builds consumers by running the **published** 3.19.0 and 3.20.0 engines, adds data a real project could lose (your own tables, 64-bit integers, BLOBs, a view and an index) and then runs, with that installed CLI, `--check`, `update`, a second `update`, the MCP over stdio and `--rollback`. After publishing, `npm run release:verify` downloads what is actually on npm, checks it is byte-for-byte the verified tarball, and repeats the 3.19.0 upgrade with it.

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

### TEAMS native (3.20.1) — the director, three reviewers and the builder, wired to everything else

TEAMS now runs on the **same core as `aa:`**. Every task the director verifies goes through a bridge (`teams-puente.cjs`) that records it as a cycle, memory, contracts, AST, layout and preservation evidence with `origin = teams` — you do not type `aa:`. The record is an *outbox*: it is queued in the same transaction as the event, retried if it fails, and a task stays `MEMORY_PENDING` until it is really registered. A failed registration never blocks independent tasks, but it keeps the final close from being "complete".

| Piece | What it does |
|---|---|
| **You land it, the director plans it** | You state everything (scope, rules, reference links). The director turns it into sprints → phases → tasks with acceptance, files, dependencies, risks and review criteria, shows you a summary and asks only what is indispensable. The first batch exists *before* the builder starts. |
| **Audit never gates ordinary progress** | The builder goes Phase 1 → Phase 2 → Sprint 2 while the reviewers work. A late finding goes to **Correcciones pendientes**; the builder reads it first, suspends its task safely, fixes, and resumes at the exact position. A real unmet dependency still blocks its branch; security and preservation are never relaxed. |
| **Three reviewers** | Frontend/UI-UX, backend and business (a general auditor of the domain logic). Each verdict is bound to the hash it reviewed; an old hash does not count; sequential review is declared as such. |
| **Closing** | An empty queue is *not* the end: the campaign waits for the final audit. The director closes only when all three reviewers concluded on the FINAL subject, findings are resolved or listed, and every memory record is registered. The builder acknowledges (`close_id` + revision) and stops **its own** loop and watch. A finding that arrives between the close and the ACK reopens it. Final state: `COMPLETED` or `COMPLETED_WITH_PENDING`. |
| **Decisions that are yours** | They are recorded with the question and alternatives; independent work continues; and the director reports *"the project stands at X % because of these decisions of yours"*. X is computed from the plan (verified tasks ÷ planned tasks), never invented. |
| **Research on the internet** | After you land the plan, the director and the business reviewer can fetch the **reference links you gave** (or ones you authorize). Content is stored as evidence (URL, date, hash), redacted, and treated strictly as data. Private networks and redirects to them are refused. |
| **Two independent watchers** | The host loop every 180 s is the backup that does wake the model; a file watch lowers latency to seconds. Neither depends on the other. A signal is not a task and not an ACK; Agentix measures detected → requested → attended → ACK. |

```bash
akdd teams prompt director      # the real start prompts, with your absolute paths and plan
akdd teams prompt builder       # paste once in Cursor
akdd teams avance               # measured progress and the owner decisions that hold it back
akdd teams correcciones listar  # findings by priority   ·   akdd teams revision ...   ·   akdd teams cerrar
akdd teams vigilancia estado    # what is installed, alive, detecting, and what the host really accepts
akdd teams investigar consultar --plan=P --url=... --pregunta="..."
```

**Limits, said plainly.** The watchers detect and measure but do **not** wake a chat by themselves (`EVENT_WAKE_UNSUPPORTED`); without a confirmed host loop the mode is `MANUAL_ONLY` and no autonomy is announced. Everything above is verified with simulated builder/receipts and real storage (levels A and B); the **real Claude Code + Cursor campaign (level C) has not been run**. No Windows scheduled task is installed unless you approve it, and updating Agentix never installs one.

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
| **3.20.1 release check** (2026-10-03, Windows, Node 24 — the only platform measured) | Full suite 933/934 (the one not run is a smoke inside real Cursor/Claude hosts, declared `NO_EJECUTADO`) · tarball (243 files) with no private data · 528 adversarial probes, 0 failures · the **installed tarball** is what gets tested |
| **Real upgrades 3.19.0 → 3.20.1 and 3.20.0 → 3.20.1** (consumers built by running the published engines) | `akdd update` alone: `VERIFIED` (25 and 9 migrations applied) · memory preserved by **content** (30–31 tables, 567–572 rows compared, plus 500 private rows in a user table) · second update `NO_CHANGES_VERIFIED` · `--rollback` reverts files and keeps newer memory · the previous engine still reads the migrated database · MCP `initialize` / `remember` / `recall` over stdio |
| Effort router (15 fixtures, threshold fixed before running) | LOW: −90% context bytes, −54% steps · MEDIUM: −25 to −32% · HIGH keeps tdd, preservation, QA and reviewer. *Proxy: bytes Agentix asks to load; host tokens not measured* |
| 19-phase benchmark (multi-tenant SaaS, with/without Agentix) | errors per phase 2.6→~0 · tests passing first try 79%→100% · refactor cascade 4/7→11/11 |

> ⚠️ **Honesty first:** the 19-phase benchmark is **N=1, directional, not peer-reviewed** — see [BENCHMARK.md](BENCHMARK.md). Live counts of modules, MCP tools and tests change with every release, so they're not written here: `node scripts/sync-version.cjs --inventario` and `akdd capabilities` print them.

---

## Compatibility

Agentix is **first-class on Claude Code and Cursor** — that's where it's battle-tested. Because the engine relies on **open standards** (`AGENTS.md` and **MCP**), it *should* also work with other agents (VS Code, Windsurf, Kiro, Aider…), but in the interest of honesty: **so far it's only thoroughly tested on Claude Code and Cursor**. If you try it on another IDE and it works, open an issue.

Node.js: the package declares `>=20`, matching the CI matrix (Windows and Linux on Node 20, 22 and 24). `akdd update` additionally needs a SQLite driver that passes its capability checks: `node:sqlite` (Node ≥ 22.13) or a compatible `better-sqlite3`. Where neither exists it refuses before writing, and the update tests are skipped saying why. **Verified for this release: Windows with Node 24.** The CI matrix has not run on this release yet, so Linux and Node 20/22 are not verified here. Git is required.

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
akdd update                    # One command: back up, migrate (compatible, additive) and VERIFY. Exit 0 only if verifiable
akdd update --check            # Plan only — changes nothing
akdd update --json             # One structured JSON document on stdout
akdd update --no-migrate       # Skip the schema (the result is never reported as complete)
akdd update --rollback         # Undo the last update's FILES (memory is kept)
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

### Memory, context and effort (3.20.1)
```bash
akdd memory status                    # What is stored, what is pending, what each host captures
akdd memory capabilities              # Capture per host: NATIVE_PASSIVE / PIPELINE_ONLY / UNSUPPORTED
akdd memory index --query="..."        # Layered recall: 1 index, 2 detail, 3 timeline, 4 evidence
akdd memory detail --ids=12,40
akdd memory timeline --node=12
akdd memory evidence ev_... --lines=100-140
akdd memory capture --host=H --session=S --type=T --task=ID   # Record a real activity (idempotent)
akdd memory drain                     # Process the durable queue (deterministic, no model call)
akdd memory queue                     # Queue state; 'queue retry <job>' for a dead-letter job (bounded)
akdd memory provenance <node>         # Which activities and evidence a piece of knowledge comes from
akdd memory validate <node> --evidence=ev_... --by=gate|test|user|verifier
akdd memory project status|adopt|fork # Stable project id: rename = adopt, copy = fork (always explicit)
akdd memory health [verify-write]     # Independent health states; only verify-write exercises a write
akdd context compress <file|-> --kind=log|test|json|search|doc|code --task=T [--purpose=debug]
akdd context recover <reference_id> [--lines=a-b|--json-path=items]
akdd context leer <file> --task=T     # Read with reuse (a changed hash always invalidates)
akdd effort budget estado <task>      # Cumulative effort budget per task · 'host' = what Agentix cannot observe
akdd teams packet estado|snapshot|ack|invalidar|cerrar   # Shared director/builder packets
akdd benchmark contexto [--json]      # Deterministic benchmark (net payload, honest measurement)
```

---

## Honest limits (what it is NOT)

1. **It's not invulnerable.** The armor reduces and directs error; it doesn't eliminate it. The quality of autonomous fixes comes from whichever model you run.
2. **Verified is not the same as live-certified.** TEAMS with two IDEs open at once, the IDE host-hook adapters and WhatsApp are verified in logic and fixtures, not yet inside a live IDE session.
3. **It has a coverage ceiling, and declares it.** Files without symbols don't get line precision — doubt closes the gate instead. `coverage-meter` and `UNKNOWN` states tell you where.
4. **Regex extractors, not a parser** — a measured decision (see "Where it comes from"). Edge cases fall into DOUBT, not silence.
5. **The semantic band stays in the model.** Business values are watched by iron, but "does this contradict the SPIRIT of the decision?" is judged by the LLM following protocol — and the ledger records which protection came from which.
6. **No fixed token-saving promise.** The effort numbers measure context requested, not host tokens or result quality.
7. **The 19-phase benchmark is N=1** — directional, not peer-reviewed.
8. **The update has limits it states.** A lock file cannot control an outside program that opens `memoria.db` with its own SQLite: for those the update relies on SQLite's write lock and **stops** (`BLOCKED`) if it can't get it. Dozens of engine modules still open SQLite directly instead of through the adapter; they are listed, locked by a test so no new one appears unnoticed, and do not consult the exclusion. A live TEAMS director/builder pair during an update was not tested end to end (the MCP server, the commit queue, post-cycle, telemetry and the TEAMS watcher were). `better-sqlite3` is unverified on Node 24. Restoring historical data over newer learnings is not part of `--rollback`.
9. **Memory with provenance sees what the host hands over.** Native passive capture needs the host hooks installed and only covers actions *before* they run; without them, only what goes through Agentix is recorded. A claim of "verified inside Cursor/Claude" is never made from a fixture: the TEAMS receiver, builder and director in the tests are simulated, the protocol and the database are real, and a smoke test in real hosts is `NO_EJECUTADO` unless you run it.
10. **Compaction is a payload measure, not a promise.** The benchmark measures bytes Agentix controls, deterministically; tokens are `bytes/4` estimates. A campaign with real models is `NO_EJECUTADO`. When recovering the original is needed, the saving shrinks — and in some cases it is zero by design.
11. **The redactor reduces risk; it is not a DLP.** Regular expressions miss secrets that carry no context. Use `.agentic/privacy-policy.json` to deny paths and fields.


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
npm run release:check          # suite + tarball privacy + the INSTALLED tarball updating real 3.19.0 and 3.20.0 consumers + MCP
npm run release:verify         # AFTER publishing: downloads from npm, same bytes as the verified tarball?, repeats the 3.19.0 upgrade with it
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
