# Changelog — Agentic KDD

## [3.8.0] — 2026-06-30

### Onboarding automático de proyectos existentes + AST automático
- **`akdd init` en proyecto existente** — al elegir "ya tiene código", ahora corre
  automáticamente `onboard` (detecta stack/módulos/patrones), indexa el código (`ast`)
  y sincroniza el grafo (`sync`). El dashboard arranca poblado sin pasos manuales.
  Todo best-effort: si algún paso falla, `init` no se rompe.
- **AST automático en el cierre de ciclo** — `post-cycle.cjs` ahora indexa el AST como
  paso final. Es incremental (ast-indexer cachea por `content_hash`), así que tras cada
  commit solo re-parsea los archivos que cambiaron. Mantiene el grafo de símbolos fresco
  sin depender de que el agente lo corra, en segundo plano y a 0 tokens.

## [3.7.0] — 2026-06-30

### Registro de contratos automático (sin intervención del agente)
- **Hook git post-commit** — nuevo `.agentic/grafo/git-hooks/post-commit` que dispara
  `post-cycle.cjs` en segundo plano tras cada commit. Nunca bloquea el commit (exit 0),
  con debounce de 90s y derivación de área desde `src/`.
- **Instalador `install-hooks.cjs`** — idempotente, no-op sin git, y NO sobrescribe hooks
  ajenos (marcador). Auto-instalado por `akdd init`, `akdd update` y `grafo.cjs sync`
  (esta vía propaga el hook a proyectos ya instalados en su próximo `akdd update`).
- **`post-cycle.cjs --hook`** — modo seguro: no ejecuta `npm install` y no falla si falta
  `memoria.db` (sale 0). El uso manual del comando queda idéntico.
- **Nuevo comando `akdd hooks [install|uninstall|status]`**.
- **Fix:** `src/init.js` apuntaba al nombre de repo viejo (`Agentic-KDD`); ahora `AGENTIX-KDD`.

## [3.6.0] — 2026-06-28

### Auditoría completa + endurecimiento del motor
- **30+ bugs reparados** tras auditoría de los 48 archivos del motor (8 sesiones):
  5 críticos (db.prepare sobre el adapter, bin roto, dispatcher MCP, inyección),
  14 altos (Spec Gate inerte, TDD Gate con PASS falso, métricas en 0, etc.) y
  ~10 medios/bajos.
- **Búsqueda vectorial real** — `indexarPendientes` ahora embebe y persiste los
  vectores; `akdd buscar` rankea por similitud coseno real (antes degradaba a texto).
- **Fuente única del motor** — consolidado todo en `.agentic/grafo/`; eliminada la
  copia muerta `src/grafo.cjs` y el directorio duplicado `grafo/`.
- **Higiene de publicación** — `.npmignore` (no se filtra `memoria.db`) + hook
  `prepublishOnly` que bloquea publicaciones con el motor viejo o versión descuadrada.
- **Parser de memoria** — `parsearEntradas` ya no crea nodos fantasma desde headers
  ni comentarios de plantilla.

## [2.1.0] — 2026-06-18

### Nuevas funcionalidades
- **Observabilidad completa** — tabla `ciclos` y `fases` en SQLite para tracing por ciclo
- **Métricas de agente** — Goal Attainment Rate, Autonomy Ratio, Handoff Integrity, Drift Index, Guardrail Violations
- **Dashboard: panel Metrics** — visualización de KPIs en tiempo real desde SQLite
- **Dashboard: panel Timeline** — historial cronológico de decisiones + specs auto-generadas
- **Dashboard: panel Onboarding** — barra de progreso de configuración del proyecto
- **Búsqueda semántica** — embeddings opcionales via ANTHROPIC_API_KEY (fallback a SQLite)
- **Índices compuestos SQLite** — queries del Analista hasta 10x más rápidas
- **Specs automáticas** — `.agentic/specs/[modulo].md` generadas al terminar cada módulo
- **Híbrido Kiro-style** — el Orquestador lee specs como fuente de intención antes de planificar
- **Validación de vigencia** — patrones sin usar 30+ ciclos se marcan automáticamente
- **ag:test y ag:review automáticos** — corren dentro de `aa:` sin intervención del usuario
- **Gate de tests** — el ciclo no avanza si los tests fallan
- **Log de observabilidad** — `_output/log-YYYY-MM.md` escrito automáticamente

### CLI
- **akdd init inteligente** — detecta stack automáticamente y genera config.md completo
- **Plantillas por stack** — Next.js, Laravel, Node.js, React, PHP, Python
- **dashboard.cjs copiado en init** — listo para correr desde el primer momento

