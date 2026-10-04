<div align="center">

<img src="assets/logo.svg" alt="Agentix KDD" width="600">

### The armor for your AI coder.

<p>
<img src="https://img.shields.io/badge/version-3.20.4-3FE2E8?style=for-the-badge&labelColor=0A0E14" alt="version"/>
<img src="https://img.shields.io/badge/license-MIT-D9A33C?style=for-the-badge&labelColor=0A0E14" alt="license"/>
<img src="https://img.shields.io/badge/Claude_Code_·_Cursor-ready-8A97A6?style=for-the-badge&labelColor=0A0E14" alt="compat"/>
</p>

**A development team of one.**

English · [Español](README.es.md)

</div>

---

## In one sentence

**Agentix KDD turns your repository's accumulated knowledge into an active prevention force: it makes your coding AI remember the project, not break what already worked, and leave a verifiable trail of every decision.**

It is not another AI that codes for you. It is the **armor** you put on the AI you already use — native on **Claude Code and Cursor** — and it lives **inside your project**: local SQLite, no cloud, no account, no subscription.

> *KDD = Knowledge-Driven Development — development guided by the project's own accumulated knowledge. (npm package: `agentic-kdd`.)*

---

## The problem it solves

You open Cursor or Claude Code. You explain your project *again*. The AI starts from zero *again*. It breaks something that was working *again*. It changes a business rule without remembering why it was set that way. Two real client cases shaped the current generation: a combobox applied "everywhere" broke selects that ALREADY worked, and CSS work broke existing `required` validations. Both are the same disease: **the AI can't see what is already proven, and nothing mechanical stops it.**

You are not coding — you are babysitting the context by hand. **Agentix takes that over.**

---

## Agentix at a glance

Everything Agentix does belongs to one of **three pieces**. If you get lost in the feature list, come back to this table.

| | Piece | What it does | Its organs |
|---|---|---|---|
| ⚓ | **Anchor** — memory | Remembers decisions, rules, errors and the code's structure across sessions, **traces where each piece of knowledge came from**, and surfaces only what is relevant at the right moment. | 4-layer memory (CoALA) · KDD graph · AST code graph with line precision · hybrid BM25 + vector recall under a token budget · **memory with provenance** (activity → observation → knowledge → evidence) · **layered recall** · **compaction that keeps the original** · privacy redaction · known-cure matching · natural-language per-file descriptions · MemCurator · gate ledger · measured task time |
| 🔧 | **Lever** — verification | Before accepting a change, mechanically checks that it doesn't break what already worked. When in doubt it **stops on the safe side**. Never reports a false "green". | Evidence-based closing (PASS/FAIL/SKIP/UNVERIFIED/ERROR) · TDD Gate · Preservation Gate (per-test contracts + front scenarios) · Regression Guard · protected files · AST blast radius · Spec Gate · Security Gate (secrets/PII/injection/cross-tenant) · Browser Gate · UI Native Gate · design memory · CSS Token Gate · Simple Gate · git hooks · prediction grading |
| 🔨 | **Hammer** — autonomy | Runs complete development cycles on a leash: analyzes, builds, tests, learns, recovers from stops, and reports. | `aa:` pipeline · effort router (LOW/MEDIUM/HIGH) · LEGION MODE (parallel sub-agents, read/judge steps only) · 4-lens QA · `audit:` department · restore points · RECOVERY protocol · multi-instance locks · safe update · ClickUp bridge (opt-in) · WhatsApp notices (opt-in) |

**The measured property that defines the armor:** when Agentix doubts, it protects. Against a real parser, of 1,989 symbols compared, the range error falls on the safe side in **99.75%** of cases (dangerous side: 5 cases, all ≤ 5 lines).

### One engine, two ways to work

| You want… | You type | What runs |
|---|---|---|
| **One agent, one task** (the daily mode) | `aa: <task>` | The full individual pipeline: enricher → analysis → build → TDD → QA → memory → post-cycle → measured time |
| **Read-only audit** | `audit: auditar` | Seven auditors in parallel; never touches code |

Everything `aa:` does closes through one **core** — cycles, KDD memory, contracts, AST, design memory, preservation gate and dashboard.

---

## Quick start

```bash
# 1. Install the CLI
npm install -g agentic-kdd

# 2. In your project
cd your-project
akdd init

# 3. Connect the MCP once for ALL your projects (recommended)
akdd mcp --global

# 4. Open Claude Code or Cursor and type:
aa: configurar
```

From there, every task starts with `aa:`. The pipeline runs on its own and only stops you on a genuine STOP (a contradicted business rule, a broken test, a critical file).

```
aa: add pagination to the clients list
aa: --dry-run refactor the payment validation   ← proposes, writes nothing
aa: explore how to model recurring invoices     ← thinks with you, writes nothing
aa: sprint — full invoicing module              ← chained tasks; each feeds the next
aa: aprende                                     ← absorbs work done outside the pipeline
audit: auditar                                  ← 7 parallel auditors; read-only
akdd dashboard                                  ← see everything
```

