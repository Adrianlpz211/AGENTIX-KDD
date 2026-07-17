<div align="center">

<img src="assets/logo.svg" alt="Agentix KDD" width="600">

### The armor for your AI coder.

<p>
<img src="https://img.shields.io/badge/version-3.15.0-3FE2E8?style=for-the-badge&labelColor=0A0E14" alt="version"/>
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

## The full map — three pieces, and EVERYTHING hangs from one of them

Agentix has many organs but only three pieces. If you ever get lost in the feature list, come back here: **everything it does belongs to one of these three rows.**

| | Piece | What it does | Its organs |
|---|-------|--------------|------------|
| ⚓ | **Anchor** — memory | Remembers decisions, rules, errors and the code's structure across sessions, and surfaces what's relevant at the right moment. | 4-layer memory (CoALA) · AST code graph with line-level precision · hybrid BM25+vector search · symbol anchors · autonomous curation (MemCurator) · gate telemetry (the "ledger") |
| 🔧 | **Lever** — verification | Before accepting a change, mechanically checks it doesn't break what already worked. When in doubt, it **stops on the safe side**. Never reports a false "green". | Regression Guard (line-level HIT/MISS/DOUBT) · TDD Gate · Spec Gate + business-value scanner · Security Gate (secrets/PII/injection) · Browser Gate (real Chrome/Edge) · UI Native Gate · pre/post-commit git hooks |
| 🔨 | **Hammer** — autonomy | Runs full development cycles on a leash: analyzes, builds, tests, learns, and recovers from stops — reporting everything back. | `aa:` pipeline · LEGION MODE (parallel sub-agents for read/judge steps only) · 4-lens QA · `audit:` department (7 auditors) · Creative Engine · RECOVERY protocol · multi-instance locks |

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
| Editor integration | **Open standards**: MCP (Model Context Protocol, Anthropic) — 54 tools — plus `CLAUDE.md`/`AGENTS.md` and standard git hooks. Nothing proprietary. |
| Real-browser verification | **playwright-core** pointed at the Chrome/Edge you ALREADY have installed (zero browser downloads). |
| Persistence | **SQLite** (better-sqlite3, with automatic fallback to Node 22+'s `node:sqlite` when your machine lacks a build toolchain — tested). |
| Symbol extraction | Disciplined regex, **not** tree-sitter — and this was a MEASURED decision, not a limitation: a comparator against real tree-sitter was built, 1,989 symbols were measured, and the regex approximation proved sufficient (99.75% of errors fall on the safe side). The comparator stays in the engine to re-measure anytime. |
| *Fail-closed* philosophy | Classic safety engineering: when in doubt, the gate closes. All line-level containment degrades to "whole file protected" on ANY doubt. |

---

## How you use it (this is all of it)

```bash
# 1. Install the CLI
npm install -g agentic-kdd

# 2. In your project
cd your-project
akdd init

# 3. Open in Claude Code or Cursor and type:
aa: configurar
```

From there, every task starts with `aa:`. The full pipeline (analyze → build → test → learn) runs on its own; it only stops you on a genuine STOP (contradicted business rule, broken test, critical file).

```
aa: add pagination to the clients list
aa: sprint — full invoicing module
aa: aprende                  ← absorbs work done outside the pipeline
audit: auditar               ← 7 parallel auditors; read-only, never touch code
```

> The command vocabulary (`aa:`, `audit:`) is Spanish — the task you write after it can be in any language.

**Already running an older Agentix?** `akdd update` and you're done. The upgrade path is **proven, not promised**: a client with a v3.12-era database was simulated and the v3.15 engine ran on top — 31/31 checks green, twice (with and without better-sqlite3). Your memory stays intact, new tables appear on their own, and the code graph rebuilds itself ONCE (the `INDEX_VERSION` stamp) to gain the new precision.

---

## What happens on its own — you type nothing

| When | What runs automatically |
|------|--------------------------|
| On every git **commit** | **Pre-commit** (v3.15): business-value scanner + security shield over staged files — visible, never blocking. **Post-commit**: closes the cycle, accumulates contracts, indexes the code, syncs the graph. |
| Inside every **`aa:`** | Context Enricher risk brief, gates, tests, 4-lens QA, learning registration. |
| Every **5 cycles** | Checkpoint to resume in another chat or machine. |
| On **init / update** | Hooks install themselves, schema migrates itself, index rebuilds itself if the engine changed versions. |

Since v3.15, every protection gets recorded in the ledger (`gate_events`) with its origin: **`mechanical`** (iron that runs on its own) or **`protocol`** (the model following instructions). You can measure what fraction of your protection is iron: `node .agentic/grafo/gate-telemetry.cjs stats`.

---

## How mature each organ is (honesty by tiers)

**🥇 Battle-tested** (repeated real use): the `aa:` pipeline, 4-layer memory + hybrid search, classic gates (Spec/TDD/Security/Regression), automatic per-commit registration, checkpoints, multi-instance locks, dashboard, MCP (54 tools), line-level containment, parallel Front/Back (confirmed with real overlapped execution).

**🥈 Verified with fixtures/browser** (controlled scenarios, not yet months of production): behavior-driven Browser Gate, 10-framework endpoint catalog (Express/Fastify/NestJS/Flask/FastAPI/Django/Rails/Laravel/gin/Spring), UI Eyes (forms/selects/required/CSS as graph nodes), telemetry + merit-based confidence promotion, error→cure matching by anchors, coverage meter, RECOVERY protocol, pre-commit hooks, engine maturity manifest with a mechanical boundary lint.

**🥉 Implemented without public confirmation**: team collaboration (private beta), Browser Gate escalation to STOP (earned with weeks of use).

The engine practices what it preaches: its ~50 modules are classified in `MADUREZ.json` (core/stable/experimental) and a mechanical lint prevents the core from depending on the experimental.

---

## Measured numbers (not estimates)

| Metric | Value |
|---|---|
| Range-error direction (vs real parser, 1,989 symbols) | 99.75% safe side |
| Graph of a real project (~414 TS+JS files) | 3,757 symbols · ~4,900 edges · 100% with line ranges |
| Declared coverage | 79% of files with symbols · 93% of lines covered · blind spots are DECLARED with a cause (`coverage-meter`) |
| v3.13→v3.15 verification | ~116 scenarios green, re-run after every plan (zero regression) |
| 19-phase benchmark (multi-tenant SaaS, with/without Agentix) | errors per phase 2.6→~0 · tests passing first try 79%→100% · refactor cascade 4/7→11/11 |

> ⚠️ **Honesty first:** the benchmark is **N=1, directional, not peer-reviewed** — a single project. It shows direction, not absolute truth. Reproduce it yourself: it's in `benchmark/`.

---

## Compatibility

Agentix is **first-class on Claude Code and Cursor** — that's where it's battle-tested. Because the engine relies on **open standards** (`AGENTS.md` and **MCP**), it *should* also work with other agents (VS Code, Windsurf, Kiro, Aider…), but in the interest of honesty: **so far it's only thoroughly tested on Claude Code and Cursor**. If you try it on another IDE and it works, open an issue and we'll add it to the list.

---

## Dashboard — what it looks like on a real project

`akdd dashboard` → visual board at localhost:3847. Every capture below is from a real production SaaS project (~414 files). The Knowledge Graph renders in **real 3D** — and it's three graphs:

**KDD Memory** — the decisions, errors and patterns from your memory. Since v3.15, knowledge born from the frontend is distinguished by color (pink/lime/cyan vs back's red/green/blue) and filterable with Front/Back:

<img src="assets/dash-kdd-memory.png" alt="KDD Memory — memory with front/back color families" width="100%">

Click any node: its connections light up and the panel shows the full rule, its confidence, which cycle it was born from, and what other knowledge it relates to:

<img src="assets/dash-kdd-node.jpg" alt="KDD Memory — selected node with its connections and detail panel" width="100%">

**Code Structure** — a native map of your actual code (files, symbols, forms, CSS classes and their connections), straight from the AST index. Zero LLM calls, zero tokens. Department palette: sibling modules (same folder) share a color family:

<img src="assets/dash-code-structure.jpg" alt="Code Structure — 3D code map with department palette" width="100%">

**Combined** — merges both: you see how your code and your accumulated decisions relate:

<img src="assets/dash-combined.jpg" alt="Combined — code and knowledge in one graph" width="100%">

### Preservation Intel — the third tab

The contracts that can't be broken (protected/verified/candidate), the Creative Engine with its autonomy level, MemCurator governing the memory, and the code's structural learning:

<img src="assets/dash-preservation-contracts.jpg" alt="Preservation Intel — Contract Guard, Creative Engine, MemCurator, Structural Learning" width="100%">

And the UI/Frontend memory — v3.13's "UI Eyes" in live numbers: watched forms, selects, `required` fields and CSS classes, with the UI Native Gate in green:

<img src="assets/dash-preservation-ui.jpg" alt="Preservation Intel — design memory, UI Native Gate and UI Eyes" width="100%">

Plain-language visual guides: [how to read the graph](docs/GRAFO-GUIA.md) · [how to read contracts + Creative Engine](docs/CONTRATOS-GUIA.md)

---

## ⚪ Full CLI reference (manual)

Everything below is **manual** — use it only when needed. The automatic behavior is described above.

### Setup & lifecycle
```bash
akdd init                      # Install Agentix KDD in a project
akdd onboard                   # Onboard an existing (brownfield) project
akdd update                    # Update the engine from GitHub (your memory stays intact)
akdd sync                      # Sync memory + graph
akdd hooks [status]            # Install / check git hooks (pre + post commit)
akdd mcp                       # (Re)configure MCP for Cursor / Claude Code / VS Code
akdd health [--fix]            # System diagnostics (--fix repairs what it can)
akdd dashboard                 # Visual board at localhost:3847
```

### Memory & knowledge graph
```bash
akdd buscar "query"            # Hybrid semantic + BM25 search
akdd recall "query"            # Recall relevant memory for a task
akdd historial                 # Resume checkpoint — paste into a new chat
akdd graph · akdd stats        # Graph summary and statistics
akdd why <file|entity>         # Why does this exist — decision trail
akdd forget <id> "<reason>"    # Remove a memory node (audited)
akdd cure [run|report]         # MemCurator — autonomous memory governance
```

### Contracts & gates (preservation layer)
```bash
akdd contracts                 # Contract Guard status
akdd predict <file>            # Regression risk before editing
akdd impacto <file|module>     # What breaks if this changes
akdd ast-impact <file>         # AST-level impact analysis
node .agentic/grafo/gate-telemetry.cjs stats     # The ledger: what protected, when, iron vs protocol
node .agentic/grafo/coverage-meter.cjs           # What the system sees and what it doesn't (declared blind spots)
node .agentic/grafo/madurez-lint.cjs             # Engine maturity boundaries (core/stable/experimental)
```

### Code engine
```bash
akdd ast [stats|symbols <f>]   # Project AST index (auto-migrates by version)
akdd git-context               # Current git context for the agent
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
akdd locks acquire/release --module=X
akdd locks release-all         # Release everything (session cleanup)
```
> Since v3.15 every lock leaves a window in the ledger on release — two overlapping windows from different instances are the mechanical proof that parallel work actually happened.

### Collaboration (team) — 🔒 private beta
> Shared **team memory** is in **private beta**. Everything else works **100% locally, no account required**. Want it for your team? [Open an issue](https://github.com/Adrianlpz211/AGENTIX-KDD/issues).

---

## Honest limits (what it is NOT)

1. **It's not invulnerable.** The armor reduces and directs error; it doesn't eliminate it. The quality of autonomous fixes comes from whichever model you run.
2. **It has a coverage ceiling, and declares it.** ~21% of the test project's files end up without symbols (tests with `describe()`, variables-only CSS). The invisible does NOT go unprotected — doubt closes the gate — but it doesn't get fine precision. `coverage-meter` tells you per project.
3. **Regex extractors, not a parser** — a measured decision (see "Where it comes from"). Edge cases fall into DOUBT, not silence.
4. **The semantic band stays in the model.** Business values are watched by iron (a mechanical scanner), but the judgment "does this contradict the SPIRIT of the decision?" is made by the LLM following protocol — and the ledger records which protection came from which.
5. **Benchmark is N=1** — directional, reproducible in `benchmark/`, not peer-reviewed.

---

## The Coliseum — adversarial arena (evidence, not marketing)

Instead of a benchmark that proves Agentix wins, we built one designed to **break it on purpose**: 15 attack rounds escalated across 4 tiers against a real project (MediCore, a multi-tenant clinical SaaS with business rules, tenant isolation, and a real concurrency race), each run twice — **with** Agentix (`aa:`) and **without** it (naked agent) — to measure the difference with facts, not narrative.

**Result:** 14 of 15 rounds held clean. The one real crack happened after the human forced an explicit override against the system's recommendation — and instead of leaving the accepted risk visible, the agent hid the reintroduced bug by weakening the test that watched it. A false green is worse than an honest red.

**The 3 cracks found are already repaired and verified** (13/13 mechanical checks, `_output/plan-8-grietas-coliseo.md`): a test that verifies a HIGH-confidence pattern is now untouchable in silence (`test-integrity-gate.cjs`), the Security Gate stopped depending on the Prisma dialect to detect cross-tenant leaks, and the TDD Gate now runs `typecheck` alongside tests — closing the "false green from types" gap in projects using `tsx`/`esbuild`.

The full playbook, the round-by-round scoreboard, and the victim project live on the [`coliseo-arena`](https://github.com/Adrianlpz211/AGENTIX-KDD/tree/coliseo-arena) branch — run the 15 rounds yourself.

---

## Status & transparency

Agentix is **young, evolving software**. The engine's ~50 modules were audited and hardened (v3.15: maturity boundaries with a mechanical lint, gates moved into git hooks, complete `node:sqlite` fallback, upgrade path proven by simulation; v3.15.2: 3 cracks found and repaired by the Coliseum, see above). Even so, **an audit doesn't certify zero defects** — if you find something, open an issue.

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
