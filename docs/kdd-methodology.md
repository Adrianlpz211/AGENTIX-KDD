# Knowledge-Driven Development (KDD)

## A methodology for AI-assisted software development

---

## Overview

**Knowledge-Driven Development (KDD)** is a software development methodology in which the accumulated knowledge of a project — errors encountered, patterns established, architectural decisions made — actively guides every development decision made by AI agents working on that project.

KDD is not a replacement for existing methodologies. It is a complementary layer that makes AI agents more effective by giving them persistent, project-specific context that improves with every development cycle.

---

## The problem KDD solves

AI coding assistants are stateless by default. Every session starts from zero. An agent that resolved a complex SQL Server error yesterday has no memory of it today. Patterns discovered in one module are unknown when working on the next. Architectural decisions made three sprints ago are invisible to the agent planning the current task.

The result: agents repeat mistakes, reinvent patterns, and make decisions inconsistent with the project's established direction.

KDD solves this with a **living knowledge base** that agents write to and read from as a core part of the development cycle.

---

## Core principles

### 1. Knowledge is a first-class artifact
Like tests in TDD or domain models in DDD, the knowledge base is a primary deliverable — not documentation added after the fact.

### 2. Agents write knowledge, not humans
The knowledge base is updated automatically by agents after each cycle. It does not depend on human discipline to stay current.

### 3. Knowledge guides before code is written
Every agent reads the knowledge base before planning or implementing. Patterns and error records inform decisions proactively, not reactively.

### 4. Quality over quantity
A knowledge base with 30 precise, actionable entries is more valuable than one with 300 entries of varying relevance. Outdated entries are replaced, not accumulated.

### 5. Knowledge is actionable
Every entry answers: what to do (or not do), why, and when. Not just what happened.

---

## The four layers of KDD

### Layer 1 — Working memory (`trabajo.md`)
What is happening right now.

```
Active task, current module, current phase, last updated,
project goal, recent task history (last 5)
```

This layer resets with each cycle and provides immediate context.

### Layer 2 — Error memory (`errores.md`)
What not to do — and why.

```
Error pattern, exact symptom, root cause,
solution applied, how to avoid it, when to apply the fix
```

Written by the Back agent when resolving errors after retries.
Read by the Analyst before planning anything similar.

### Layer 3 — Pattern memory (`patrones.md`)
Rules the project has established.

```
Pattern name, priority, scope (front/back/both),
the rule, the reason, a concrete example, exceptions
```

Written by the QA agent when discovering something that must always be applied.
Read by all agents before implementing anything in scope.

### Layer 4 — Decision memory (`decisiones.md`)
Why things are the way they are.

```
Decision, rationale, context, date, who decided
```

This is the layer that prevents inconsistency over time. When an agent understands not just what was decided but why, it can make coherent decisions in novel situations not covered by existing patterns.

---

## The KDD cycle

```
┌─────────────────────────────────────────────────────┐
│                    TASK RECEIVED                     │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│              READ KNOWLEDGE BASE                     │
│  trabajo.md → errores.md → patrones.md → decisiones │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│           PLAN WITH KNOWLEDGE CONTEXT                │
│  Apply relevant patterns · Avoid known errors       │
│  Respect established decisions                      │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│                   IMPLEMENT                          │
│  Front → Back (TDD) → QA (browser validation)       │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│              UPDATE KNOWLEDGE BASE                   │
│  New errors resolved → errores.md                   │
│  New patterns discovered → patrones.md              │
│  New decisions made → decisiones.md                 │
│  Task completed → trabajo.md                        │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│          KNOWLEDGE BASE IS SMARTER                  │
│          Next cycle starts with more context        │
└─────────────────────────────────────────────────────┘
```

---

## KDD vs other methodologies

| | TDD | BDD | DDD | SDD | **KDD** |
|---|---|---|---|---|---|
| Driven by | Tests | Behavior | Domain model | Specifications | **Accumulated knowledge** |
| Primary artifact | Test suite | Acceptance criteria | Domain model | Spec document | **Living knowledge base** |
| Written by | Developers | Business + Dev | Domain experts | Architects | **AI agents** |
| Read before coding | Tests | Scenarios | Domain model | Specs | **Knowledge base** |
| Improves over time | Manually | Manually | Manually | Manually | **Automatically** |
| Prevents | Regressions | Misalignment | Model drift | Spec gaps | **Repeated mistakes + inconsistency** |

KDD does not compete with TDD, BDD, DDD, or SDD. A project can — and should — use multiple methodologies. KDD adds the memory layer that makes AI agents effective across all of them.

---

## What KDD is not

**KDD is not a documentation system.**
Documentation is written for humans to read. The KDD knowledge base is written by agents for agents to read. The format is optimized for machine consumption — precise, structured, actionable.

**KDD is not a second brain.**
Tools like Obsidian or Notion are personal knowledge management systems. KDD is project-scoped, agent-maintained, and development-focused.

**KDD is not a log.**
Logs record what happened. KDD records what to do differently. An error entry is not "we got this error" — it's "if you see this, do that instead."

---

## Implementation

KDD is implemented in **Agentic KDD** — an autonomous development pipeline for Cursor and Claude Code.

→ [Get started](../README.md)

---

## License

MIT. KDD as a methodology concept is open and free to use, implement, and build upon.
