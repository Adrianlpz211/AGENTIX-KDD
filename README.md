# Agentic KDD v3.6

> Autonomous development pipeline with persistent knowledge memory. Forces TDD, blocks spec violations before build, and eliminates repeated errors across sessions.

[![npm](https://img.shields.io/npm/v/agentic-kdd)](https://www.npmjs.com/package/agentic-kdd)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What it is

Agentic KDD is a framework that runs inside **Cursor** and **Claude Code**. It turns your AI assistant into a disciplined development pipeline with:

- **KDD Memory** — errors, patterns and decisions persist across sessions. The agent reads them before every task.
- **TDD Gate** — deterministic self-healing loop. Forces tests to pass before continuing. Not a suggestion — it's code.
- **Spec Gate** — blocks changes that contradict documented business rules before writing a single line.
- **Security Gate** — detects JWT bypass, cross-tenant access and debug flags before build.
- **Regression Guard** — protects healthy behaviors across cascading file changes.
- **Contract Guard** — tracks passing test patterns and escalates them to protected contracts over time.

---

## Benchmark results (19 phases, Node.js + Python stacks)

| Metric | Without | With | Change |
|---|---|---|---|
| Errors per phase | 2.6 | 0.0 | ✅ 100% |
| Repeated errors | 3 | 0 | ✅ 100% |
| Tests passing first try | 79% | 100% | ✅ +27pp |
| Spec drift detections | 3 | 6 | ✅ +100% |
| Cascade files correct | 4 | 11 | ✅ +175% |
| Security issues detected | 1 | 2 | ✅ +100% |
| Autonomous fixes | 4 | 7 | ✅ +75% |

> N=1 project per benchmark. Treat as directional, not definitive. Reproducible benchmark repo in progress.

---

## Installation

```bash
npm install -g agentic-kdd
```

Requires Node.js 18+.

---

## Setup

```bash
cd your-project
akdd init
```

That's it. Agentic KDD detects your stack (Node.js, Python, PHP), installs `.agentic/`, injects the `dev:kdd` script, and configures the pipeline.

For brownfield projects (existing codebase):

```bash
akdd onboard
```

Scans your project, maps the stack, suggests a first small task, and pre-populates memory with what it finds.

---

## Usage

Every task goes through `aa:`:

```
aa: implement the clients module with CRUD and tenant isolation
```

The pipeline runs automatically:

```
① Analyst     — reads memory, recalls patterns and past errors
② Spec Gate   — blocks if prompt contradicts HIGH-confidence rules
③ Security Gate — checks CRITICAL/SENSITIVE files before build
④ Regression Check — verifies changeset won't break protected behaviors
⑤ Build       — implementation
⑥ TDD Gate    — runs tests, self-heals up to 3 iterations
⑦ QA          — validates against spec and memory
⑧ Preservation Gate — verifies contracts
⑨ Regression Register — snapshots healthy behaviors
⑩ Memory      — writes errors, patterns and decisions
⑪ Creative    — detects improvement opportunities
```

---

## CLI commands

```bash
akdd init              # Install in a new project
akdd onboard           # Analyze an existing project (brownfield)
akdd update            # Pull latest from GitHub
akdd contracts         # Contract Guard status
akdd contracts list    # List all contracts
akdd graph             # Knowledge graph state
akdd metrics           # Project metrics
akdd health            # System health check
akdd analyze           # Cross-artifact consistency check
```

---

## What's in the repo

```
.agentic/
├── agentes/           # Role instructions (Orchestrator, Analyst, Back, Front, QA, Memory)
├── grafo/             # Gate modules (tdd-gate, spec-gate, security-gate, regression-guard, contract-guard)
├── memoria/           # KDD memory files (errors, patterns, decisions, work)
├── config.md          # Project configuration
└── PLAN.md            # Active task

CLAUDE.md              # Pipeline rules for Claude Code
.cursor/rules/         # Pipeline rules for Cursor
```

---

## How it compares

| | OpenSpec | Spec-Kit | Agentic KDD |
|---|---|---|---|
| Spec violation gate | ❌ | ❌ | ✅ blocks before build |
| Security gate | ❌ | ❌ | ✅ blocks before build |
| Error memory (KDD) | ❌ | ❌ | ✅ persists across sessions |
| TDD self-healing loop | ❌ | Partial | ✅ deterministic, 3 iterations |
| Regression protection | ❌ | ❌ | ✅ cascade-tested |
| Contract escalation | ❌ | ❌ | ✅ candidate → verified → protected |
| Python support | ❌ | ✅ | ✅ pytest + FastAPI |
| Brownfield onboarding | ✅ | Partial | ✅ akdd onboard |
| npm install | ✅ | ❌ | ✅ |
| MCP tools | 25+ | — | 59 |

---

## Stack support

- **Node.js** — Next.js, Express, Fastify, NestJS + Jest/Vitest
- **Python** — FastAPI, Django, Flask + pytest
- **PHP** — Laravel + PHPUnit

---

## License

MIT — Adrián López ([@Adrianlpz211](https://github.com/Adrianlpz211))
