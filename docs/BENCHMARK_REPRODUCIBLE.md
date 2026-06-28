# Agentic KDD — Reproducible Benchmark

This repo contains the exact projects and prompts used to benchmark Agentic KDD v3.6 against a stateless agent (same Claude model, no memory framework).

## Structure

```
benchmark-v1/          # Task Management API (12 phases, Node.js/TypeScript)
benchmark-v2/          # SaaS Billing Platform (16 phases, Node.js/TypeScript)
benchmark-nuclear/     # Same project, phases 17-19 (nuclear gates test)
benchmark-v3/          # Agency OS (8 phases, Python/FastAPI) ← NEW
phases/                # Prompt files for each phase
results/               # Raw metrics and analysis
```

## How to reproduce

### Prerequisites
- Node.js 18+
- Python 3.12+
- `npm install -g agentic-kdd`
- Cursor or Claude Code

### Run with Agentic KDD

```bash
# 1. Clone this repo
git clone https://github.com/Adrianlpz211/Agentic-KDD-Benchmark

# 2. Setup the project
cd benchmark-v3/agency-os
akdd init

# 3. Run each phase prompt from phases/agency-os/phase-XX.md
# Copy the prompt, paste into Cursor with aa: prefix
```

### Run without Agentic KDD (control group)

```bash
cd benchmark-v3/agency-os-control
# Same project, no .agentic/ directory
# Same prompts, no aa: prefix — just plain prompts
```

### Record metrics after each phase

```bash
cd benchmark-v3
py -3.13 metrics/record.py --phase 1 --mode with-agentic
py -3.13 metrics/record.py --phase 1 --mode without-agentic
```

### View results

```bash
py -3.13 metrics/compare.py
```

## Results (v3.6, 28/06/2026)

| Metric | Without | With | Change |
|---|---|---|---|
| Errors per phase | 2.6 | 0.0 | ✅ 100% |
| Repeated errors | 3 | 0 | ✅ 100% |
| Tests passing first try | 79% | 100% | ✅ +27pp |
| Spec violations detected | 3 | 6 | ✅ +100% |
| Cascade files correct | 4 | 11 | ✅ +175% |
| Security issues detected | 1 | 2 | ✅ +100% |

> Full raw data in `results/benchmark-v3-results.json`

## Notes

- Same Claude model (claude-sonnet-4-6) used in both modes
- Same prompts, same project structure
- N=1 per benchmark — treat as directional, not definitive
- Gates (Spec Gate, Security Gate, Regression Guard) are only active in the "with" condition
- "Without" condition: plain prompts to Claude Code without any Agentic KDD framework

## License

MIT
