# Agentic KDD — Configuración del proyecto
CONFIGURADO: NO
VERSION: 2.0

---
<!-- El Setup completa esto. No editar manualmente hasta que Setup termine. -->

## Proyecto
Nombre: —
Descripción: —
Tipo: NUEVO | EXISTENTE

## Stack
```yaml
frontend:
  framework: —
  ui: —
  language: —

backend:
  runtime: —
  framework: —
  base_datos: —
  orm: —

devops:
  package_manager: —

commands:
  install: —
  dev: —
  build: —
  test: —
  lint: —
```

## Arquitectura
_El Setup mapea esto._

## Módulos
### Implementados
_Ninguno aún._

### Pendientes
_Ninguno aún._

## Archivos compartidos críticos
_El Setup los detecta._

## Reglas del proyecto
_Se definen en Setup o se aprenden durante el desarrollo._

## Sinónimos del proyecto
<!-- El agente Memoria añade aquí equivalencias de términos -->
<!-- Formato: - "término en instrucción" = "término en código" -->
_Sin sinónimos registrados aún._

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
