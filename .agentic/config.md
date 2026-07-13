# Agentic KDD — Configuración del proyecto
CONFIGURADO: SI
VERSION: 3.11.7

---
<!-- Configuración autodetectada por aa: configurar -->

## Proyecto
Nombre: agentic-kdd
Descripción: Autonomous development pipeline — aa: · ag: · audit: · AST graph · Harness · Specs · Impact analysis · Decision trail · Metrics · MCP server
Tipo: EXISTENTE (npm package CLI)

## Stack
```yaml
frontend:
  framework: —
  ui: —
  language: JavaScript

backend:
  runtime: Node.js
  framework: —
  base_datos: SQLite (better-sqlite3 / sql.js)
  orm: —

devops:
  package_manager: npm

commands:
  install: npm install
  dev: —
  build: —
  test: node bin/akdd.js --version
  lint: —
```

## Arquitectura
Tipo: CLI tool + MCP server + Dashboard
Entrypoint: bin/akdd.js
Motor: .agentic/grafo/ (47 módulos CJS)
Memoria: .agentic/memoria/ (SQLite + markdown)
Agentes: .agentic/agentes/ (10 roles + harness)

## Módulos
### Implementados
- bin/akdd.js — CLI principal (471 líneas)
- src/init.js — Inicialización interactiva
- src/update.js — Actualización de agentes
- src/onboard.js — Análisis de proyecto existente
- src/graph.js — Sincronización de grafo
- src/dashboard.js — Dashboard visual
- src/analyze.js — Análisis de consistencia
- src/mcp-setup.js — Configuración MCP
- .agentic/grafo/ — 47 módulos del motor de conocimiento
- .agentic/agentes/ — 10 agentes de pipeline

### Pendientes
_Ninguno detectado_

## Archivos compartidos críticos
- package.json — Dependencias y scripts
- bin/akdd.js — CLI principal
- .agentic/grafo/grafo.cjs — Motor SQLite core
- .agentic/grafo/kdd-memory.cjs — Sistema de memoria
- .agentic/grafo/contract-guard.cjs — Guardia de contratos

## Reglas del proyecto
- Usar CommonJS (.cjs/.js) — no ESM
- SQLite para persistencia (mejor rendimiento)
- MCP server para integración con IDEs
- Pipeline de 9 agentes en secuencia
- **Trial period: 7 días** — Cambiado de 14 a 7 el 2026-07-12 (test A/B de conversión), confirmado explícitamente por el owner en chat. No cambia de nuevo sin aprobación explícita.

## Sinónimos del proyecto
<!-- El agente Memoria añade aquí equivalencias de términos -->
<!-- Formato: - "término en instrucción" = "término en código" -->
- "memory" = "memoria"
- "graph" = "grafo"
- "knowledge" = "conocimiento"
- "specs" = "specs"
- "pipeline" = "pipeline"

## v3.1 — Configuración extendida

### AST Indexer
```yaml
ast_enabled: false       # true para activar indexación AST automática
ast_languages: [js, ts]  # lenguajes a indexar: js, ts, python, go, rust, java, cpp, php, ruby
```

### Embeddings
```yaml
embeddings_model: miniLM  # miniLM (default, 23MB) | jina-code (opt-in, 500MB)
# Para activar jina-code:
#   1. node .agentic/grafo/embeddings.cjs install-jina
#   2. Cambiar a: embeddings_model: jina-code
```

### Modo colaborativo
```yaml
collab_mode: disabled  # disabled | turso
# Para activar:
#   1. npm install @libsql/client
#   2. Configurar TURSO_URL y TURSO_TOKEN en .env
#   3. node .agentic/grafo/collab-manager.cjs enable
```

### Knowledge Base
```yaml
knowledge_dirs: [docs/adr, docs/gotchas, docs/conventions]
# Directorios donde busca ADRs, gotchas y convenciones
```
