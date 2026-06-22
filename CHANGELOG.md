# Changelog — Agentic KDD

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