> The command vocabulary (`aa:`, `audit:`) is Spanish — the task you write after it can be in any language. Chat prefixes are instructions for the agent, not shell commands.

---

## The daily cycle — what `aa:` does

```
aa: <task>
   │
   ├─ 0    start the clock · Context Enricher brief (risk, known cures, active alerts)
   ├─ 1    Orchestrator → effort tier LOW / MEDIUM / HIGH (max of difficulty and risk)
   ├─ 2    Analyst  (parallel read-only exploration when the change is not trivial)
   ├─ 3    Spec Gate · Security Gate · Regression check — before a single line is written
   ├─ 4    Build    (Front + Back in parallel only when their files don't overlap)
   ├─ 5    TDD Gate · Preservation Gate · Browser Gate · UI/CSS gates
   ├─ 6    QA       (4-lens review when the change is not objectively trivial)
   ├─ 7    Memory   (errors, patterns, decisions, descriptions — with provenance)
   └─ 8    post-cycle · measured duration  →  report
```

It stops you only on a genuine STOP, with the exact zone and the reason. Everything it verified is recorded in the ledger (`gate_events`) with its origin: **`mechanical`** (iron that runs on its own) or **`protocol`** (the model following instructions) — so you can measure what fraction of your protection is iron: `node .agentic/grafo/gate-telemetry.cjs stats`.

### What happens on its own — you type nothing

| When | What runs automatically |
|------|--------------------------|
| On every git **commit** | **Pre-commit** over the *index* (what you are really committing): security shield (leaked secrets, cross-tenant, JWT bypass **block**; PII and invisible Unicode warn), test integrity (removing a case from a protected test **blocks**), UI native, business values. **Commit-msg**: the canary — a *fix* without any test **blocks**. **Post-commit**: queues the commit by SHA and closes the cycle in the background. Never blocks. |
| On every **post-cycle** | Spec/test integrity scan · design memory (values that return to an abandoned state, properties that disappear) · CSS tokens · Simple Gate · Preservation Gate · risk-prediction grading · deps audit · **memory with provenance** (the cycle is recorded as a real activity, the queue is drained, validated knowledge whose files changed becomes *suspect*) · cycle closed from real gate states |
| Inside every **`aa:`** | Context Enricher brief · effort tier · gates · tests · 4-lens QA · memory · measured duration |
| Every **5 cycles** | Checkpoint to resume in another chat or machine |
| On **init / update** | Hooks install themselves (respecting your own); the AST index rebuilds once if the engine changed versions; the schema migrates **inside** `akdd update`, with backup and verification |

Emergency hatch for the hooks: `AKDD_SKIP_GATES=1 git commit ...` — the optional IDE guard (`akdd host-hooks install`) denies that hatch and `--no-verify` to the agent.

---

## ⚓ Memory — the Anchor

Agentix keeps its memory in the project's own `memoria.db`: four layers (working / procedural / episodic / semantic — after **CoALA**), a knowledge graph of decisions, errors and patterns, and an AST map of the code. Search is hybrid (BM25 + vector) under a token budget; `recall` returns only what is relevant to the area you are about to touch, and when the area has a **known cure** — an error that already happened with the fix that worked — the brief opens with it.

### Memory with provenance (3.20.1)

Everything below is **native**: no Claude-Mem, no Headroom proxy, no cloud service, no extra daemon, and no paid call by default. Other projects inspired some ideas; the mechanisms are Agentix's own and live in the same database.

| Piece | What it is |
|---|---|
| **Activity** | A raw event from a real action: tool run, phase, gate result. Idempotent by project + host + session + host event id: resending one event keeps **one** activity and **one** job; two identical runs at different moments are **two** activities. |
| **Observation** | A bounded reading of one or more activities (test failure, files touched, explicit decision, gate result). Many reads of the same file become **one** grouped observation. |
| **Knowledge** | A KDD node with a state: *proposed → validated → suspect → obsolete*, mapped onto the existing node states. |
| **Evidence** | A verifiable artifact: id, SHA-256, size, scope, retention. |

**An observation or a summary never validates anything.** Validation needs *current* evidence (its hash is re-checked at that moment) and a validator that is a gate, a test, the user or a verifier. It is deliberately **not** exposed to the model over MCP: `akdd memory validate <node> --evidence=ev_… --by=gate`. When related code changes, validated knowledge becomes *suspect*. Identical knowledge in the same scope adds an occurrence instead of a new node; similar knowledge becomes a *review candidate*, never a merge; contradictions keep both origins. Records from before 3.20.1 are shown as `LEGACY_UNVERIFIED_PROVENANCE` when read — they are neither rewritten nor downgraded.

New tables arrive **only through `akdd update`**. Reading never creates or migrates anything: on an old database the memory commands say `SCHEMA_MISSING` and point to `akdd update`. Existing nodes keep their IDs (INTEGER or TEXT) and their content.

