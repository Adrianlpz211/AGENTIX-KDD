# Feature Spec: [nombre del feature]
Fecha: YYYY-MM-DD
Tipo: feature
Estado: BORRADOR → EN_PROGRESO → COMPLETADO

---

## requirements.md

```markdown
# Requirements — [módulo]
Fecha: YYYY-MM-DD
Tipo: feature

## Contexto y problema
[¿Qué problema resuelve? ¿Para quién?]

## User stories

### Historia 1
Como [rol]
Quiero [capacidad]
Para [beneficio]

## Criterios de aceptación
- [ ] CA-1: [criterio medible]
- [ ] CA-2: [criterio medible]
- [ ] CA-3: [criterio medible]

## Restricciones
- No romper [módulo X]
- Mantener compatibilidad con [API/versión]

## Out of scope
- [Lo que NO hace este feature]
```

---

## design.md

```markdown
# Design — [módulo]
Fecha: YYYY-MM-DD

## Arquitectura propuesta
[Descripción o diagrama de la solución]

## Archivos a modificar
| Archivo | Tipo | Razón |
|---------|------|-------|
| src/... | NUEVO | ... |
| src/... | MODIFICAR | ... |

## Decisiones técnicas
- [ADR-NNN] [Decisión relacionada]

## Riesgos
- [Riesgo]: impacto ALTO/MEDIO/BAJO
```

---

## tasks.md

```markdown
# Tasks — [módulo]
Fecha: YYYY-MM-DD
Tipo: feature

## Tarea 1: Setup y tipos base
- Estado: PENDIENTE
- Dependencias: ninguna
- Archivos: src/[módulo]/types.ts
- Descripción: Definir interfaces y tipos base
- Agente: back

## Tarea 2: Lógica principal
- Estado: PENDIENTE
- Dependencias: Tarea 1
- Archivos: src/[módulo]/[feature].ts
- Descripción: Implementar la lógica del feature
- Agente: back

## Tarea 3: UI / endpoint
- Estado: PENDIENTE
- Dependencias: Tarea 2
- Archivos: src/[módulo]/[component].tsx
- Descripción: UI o endpoint que consume la lógica
- Agente: front

## Tarea 4: Tests
- Estado: PENDIENTE
- Dependencias: Tarea 1, Tarea 2
- Archivos: tests/[módulo].test.ts
- Descripción: Tests TDD para CA-1, CA-2, CA-3
- Agente: tdd

## Tarea 5: Documentación
- Estado: PENDIENTE
- Dependencias: Tarea 4
- Archivos: docs/adr/ADR-NNN-[decisión].md
- Descripción: ADR si se tomaron decisiones arquitectónicas relevantes
- Agente: memoria
```

---

## Comandos de gestión

```bash
# Crear el spec desde este template
node .agentic/grafo/spec-manager.cjs create [módulo]

# Ver waves de ejecución
node .agentic/grafo/spec-manager.cjs waves [módulo]

# Ver estado
node .agentic/grafo/spec-manager.cjs status [módulo]

# Validar antes de ejecutar
node .agentic/grafo/spec-manager.cjs validate [módulo]
```
