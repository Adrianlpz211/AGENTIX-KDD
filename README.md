<div align="center">

<img src="assets/phalanx-logo.svg" alt="Phalanx KDD" width="600">

### The armor for your AI coder.

<p>
<img src="https://img.shields.io/badge/version-3.6.0-3FE2E8?style=for-the-badge&labelColor=0A0E14" alt="version"/>
<img src="https://img.shields.io/badge/license-MIT-D9A33C?style=for-the-badge&labelColor=0A0E14" alt="license"/>
<img src="https://img.shields.io/badge/Claude_Code_·_Cursor-ready-8A97A6?style=for-the-badge&labelColor=0A0E14" alt="compat"/>
</p>

**A development team of one.**

English · [Español](README.es.md)

</div>

---

## What it is

**Phalanx KDD** isn't another AI that codes for you. It's the **armor** you put on the AI you already use — Claude Code or Cursor — so it **remembers, doesn't break what was working, and doesn't contradict itself**.

It lives **inside your project**: it reads your code, saves every decision and every error to a persistent memory, and uses all of it to make the next task safer than the last. You keep using your editor; Phalanx shields it from underneath.

> *KDD = Knowledge-Driven Development — development guided by the project's own accumulated knowledge. (npm package: `agentic-kdd`.)*

---

## The problem it solves

You open Cursor or Claude Code. You explain your project *again*. The AI starts from zero *again*. It breaks something that was working *again*. It changes a business rule without remembering why it was set that way.

You're not coding — you're babysitting the context by hand. **Phalanx takes that over.**

---

## The three pieces of the armor

| | Piece | What it does |
|---|-------|--------------|
| ⚓ | **Anchor** — memory | Remembers decisions, rules and errors across sessions. Real semantic search (local embeddings) surfaces what's relevant at the right moment. |
| 🔧 | **Lever** — verification | Before accepting a change, it **runs the tests and confirms nothing that worked got broken**. If something breaks, it says so — it never reports a false "green". |
| 🔨 | **Hammer** — autonomy | Finds and fixes problems on its own (security included) and reports back. You read the result. |

---

## How it works

Phalanx uses a **4-layer memory** (CoALA architecture) stored in **SQLite inside your project** — yours, no cloud, no subscription:

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

Done. Phalanx reads your project and configures itself. From there, every task starts with `aa:`.

---

## Commands

```bash
# Main pipeline
aa: [any task]             # autonomous cycle: analyze · build · test · learn
aa: sprint — [goal]        # chain several tasks; memory flows between them
aa: aprende                # absorb knowledge from work done outside the pipeline

# QA department (never touches code, audits only)
audit: auditar             # full audit
audit: seguridad           # secrets, auth, multi-tenant

# CLI
akdd update                # update the engine (your memory stays intact)
akdd sync                  # sync memory + graph
akdd buscar "query"        # semantic search across memory
akdd dashboard             # visual board at localhost:3847
akdd health                # system diagnostics
```

It also exposes **23 MCP tools** for compatible clients (Claude Code, Cursor, any stdio MCP client).

> The command vocabulary (`aa:`, `audit:`, `akdd buscar`…) is in Spanish — the task you write after `aa:` can be in any language.

---

## Benchmark results

Across a 19-phase run building a real multi-tenant SaaS (same Claude model in both modes), with vs. without Phalanx:

| Metric | Without | With |
|--------|---------|------|
| Errors per phase | 2.6 | ~0 |
| Phases with a repeated error | 3 | 0 |
| Tests passing first try | 79% | 100% |
| Refactor cascade correct | 4/7 | 11/11 |

> ⚠️ **Honesty first:** these are **N=1, directional, not peer-reviewed** — a single project. They show direction, not absolute truth. Reproduce the benchmark yourself in `benchmark/`.

---

## Status & transparency

Phalanx is **young, evolving software**. All 48 engine files were audited and **30+ bugs were fixed** (memory, gates, vector search, packaging). Even so, **an audit doesn't certify zero defects** — if you find something, open an issue.

What **does work today**: the `aa:` pipeline, persistent memory with real semantic search, the gates (Spec / Regression / TDD / Security), the dashboard with real metrics, the MCP server, and multi-instance coordination.

---

## License

MIT — use it, fork it, build on it.

<div align="center">

Made by [@Adrianlpz211](https://github.com/Adrianlpz211)

*If Phalanx saved you time → ⭐*

</div>