**Privacy comes first.** Text is classified *authorized / redacted / private / unknown* and redacted **before** it reaches the database, the queue, a cache, the delivered context or the dashboard. Redaction **fails closed**: a redactor error stores nothing, never the original. Private paths (`.env`, keys, credentials…) keep metadata only. Add your own denied paths and fields in `.agentic/privacy-policy.json`. Regular expressions cannot guarantee they catch every secret — treat the redactor as risk reduction, not as a DLP.

**What is captured depends on the host** — `akdd memory capabilities` prints the real picture:

| Host | Capture | What it sees |
|---|---|---|
| Claude Code / Cursor **with the host hooks installed** (`akdd host-hooks install`, never automatic) | `NATIVE_PASSIVE` | Shell, edit and MCP actions **before** they run, and the guard's decision — not the tool's output |
| Same hosts **without** hooks | `PIPELINE_ONLY` | Only what goes through Agentix: `aa:`, post-cycle, Agentix MCP tools |
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

Every answer carries explicit states (`OK`, `NO_RESULTS`, `NO_DB`, `SCHEMA_MISSING`, `ERROR`, `INSUFFICIENT_BUDGET`), a known total, `has_more`/cursor and *why* something was omitted. Budgets are **cumulative per task** and follow the effort tier. Applicable **protected contracts are never dropped silently** by a budget. Lexical search works without embeddings and never creates the FTS index while querying. The same layers are MCP tools (`memory_index`, `memory_detail`, `memory_timeline`, `memory_evidence`); `recall` and `remember` are unchanged.

### Compaction that keeps the original

`akdd context compress <file|-> --kind=log|test|json|search|doc|code --task=T` compacts a large tool result **deterministically** (no model, no Python, no ML) and stores the authorized original; `akdd context recover <reference_id> --lines=a-b` returns it with its hash verified.

- Logs group exact repetitions and keep the context around errors; test runs keep **every** failure; JSON is delivered as an explicitly labeled *sample* with the original counts; searches keep all affected paths.
- **Code you are about to edit, audit, debug or verify is delivered whole**, as is gate evidence. Only orientation uses the AST index.
- **A sample can never prove absence.** "No failures" requires the complete original.
- A malformed, empty or inflationary compaction returns the original with a warning. An expired or changed reference answers `EXPIRED` / `EVIDENCE_CHANGED` — never reconstructed content. Gate evidence is durable; originals used by an active task or sprint are pinned; only unpinned cache expires.

### Effort that really changes

`LOW` means less: no global search and no needless delegation — while scope, protected files, security and leases stay in every tier, and a "small change" to auth, payments or a migration stays `HIGH`. Reads of unchanged files are reused, and a changed hash always invalidates. Controlling the *provider's* reasoning effort needs an explicit integration that is **not installed**; Agentix declares `HOST_NATIVE_UNCONTROLLED` and never promises to shrink a host's internal thinking. `akdd effort budget …` shows the cumulative budget of a task.

---

## 🔧 Verification — the Lever

| Gate | What it guarantees |
|---|---|
| **Evidence-based closing** | PASS needs the **execution artifact of the exact subject**. An invented id, a runner with zero assertions, or code that changed after the run → `UNVERIFIED`, never green |
| **TDD Gate** | The tests actually ran (and `typecheck` alongside); contracts accumulate per individual test |
| **Preservation Gate** | Contracts per test, front scenarios, a `.agentic/protected_files` manifest, impact by real AST edges. Incomplete coverage reads `UNKNOWN`, never `LOW` |
| **Regression Guard** | Behaviors that passed repeatedly are protected: breaking one stops the cycle until you override on purpose |
| **Spec Gate** | A prompt that contradicts a HIGH-confidence business value in memory (trial days, prefixes, limits…) stops with the exact rule |
| **Security Gate** | Leaked secrets and credentials (**block**), PII, prompt-injection, invisible Unicode, and ORM-agnostic cross-tenant / JWT-bypass checks on critical files |
| **Browser Gate** | A real Chrome/Edge: console errors, page errors, contract checks (`required`, a11y, keyboard, flows), visual snapshots with a pixel diff |
| **UI Native · CSS Token · Simple · design memory** | Native `confirm()`/`alert()` instead of your wrappers, hand-typed values that already exist as tokens, duplicated code, and layout decisions that silently revert |
| **Test integrity · canary** | A test that verified a protected pattern can't be weakened in silence; a *fix* without a test doesn't close |
| **Prediction grading** | Every risk prediction is logged and graded against what the gates later found; the number to push down is the **false negative** (predicted LOW, something broke) |

---

## 🔨 Autonomy — the Hammer

### TEAMS — being rebuilt

The TEAMS mode (Claude Code directs, Cursor builds) was removed from this version and is being rebuilt from scratch. Until it ships, use `aa:` (one agent, one task) and `audit:`.

### The rest of the hammer