### Mejoras
- `grafo.cjs` — nuevo comando `metricas`, `ciclo`, `semantico`
- `schema.sql` — campo `ultima_validacion`, tablas `ciclos` y `fases`
- Migración automática de DBs existentes (sin perder datos)
- Todos los archivos en `.cjs` — compatibilidad con proyectos ESM

### Correcciones
- Fixed: `parseEntries` eliminado por duplicación de funciones en dashboard
- Fixed: `clientWidth=0` en grafo de módulos (dimensiones fijas)
- Fixed: emojis en PDF del manual (reemplazados por texto)

---

## [2.0.8] — 2026-06-17

### Nuevas funcionalidades
- **Subagentes Pro** — `ag: refactor`, `ag: test`, `ag: doc`, `ag: review`
- **Departamento QA** — `audit:` con 7 subagentes independientes
- **Dashboard v4** — Knowledge Graph D3 + Project Docs
- **Nodos divinos** ⚡ y **conexiones sorprendentes** ✨
- **Graph Report** — equivalente al GRAPH_REPORT.md de Graphify
- **`.cjs` universal** — compatible con proyectos ESM y CJS

---

## [2.0.6] — 2026-06-15

### Nuevas funcionalidades
- Grafo SQLite con detección automática de entidades
- `akdd graph` — estadísticas del grafo en consola
- `akdd dashboard` — abre el dashboard visual

---

## [2.0.0] — 2026-06-10

### Primera versión pública
- Pipeline autónomo `aa:`
- Context Guard
- Arquitectura de lectura en capas
- Señales de confianza BAJA/MEDIA/ALTA
- Compresión periódica de memoria
- QA independiente
- Protocolo STOP

## [2.2.0] — 2026-06-22

### Nuevas funcionalidades

#### 1. Embeddings Locales (all-MiniLM-L6-v2)
- Motor de búsqueda semántica 100% offline — sin API key
- `@xenova/transformers` — modelo ONNX quantizado, ~23MB
- Búsqueda híbrida RRF (Reciprocal Rank Fusion): vectorial + keyword
- Indexación automática en `akdd sync` — batch de 30 nodos por sync
- Mejora recuperación de memoria de ~60% → ~90% de relevancia
- `akdd embed-status` — verificar estado
- `akdd embed-install` — instalar one-shot

#### 2. Git Context
- Análisis automático del diff en cada `akdd sync`
- Cruza archivos modificados contra memoria episódica → alertas de riesgo
- Niveles: 🔴 ALTO | 🟡 MEDIO | 🟢 BAJO por archivo
- Carga contexto en `working_memory` — el Analista lo lee antes de planificar
- Hook post-checkout automático: `akdd git-context --install-hook`
- `akdd git-context` — análisis manual en cualquier momento

#### 3. Motor de Predicción
- Minería de patrones causales sobre memoria episódica acumulada
- Detecta archivos de alto riesgo, co-ocurrencias problemáticas, precondiciones implícitas
- "Antes de tocar X: correr migraciones (80% éxito cuando se hace)"
- Se activa en Context Guard — ANTES de ejecutar cualquier `aa:`
- Nivel ALTO → interrumpe y muestra advertencia
- Nivel MEDIO → nota en el plan, no interrumpe
- `akdd predict` — ver todos los patrones detectados
- `node grafo.cjs predecir "[tarea]" "[archivos-json]" "[modulo]"` — para agentes

#### 4. CI/CD Integration
- GitHub Actions workflow auto-generado: `akdd ci-install`
- Registra fallos de tests en memoria episódica automáticamente
- Compatible con: GitHub Actions, GitLab CI, Bitbucket, Jenkins
- `akdd ci-status` — últimos 10 reportes CI en memoria
- `akdd ci-report [--success] [--output file]` — llamado por el workflow

### Arquitectura
- `grafo.cjs` — 4 módulos nuevos integrados via lazy loading (sin overhead en arranque normal)
- `schema.sql` — 3 tablas nuevas: `git_context_log`, `cicd_reports`, `prediction_log`
- Migration automática: `ALTER TABLE episodios ADD COLUMN embedding TEXT`
- Todos los módulos: fallback graceful si no están instalados

### CLI
- `akdd sync` → ahora es `akdd sync-v2` (incluye git-context + embeddings)
- `akdd git-context` → análisis de riesgo del working tree
- `akdd predict` → estadísticas del motor de predicción
- `akdd embed-status` / `akdd embed-install` → gestión de embeddings
- `akdd ci-install` / `akdd ci-status` / `akdd ci-report` → CI/CD

### Autonomía
- Antes: L2-L3 (~35-45%)
- Ahora: L3 (~55-65%) — prevención activa + contexto git automático
