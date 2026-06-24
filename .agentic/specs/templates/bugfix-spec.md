# Bugfix Spec: [descripción del bug]
Fecha: YYYY-MM-DD
Tipo: bugfix
Estado: BORRADOR → ANÁLISIS → EN_PROGRESO → COMPLETADO

---

## requirements.md

```markdown
# Requirements — Bugfix: [nombre]
Fecha: YYYY-MM-DD
Tipo: bugfix
Severidad: ALTO | MEDIO | BAJO

## Descripción del bug
[Qué falla exactamente. Mensaje de error si existe.]

## Pasos para reproducir
1. [Paso 1]
2. [Paso 2]
3. Resultado: [qué ocurre]
4. Esperado: [qué debería ocurrir]

## Causa raíz (llenar en Tarea 0)
[A completar después del análisis]

## Criterios de aceptación
- [ ] CA-1: El bug no se reproduce con los pasos anteriores
- [ ] CA-2: La suite completa de tests pasa sin regresiones
- [ ] CA-3: Edge causal registrado en memoria KDD

## Restricciones
- No romper la funcionalidad existente de [módulo]
- El fix no debe cambiar la API pública de [función/endpoint]
```

---

## design.md

```markdown
# Design — Bugfix: [nombre]

## Análisis de causa raíz
[Resultado de Tarea 0 — la causa exacta del bug]

## Solución propuesta
[Cómo se arregla. Por qué esta solución y no otra.]

## Archivos afectados
| Archivo | Tipo de cambio |
|---------|---------------|
| src/... | MODIFICAR — [qué cambia] |

## Posibles regresiones
[Qué podría romperse con este fix. Cómo se previene.]

## ADRs relacionados
[Si la solución toca una decisión arquitectónica previa]
```

---

## tasks.md

```markdown
# Tasks — Bugfix: [nombre]

## Tarea 0: Análisis de causa raíz
- Estado: PENDIENTE
- Dependencias: ninguna
- Archivos: (por determinar)
- Descripción: Reproducir el bug, identificar la causa raíz EXACTA, documentar en design.md.
  Consultar: node .agentic/grafo/causal-edges.cjs query caused_failure [módulo]
  Consultar: node .agentic/grafo/impact-analyzer.cjs analyze [archivos-sospechosos]
- Agente: analista

## Tarea 1: Fix de la causa raíz
- Estado: PENDIENTE
- Dependencias: Tarea 0
- Archivos: src/[archivo-con-bug].ts
- Descripción: Aplicar el fix exacto documentado en design.md. No arreglar "síntomas".
- Agente: back

## Tarea 2: Test de no-regresión
- Estado: PENDIENTE
- Dependencias: Tarea 1
- Archivos: tests/[módulo].test.ts
- Descripción: Test que reproduce el bug (red) → pasa con el fix (green). NUNCA eliminar este test.
- Agente: tdd

## Tarea 3: Validación de regresiones
- Estado: PENDIENTE
- Dependencias: Tarea 2
- Archivos: (suite completa)
- Descripción: Ejecutar suite completa. Verificar 0 regresiones introducidas.
- Agente: tdd

## Tarea 4: Registrar en knowledge base
- Estado: PENDIENTE
- Dependencias: Tarea 3
- Archivos: docs/gotchas/[gotcha-nuevo].md
- Descripción: Si el bug era evitable, crear gotcha para que el agente no lo repita.
  Ejecutar: node .agentic/grafo/causal-edges.cjs add caused_failure [archivo] [módulo] "[descripción]"
- Agente: memoria
```

---

## Comandos de gestión

```bash
# Crear spec de bugfix
node .agentic/grafo/spec-manager.cjs create [módulo] --bugfix

# Analizar impacto antes de ejecutar
node .agentic/grafo/impact-analyzer.cjs analyze [archivo-afectado]

# Ver historial de fallos en el módulo
node .agentic/grafo/causal-edges.cjs query caused_failure [módulo]

# Ver edges históricos (bi-temporal)
node .agentic/grafo/causal-edges.cjs history [archivo]
```