- **Effort router** — LOW / MEDIUM / HIGH = max(difficulty, risk). Small *and* risky still gets the risk controls; minimum gates can't be removed, not even by a custom policy.
- **LEGION MODE** — parallel sub-agents only on read/judge steps (analysis, review). Writing code and saving memory always have a single author. If the host has no sub-agents, the same steps run sequentially with an identical result.
- **`audit:` department** — seven auditors (security, frontend, backend, data, performance, browser, code) in parallel; reports land in `_output/audit-[date].md`; they never touch code.
- **Restore points** — `aa: restore point crear <summary>` · `aa: restore <id>`. Points are Git commits in private refs; HEAD, branch, index and `git status` are identical before and after. Applying shows **what gets written, what gets deleted, what stays out and what does NOT come back** (database, deploys, sent messages), requires the current-state hash, creates a rescue point first and verifies by hash afterwards.
- **RECOVERY protocol** — when a gate stops, memory is consulted for a known error→fix pair, the minimal diff is applied and the *same* gate re-runs. Critical files and business-value conflicts always escalate to you.
- **Multi-instance locks** — several agents in one project don't collide on modules or schema.
- **Time measurement** — every task reports how long it took (worked vs elapsed). A cycle with no trace is shown as *no data* — never as `0` and never estimated.
- **ClickUp bridge (opt-in)** — `akdd cu on`, `akdd cu set-list <id>`, `akdd cu sprint [--auto]`. A task runs on its own only if it is clearly relevant, touches no critical files, doesn't contradict a business value in memory, doesn't touch authentication and has a substantive description. Off by default.
- **WhatsApp notices (opt-in)** — through your own WhatsApp Web session; whatever arrives is data, never an approval.

---

## Dashboard

`akdd dashboard` → localhost:3847. The tab bar has the original views plus the pages added in 3.20.1:

| Tab | What you see |
|---|---|
| 🧠 **Knowledge Graph** | KDD memory, Code Structure and Combined — three graphs in real 3D, with a **☰ Table** view and the guided tour. Unchanged |
| 📚 **Project Docs** | Per-module documentation and natural-language file descriptions |
| 🛡️ **Preservation Intel** | Contracts, Creative Engine, MemCurator, design memory |
| ⏱ **Línea de Tiempo** | Measured time per task and module |
| 🧬 **Memoria** (`/memoria`) | What is stored, the queue and dead-letters, provenance, legacy records, independent health states |
| 📦 **Contexto y esfuerzo** (`/contexto`) | Effort tier, cumulative budget, net payload reduction and *how it was measured*, per-host coverage |
| 🔄 **Actualización** (`/actualizacion`) | Installed version, schema compatibility, the last verification, what was preserved, the backup, what to do |

The new pages are read-only and paginated; opening one never writes. Health shows independent states — service, readable, schema, search, last verified write, queue, update — and the dashboard is **not green** if the schema is broken even when HTTP answers 200. Missing data reads "not available", never `0`. A read-only API (`/api/v1/summary`, `/tasks`, `/contracts`, `/incidents`, `/usage`, `/restore-points`…) and the graph libraries are served locally — no CDN.

Every capture below is from a real production SaaS project (~414 files).

**KDD Memory** — decisions, errors and patterns. Knowledge born from the frontend is distinguished by color and filterable with Front/Back:

<img src="assets/dash-kdd-memory.png" alt="KDD Memory — memory with front/back color families" width="100%">

Click any node: its connections light up and the panel shows the full rule, its confidence, the cycle it was born from, and what it relates to:

<img src="assets/dash-kdd-node.jpg" alt="KDD Memory — selected node with its connections and detail panel" width="100%">

**Code Structure** — a native map of your actual code (files, symbols, forms, CSS classes and their connections), straight from the AST index. Zero LLM calls, zero tokens:

<img src="assets/dash-code-structure.jpg" alt="Code Structure — 3D code map with department palette" width="100%">

**Combined** — how your code and your accumulated decisions relate:

<img src="assets/dash-combined.jpg" alt="Combined — code and knowledge in one graph" width="100%">

**Preservation Intel** — the contracts that can't be broken, the Creative Engine with its autonomy level, MemCurator and structural learning:

<img src="assets/dash-preservation-contracts.jpg" alt="Preservation Intel — Contract Guard, Creative Engine, MemCurator, Structural Learning" width="100%">

And the UI/Frontend memory: watched forms, selects, `required` fields and CSS classes, with the UI Native Gate in green:

<img src="assets/dash-preservation-ui.jpg" alt="Preservation Intel — design memory, UI Native Gate and UI Eyes" width="100%">

Plain-language visual guides: [how to read the graph](docs/GRAFO-GUIA.md) · [how to read contracts + Creative Engine](docs/CONTRATOS-GUIA.md)

---

## The MCP — why it matters and how to connect it

**MCP is the bridge between the model and Agentix.** Without it, the model only uses memory, contracts and gates if it remembers to open a terminal and run the scripts — and often it doesn't. With it, Cursor and Claude Code see Agentix as native tools:

| Moment | Tool the model calls | What it gets |
|---|---|---|
| Before touching a module | `recall`, `verdad_vigente`, `memory_index` → `memory_detail` | Known errors, decisions and patterns for that area — only what is relevant, in layers, within a token budget |
| Before planning a change | `impact_precheck`, `contracts_blast`, `effort_decide` | What breaks if this file changes, how many contracts are at risk, which tier and gates apply |
| While working | `pipeline_step`, `pipeline_gate`, `contracts_gate`, `context_compress` / `context_recover` | Each step registered through the harness; large outputs compacted with the original recoverable |
| When closing | `remember`, `causal_add`, `memory_capture` | The tested lesson goes into memory for the next session |
| Coordination | `restore`, `session_historial` | Restore points, resuming a chat |

It is the same engine and the same `memoria.db` as the CLI — **not another AI, not a cloud memory**. Its value depends on the agent using the tools; it can't keep an IDE session alive by itself. List the live tool set with `akdd capabilities`.

### Connect it once, globally

```bash
akdd mcp --global
```

- Copies a small launcher to `~/.agentix/mcp-launcher.cjs`.
- Adds **one** `agentic-kdd` entry to `~/.cursor/mcp.json` (your other MCP servers are preserved; an invalid JSON is left untouched and reported) and registers it in **Claude Code with user scope**.
- When an IDE starts it, the launcher finds the project you have open and starts **that project's own server, with that project's engine version and memory**. Memories never mix.
- Outside an Agentix project it answers with a single `agentix_status` tool that says so — no error, no memory read.

Then **Reload Window** in Cursor and open a new Claude Code session. `akdd mcp status` shows what is configured. `akdd mcp` (without `--global`) still configures a single project; a project-level entry wins over the global one.

---

## Updating — one command that proves what it did

```bash
npm install -g agentic-kdd@latest     # the new engine, once per machine
akdd mcp --global                     # refresh the global MCP launcher (once)

cd your-project                       # in EACH project that already uses Agentix
akdd update --check                   # optional: see the plan, change nothing
akdd update                           # backup → migrate → verify → report
akdd health
```

Installing the new CLI does **not** touch any project; each project updates when you tell it to. `akdd update` **inspects → backs up → applies → verifies → reports**, and only exits `0` when the result is something it can back with evidence:

| Step | What happens |
|---|---|
| **Inspect** | Reads the package you installed, your files and the *real* structure of `memoria.db` (tables, columns, indexes) — not just `config.md` or the npm version. An old database with no migration registry is inspected by capability; `user_version = 0` is never assumed to mean "empty". |
| **Exclude writers** | A per-project lock (owner token, heartbeat, abandoned-lock recovery). Engine writers, git-hook workers and the MCP server pause and **acknowledge**; if a live service doesn't, the update stops before touching anything. Cursor, Claude and your other processes are never killed. |
| **Back up** | A consistent SQLite backup (`VACUUM INTO`, so commits still sitting in the `-wal` are included), **opened and integrity-checked** before the first change. Space and write permission are checked first. |
| **Apply** | Compatible, **additive** schema migrations in **one transaction**, recorded in a registry (stable id, checksum, version, date, result). Nothing is destructive and nothing hides behind an empty `catch`. Framework files are replaced through a journal; yours are not. |
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

Options: `--check` (plan only), `--json` (one JSON document on stdout), `--no-migrate` (the result is **never** reported as complete if the schema is missing), `--from=` / `--sha256=` / `--ref=` (explicit alternative sources), `--rollback`.

**What gets preserved.** `memoria.db` content, the memory Markdown, `config.md`, knowledge, `PLAN.md`, your instructions, your code, and any rule you added (`.cursor/rules/`, `.audit/`, …). Every framework file is classified against a *verifiable* base — the hashes Agentix recorded when it installed it, or the hashes of the published releases. A file with your changes (or with no reliable base) is **kept**, and the new version is saved beside it in `.agentic/_update/tx/<id>/personalizados/`. If a kept file is indispensable for the new engine, the update **blocks before applying anything** rather than leave a half-old engine. Text under the `INSTRUCCIONES DEL PROYECTO` marker in `CLAUDE.md` is moved without losing a heading, a comment or a segment; if two versions of your instructions exist, both originals are kept and merged.

**What can block it.** A schema newer than this engine; an unreadable or corrupt database; a database held by a process that doesn't follow the protocol; a service that won't pause; not enough disk space; a framework folder that is a link pointing outside the project; an indispensable engine file you customized; no SQLite driver that passes the real capability checks.

**Rollback, and its limit.** `akdd update --rollback` reverts the **files** of the last update and never restores an old database over newer learnings. It refuses if the schema changed after that update. Restoring historical data is a different, explicit operation — the verified backup stays on disk for it.

