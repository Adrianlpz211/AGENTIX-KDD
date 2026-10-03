# AGENTIX KDD

**Persistent knowledge, proportional effort and preservation for AI development.** Agentix helps Cursor and Claude Code work with relevant memory, contracts, tests and execution evidence. Use one agent or coordinate a director and builder through TEAMS.

[Español — instalación y guía completa](README.es.md) · [Adversarial sandbox](sandbox/README.md) · [Canonical agent instructions](AGENTS.md)

## Core capabilities

| Capability | Purpose |
|---|---|
| KDD memory | Retrieve relevant patterns, errors, decisions and causal relationships across sessions. |
| Effort routing | LOW/MEDIUM/HIGH policies based on difficulty and risk; bounded context, tool calls and repairs. |
| Preservation | Backend contracts, frontend scenarios, protected files and impact analysis. |
| TEAMS | Plans, sprints, dependencies, acknowledgements, leases, fencing and human decision queues. |
| Restore points | Scoped snapshots, previews, current-state checks and conditional automatic rollback. |
| Dashboard | KDD, combined and code structure graphs, evidence, metrics, logs, table view and guided tour. |
| Verification | PASS/FAIL/SKIP/UNVERIFIED/ERROR states, execution artifacts and telemetry. |

Controls require compatible hosts and meaningful coverage. Agentix does not promise universal correctness or a fixed token-saving percentage. Implemented, connected and verified are different states.

## Install

Git and Node.js are required. The package declares Node >=18; validate your selected runtime. This review used Node 24. Browser features need a compatible browser transport.

```sh
npm install -g agentic-kdd
cd your-project
akdd init
```

Init is interactive and configures framework files and MCP. Review backups and changes to existing instructions. Open the project in Cursor or Claude Code:

```text
aa: configurar
aa: fix the form validation error
```

For this local checkout, which can differ from the published npm package:

```sh
npm install
node bin/akdd.js --version
node bin/akdd.js health
```

Chat prefixes are agent instructions, not shell commands. The agent must actually execute the required checks; reading instructions is not proof.

## Commands

```sh
akdd health
akdd contracts
akdd contracts blast src/payment.js
akdd effort decide "fix a label" --paths=src/labels.js --type=text --json
akdd decide src/payment.js
akdd dashboard
akdd ast
akdd historial
akdd report
akdd mcp status
```

Chat: `aa:` development; `aa: --dry-run` proposed changes; `aa: sprint`; `aa: aprende`; `ag: review <file>`; `audit: seguridad`. Small high-risk changes still require risk controls.

## TEAMS

Default roles: Claude Code director and Cursor builder. Open both sessions on the same project and follow their role instructions. Native MD transport exchanges work and results; registering sessions alone is not a successful handshake.

```sh
akdd teams init --aprobar-migracion
akdd teams plan plan.json
akdd teams run
akdd teams status
akdd teams pending
akdd teams goal
```

Chat: `teams: activar`, `teams: plan`, `teams: ejecutar`, `teams: estado`, `teams: pendientes`, `teams: pausa`, `teams: continuar`, `teams: desactivar`.

A plan has objective and sprints containing tasks with id, objective, acceptance, allowed_files, depends_on, risk and change_type. Initializing tables in an existing project requires migration authorization. The builder submits; the director/controller verifies. Run performs a scheduler pass; it does not independently launch two models or prove every gate. Watchers cannot awaken every stopped host. Budget exhaustion requires a checkpoint, not a DONE claim.

Task/dependency stops should allow safe independent work to continue. Global stops block the plan. Business decisions remain human decisions and belong in the final report.

## Restoration and dashboard

```sh
akdd restore list
akdd restore create --label="before change" --files=src/payment.js
akdd restore show <id>
akdd restore preview <id>
```

Review preview before applying; provide the current hash and required confirmation. Restore is scoped, not a backup of the entire machine or external services. Automatic rollback requires eligibility and a reproducible failure without uncompensated external effects.

The dashboard retains its graph interfaces. Check preservation evidence, metrics and logs; KDD has a **☰ Tabla** alternative. Guided tours use the dashboard tour service. Browser verification must remain pending when actual browser evidence is absent.

## Optional host hooks and WhatsApp

```sh
akdd host-hooks status --host=cursor
akdd host-hooks install --host=cursor
akdd host-hooks uninstall --host=cursor
```

Validate hook compatibility inside the IDE before installing. Incorrect transport can block tools; uninstalling may require a complete process restart and a new session. Git hooks and IDE hooks are separate integrations.

WhatsApp chat commands: `ws: activar`, then contact selection and test confirmation; `ws: desactivar`. Requires an authorized agent with compatible browser control and an active WhatsApp Web session, primarily Claude Code. Do not assume Cursor support or silently send messages.

## Upgrade 3.19 to 3.20 without losing knowledge

After 3.20 is published:

```sh
npm install -g agentic-kdd@3.20.0
cd your-project
akdd update
akdd health
```

Installing the CLI does not scan or update existing projects. Run update in each project. Init and update now use the engine bundled with the installed package; GitHub main is not the default installation source. Memory databases, memory Markdown, project configuration and business code are outside the replacement scope. Updates keep transactional journals, backups and recognized customizations.

To authorize the new schema in an older database, stop project agents and review backups first:

```sh
akdd update --migrate
akdd mcp status
```

Migration creates a consistent SQLite backup including WAL commits, runs in a transaction and checks integrity. Failure is reported as failure. On the first upgrade of a legacy engine without an ownership manifest, review customizations inside framework files: not every local change can be distinguished automatically from the original release.

`akdd update --rollback` rolls back framework files, not database migrations or external effects. Check schema compatibility before returning to an older engine. `--ref=<tag-or-SHA>` and `--from=<archive.tar.gz>` select an explicit alternative source.

## What the MCP adds

Run `akdd mcp` to configure the local project server. MCP gives the model structured tools to recall memory, remember lessons, inspect impact and contracts, choose effort, and operate TEAMS and restore points. It uses the same engine and project database.

For example, a model can retrieve known errors before changing a module and record a tested fix afterward, reducing repeated context reconstruction. MCP is a tool bridge, not another model or a cloud memory service. Its value depends on the agent actually using those tools; it cannot keep every IDE session running indefinitely.

Prefer per-project configuration to keep project memory isolated. Reload the IDE afterward. Invalid existing MCP JSON is preserved and reported.

## Release verification

From the repository checkout:

```sh
npm ci
npm run release:check
```

The release check runs the full suite, builds the npm tarball, rejects private runtime data, and upgrades the actual published 3.19 package in an isolated consumer with a real SQLite database. It checks unchanged data, rollback, migration, and MCP requests over stdio. Logs, verification JSON and the tested tarball are stored in `_output/release-3.20.0/`.

This verifies that scope; it does not certify live concurrent model hosts or WhatsApp. See [publication instructions](PUBLICACION-3.20.md). Local preparation does not mean 3.20 is already published.

MIT · [Repository](https://github.com/Adrianlpz211/AGENTIX-KDD)
