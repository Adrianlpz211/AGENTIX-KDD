# .agentic/conocimiento/ — Base de conocimiento del proyecto

Coloca aquí cualquier documentación del proyecto.
El Analista lee estos archivos antes de planificar cada tarea.
El Context Guard los usa para validar instrucciones.

## Qué poner aquí
- requirements.pdf / requirements.md
- api-spec.md
- business-rules.md
- design-system.md
- repomix-output.xml (para proyectos existentes)
- Cualquier Word, PDF o texto con contexto del proyecto

## Lo que NO poner aquí
- Archivos generados (builds, node_modules)
- Datos sensibles (credenciales, API keys)

---

# Conocimiento v3.1 — ADR/MADR, Gotchas y Convenciones

## Estructura de carpetas

```
docs/
├── adr/              ← Architecture Decision Records (ADR/MADR)
│   ├── ADR-001-usar-sqlite.md
│   ├── ADR-002-embeddings-offline.md
│   └── ...
├── gotchas/          ← Reglas operacionales y trampas conocidas
│   ├── no-borrar-relaciones-bi-temporal.md
│   └── ...
└── conventions/      ← Convenciones del proyecto
    └── naming-conventions.md

.agentic/conocimiento/templates/
├── ADR-template.md   ← Template MADR completo
└── gotcha-template.md ← Template para gotchas
```

## Crear un ADR nuevo

```bash
# 1. Copiar template
cp .agentic/conocimiento/templates/ADR-template.md docs/adr/ADR-NNN-titulo.md

# 2. Completar el frontmatter y secciones
# Los campos obligatorios del frontmatter son:
#   status, date, decision-makers, afecta (array de rutas)

# 3. Ingestar en el grafo de conocimiento
node .agentic/grafo/adr-ingestor.cjs ingest

# El agente ahora puede consultarlo:
node .agentic/grafo/adr-ingestor.cjs query [módulo]
```

## Crear un Gotcha nuevo

```bash
# 1. Copiar template
cp .agentic/conocimiento/templates/gotcha-template.md docs/gotchas/nombre-gotcha.md

# 2. Completar frontmatter (tipo, regla, severidad, afecta son OBLIGATORIOS)

# 3. Lint — verificar que el frontmatter es válido
node .agentic/grafo/knowledge-ingestor.cjs lint docs/gotchas

# 4. Ingestar
node .agentic/grafo/knowledge-ingestor.cjs ingest docs/gotchas
```

## Cómo el agente usa el conocimiento

El Analista (02-analista.md) consulta el knowledge base en cada ciclo:
```bash
node .agentic/grafo/adr-ingestor.cjs query [módulo]
node .agentic/grafo/knowledge-ingestor.cjs query [módulo]
```

### Reglas de aplicación automática

| Tipo | Status/Severidad | Cómo aplica el agente |
|------|-----------------|----------------------|
| ADR | accepted | No contradice la decisión |
| ADR | deprecated | Verifica el ADR de reemplazo |
| Gotcha | ALTO | Aplica siempre, sin excepción |
| Gotcha | MEDIO | Aplica y menciona en el plan |
| Gotcha | BAJO | Sugiere, no fuerza |

## Campo `afecta` — el más importante

El campo `afecta` en el frontmatter enlaza el ADR/gotcha con rutas reales del código:
```yaml
afecta: [src/auth/session.ts, src/database/]
```

El AST indexer y el impact analyzer usan este campo para:
- Cruzar ADRs con archivos que el agente va a tocar
- Alertar cuando el agente intenta violar una decisión aceptada
- Mostrar gotchas relevantes antes de ejecutar cambios