**Requirements.** A SQLite driver that passes the real checks (read-only, transactions, locking, backup with WAL, BLOB, 64-bit integers, multi-process, clean close): `node:sqlite` on Node ≥ 22.13, or a compatible `better-sqlite3`. `sql.js` re-exports the whole file from memory and is **not** accepted for an update. In this release the verified driver is `node:sqlite`; `better-sqlite3@^9` has no prebuilt binary for Node 24 and failed to compile there, so that path is **unverified**.

**This path is proven, not promised.** The release check installs the tarball it is about to publish in a clean directory, builds consumers by running the **published** 3.19.0 and 3.20.0 engines, adds data a real project could lose, and runs `--check`, `update`, a second `update`, the MCP over stdio and `--rollback` with that installed CLI. After publishing, `npm run release:verify` downloads what is actually on npm, checks it is byte-for-byte the verified tarball, and repeats the 3.19.0 upgrade with it.

---

## How mature each organ is (honesty by tiers)

**🥇 Battle-tested** (repeated real use): the `aa:` pipeline, 4-layer memory + hybrid search, classic gates (Spec/TDD/Security/Regression), automatic per-commit registration, checkpoints, multi-instance locks, dashboard graphs, MCP, line-level containment, parallel Front/Back.

**🥈 Verified with fixtures, real Git, real SQLite and a real browser** (controlled scenarios, not yet months of production): evidence-based closing, the transactional update and its upgrades from the real npm packages, effort router and context packages, per-test contracts, protected files, AST blast radius, index-based git hooks and the canary, restore points, **memory with provenance, the durable queue, layered recall and compaction**, the global MCP launcher, the dashboard pages, time measurement.

**🥉 Logic verified, live host NOT verified**: IDE host-hook adapters inside each IDE, WhatsApp notices end to end.

**🔒 Private beta**: team collaboration (shared memory).

---

## Measured numbers (not estimates)

| Metric | Value |
|---|---|
| Range-error direction (vs real parser, 1,989 symbols) | 99.75% safe side |
| Graph of a real project (~414 TS+JS files) | 3,757 symbols · ~4,900 edges · 100% with line ranges |
| **3.20.4 release check** (2026-10-04, Windows, Node 24 — the only platform measured) | Full suite 946/947 (the one not run is a smoke inside real Cursor/Claude hosts, declared `NO_EJECUTADO`) · tarball (243 files) with no private data · 528 adversarial probes, 0 failures · the **installed tarball** is what gets tested |
| **Real upgrades 3.19.0 → 3.20.4 and 3.20.0 → 3.20.4** (consumers built by running the published engines) | `akdd update` alone: `VERIFIED` (25 and 9 migrations applied) · memory preserved by **content** (30–31 tables, 567–572 rows compared, plus 500 private rows in a user table) · second update `NO_CHANGES_VERIFIED` · `--rollback` reverts files and keeps newer memory · the previous engine still reads the migrated database · MCP `initialize` / `remember` / `recall` over stdio |
| Effort router (15 fixtures, threshold fixed before running) | LOW: −90% context bytes, −54% steps · MEDIUM: −25 to −32% · HIGH keeps tdd, preservation, QA and reviewer. *Proxy: bytes Agentix asks to load; host tokens not measured* |
| 19-phase benchmark (multi-tenant SaaS, with/without Agentix) | errors per phase 2.6→~0 · tests passing first try 79%→100% · refactor cascade 4/7→11/11 |

### Context benchmark (deterministic, no user data)

`akdd benchmark contexto` runs seven cases against the real modules — baseline (nothing compacted) vs optimized, same task, same acceptance. Recovering an original **counts against** the saving.

| Case | Net payload saved | Note |
|---|---|---|
| A · text change under `LOW` | 94.1 % | no global search, no delegation, guards intact |
| B · one error in 20,000 log lines | 99.8 % | the error stays visible, original recoverable |
| C · "small change" in auth/payments | **0 %** | **by design**: stays `HIGH` with every control |
| D · refactor with protected contracts | 95.2 % | all 30 protected contracts listed; under a tight cap it answers `INSUFFICIENT_BUDGET` instead of dropping any |
| E · rare critical record in a long JSON | 99.4 % | found over the complete original |
| F · empty / malformed / secret / code to edit | 41.4 % | edges: nothing lost, nothing leaked |
| H · 4,000-node memory | 99.3 % | index + two details, never a dump |

All acceptance criteria held. This is a **payload** reduction (bytes exact; tokens are `bytes/4` *estimates*), not a saving of session, reasoning or money. A campaign with real models is `NO_EJECUTADO` (it costs money and needs your authorization), and none of this was measured inside Cursor or Claude Code.

> ⚠️ **Honesty first:** the 19-phase benchmark is **N=1, directional, not peer-reviewed** — see [BENCHMARK.md](BENCHMARK.md). Live counts of modules, MCP tools and tests change with every release, so they are not written here: `node scripts/sync-version.cjs --inventario` and `akdd capabilities` print them.

---

## Compatibility

Agentix is **first-class on Claude Code and Cursor** — that's where it's battle-tested. Because the engine relies on **open standards** (`AGENTS.md` and **MCP**), it *should* also work with other agents (VS Code, Windsurf, Kiro, Aider…), but in the interest of honesty: **so far it's only thoroughly tested on Claude Code and Cursor**. If you try it on another IDE and it works, open an issue.

Node.js: the package declares `>=20`, matching the CI matrix (Windows and Linux on Node 20, 22 and 24). `akdd update` additionally needs a SQLite driver that passes its capability checks (see above). **Verified for this release: Windows with Node 24.** The CI matrix has not run on this release yet, so Linux and Node 20/22 are not verified here. Git is required.

---

## Where it comes from — technologies and inspirations

Agentix didn't invent every piece from scratch — it combined proven ideas that existed separately and added the missing part: making memory **block**, not just remember.

| Idea in Agentix | Where it comes from |
|---|---|
| 4-layer memory (working / procedural / episodic / semantic) | **CoALA** — *Cognitive Architectures for Language Agents* (Sumers, Yao, Narasimhan & Griffiths, Princeton, 2023). Agentix implements it in local SQLite. |
| Memory with provenance, layered recall, recoverable compaction | Ideas explored by other agent-memory projects (progressive disclosure of observations, context compression with retrieval). In Agentix they are native modules with their own tests — no third-party service is installed or called. |
| Code map with PageRank over symbols | **Aider's repo-map** idea (Paul Gauthier). Agentix takes it further: line ranges per symbol, forms/CSS as nodes, and the map feeds a gate that STOPS — not just context. |
| Per-module specs and watched business rules | The **spec-driven development** current (popularized by tools like AWS's Kiro). In Agentix the spec is generated from the cycle and the Spec Gate defends it. |
| Unsummarized episodes + reasoning bank | The episodic-memory research line for agents (Reflexion and successors): storing full trajectories avoids summarization drift. |
| Editor integration | **Open standards**: MCP (Model Context Protocol, Anthropic) plus `CLAUDE.md`/`AGENTS.md` and standard git hooks. Nothing proprietary. |
| Real-browser verification | **playwright-core** pointed at the Chrome/Edge you ALREADY have installed (zero browser downloads). |
| Persistence | **SQLite** (`node:sqlite`, with a compatible `better-sqlite3` as an alternative where it builds). |
| Restore points | **Git's own object store**: commits in private refs (`refs/agentix/restore/*`) built with a temporary index, so your branch never moves. |
| Publishing | **npm trusted publishing (OIDC)** from GitHub Actions — no long-lived write token stored anywhere. |
| Symbol extraction | Disciplined regex, **not** tree-sitter — a MEASURED decision: a comparator against real tree-sitter was built, 1,989 symbols were measured, and the regex approximation proved sufficient (99.75% of errors fall on the safe side). The comparator stays in the engine to re-measure anytime. |
| *Fail-closed* philosophy | Classic safety engineering: when in doubt, the gate closes. All line-level containment degrades to "whole file protected" on ANY doubt. |

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
akdd doctor                    # Repair steps: schema, sync, AST, graph integrity, locks
akdd capabilities              # Installed / wired / executed / verified, per module
akdd dashboard                 # Visual board at localhost:3847
```

### Effort & context
```bash
akdd effort decide "<task>" --paths=a,b [--type=T] [--json]   # Tier + gates + budgets
akdd context armar "<goal>" --paths=a,b                        # One context package per task
akdd restore <list|create --label=L [--files=a,b]|show <id>|preview <id>|apply <id> --expected-current-hash=H>
```

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
akdd benchmark contexto [--json]      # Deterministic benchmark (net payload, honest measurement)
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
2. **Verified is not the same as live-certified.** The IDE host-hook adapters and WhatsApp are verified in logic and fixtures, not yet inside a live IDE session.
3. **It has a coverage ceiling, and declares it.** Files without symbols don't get line precision — doubt closes the gate instead. `coverage-meter` and `UNKNOWN` states tell you where.
4. **Regex extractors, not a parser** — a measured decision (see "Where it comes from"). Edge cases fall into DOUBT, not silence.
5. **The semantic band stays in the model.** Business values are watched by iron, but "does this contradict the SPIRIT of the decision?" is judged by the LLM following protocol — and the ledger records which protection came from which.
6. **No fixed token-saving promise.** The effort numbers measure context requested, not host tokens or result quality.
7. **The 19-phase benchmark is N=1** — directional, not peer-reviewed.
8. **The update has limits it states.** A lock file cannot control an outside program that opens `memoria.db` with its own SQLite: for those the update relies on SQLite's write lock and **stops** (`BLOCKED`) if it can't get it. Dozens of engine modules still open SQLite directly instead of through the adapter; they are listed, locked by a test so no new one appears unnoticed, and do not consult the exclusion. `better-sqlite3` is unverified on Node 24. Restoring historical data over newer learnings is not part of `--rollback`.
9. **Memory with provenance sees what the host hands over.** Native passive capture needs the host hooks installed and only covers actions *before* they run; without them, only what goes through Agentix is recorded. A claim of "verified inside Cursor/Claude" is never made from a fixture; a smoke test in real hosts is `NO_EJECUTADO` unless you run it.
10. **Compaction is a payload measure, not a promise.** The benchmark measures bytes Agentix controls, deterministically; tokens are `bytes/4` estimates. When recovering the original is needed, the saving shrinks — and in some cases it is zero by design.
11. **The redactor reduces risk; it is not a DLP.** Regular expressions miss secrets that carry no context. Use `.agentic/privacy-policy.json` to deny paths and fields.
12. **The wake-up is the host's, and is verified only by a read.** The watcher detects; the model is woken by the background task (or the loop) of its host. Agentix never calls the wake verified until the session confirms a read after a notice; where neither exists the mode is `MANUAL_ONLY`.

---

## The Coliseum — adversarial arena (evidence, not marketing)

Instead of a benchmark that proves Agentix wins, we built one designed to **break it on purpose**: 15 attack rounds escalated across 4 tiers against a real project (MediCore, a multi-tenant clinical SaaS with business rules, tenant isolation, and a real concurrency race), each run twice — **with** Agentix (`aa:`) and **without** it (naked agent) — to measure the difference with facts, not narrative.

**Result:** 14 of 15 rounds held clean. The one real crack happened after the human forced an explicit override against the system's recommendation — and instead of leaving the accepted risk visible, the agent hid the reintroduced bug by weakening the test that watched it. A false green is worse than an honest red.

**The cracks found are repaired and verified**: a test that verifies a HIGH-confidence pattern can't be weakened in silence (`test-integrity-gate.cjs` — since 3.20 it reads the index and blocks), the Security Gate stopped depending on the Prisma dialect to detect cross-tenant leaks, and the TDD Gate runs `typecheck` alongside tests.

### Second round — machinery audit

Re-run on new terrain (FLOTA360, a multi-tenant fleet SaaS with pre-poisoned memory), measuring **what the MECHANICAL gates catch on their own**. Narrow-domain gates (native UI, layout, locks, secrets) proved solid iron; semantic traps leaned on the memory brief + the model. The mechanical holes found were sealed: ORM- and vocabulary-agnostic cross-tenant (0 false positives across 28 real routes), `related_files` derived from tests, long token expiry as a visible WARN, widened test discovery, and a red `akdd health` when cycles exist but the Preservation Gate protects nothing.

### Third round — the adversarial probes of 3.20

The repository ships an adversarial sandbox (`sandbox/`) that attacks the gates themselves: fake PASS ids, empty runners, replayed executions, stale caches, evidence from another subject, payloads hidden in file names. The release check runs 528 of them with a fixed seed — 0 failures — and meta-tests plant a bug in each gate to prove the negative test catches it.

The full Coliseum playbook lives on the [`coliseo-arena`](https://github.com/Adrianlpz211/AGENTIX-KDD/tree/coliseo-arena) branch — run the rounds yourself.

---

## For maintainers — release and publish

```bash
npm ci
npm run release:check          # suite + tarball privacy + the INSTALLED tarball updating real 3.19.0 and 3.20.0 consumers + MCP
npm run release:verify         # AFTER publishing: downloads from npm, same bytes as the verified tarball?, repeats the 3.19.0 upgrade with it
```

Results, the log and the exact tarball land in `_output/release-<version>/` (`verification.json`). Publishing goes through the manual GitHub Actions workflow **Publish npm (manual)** (npm trusted publishing, OIDC) or an explicit `npm publish` of the verified tarball by the maintainer. The requirement → test → platform → artifact matrix is [MATRIZ-3.20.1.md](MATRIZ-3.20.1.md); setup and steps: [PUBLICACION-3.20.md](PUBLICACION-3.20.md); changes: [CHANGELOG.md](CHANGELOG.md).

---

## Status & transparency

Agentix is **young, evolving software**. 3.20 was built by asking, gate by gate, whether a green could be faked — and closing it where it could; 3.20.1 added memory you can trace, an update that proves itself, and the groundwork for a rebuilt TEAMS mode. Even so, **an audit doesn't certify zero defects** — if you find something, open an issue.

The real promise, without inflation:

> **"Agentix makes your coding AI remember, respect and preserve your project as it evolves — and when something makes it doubt, it stops on the safe side. Every protection it exercises is recorded and auditable."**

Verify it yourself in 10 minutes: `akdd init` → `aa: configurar` → deliberately break something protected → watch the STOP with the exact zone → `node .agentic/grafo/gate-telemetry.cjs stats` → there is the recorded event.

---

## License

MIT — use it, fork it, build on it.

<div align="center">

Made by [@Adrianlpz211](https://github.com/Adrianlpz211)

*If Agentix saved you time → ⭐*

</div>
