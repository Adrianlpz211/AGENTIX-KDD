# Harness Rules — Agentic KDD v3
## Reglas imperativas re-inyectadas por paso

> Estas reglas son **obligatorias**. No son sugerencias. No tienen excepciones.
> El Orquestador las inyecta en el contexto de cada paso antes de ejecutarlo.
> El harness.cjs verifica que se cumplan — si el agente no puede probar que las siguió, el gate lo rechaza.

---

## REGLAS GLOBALES (aplican a TODOS los pasos)

```
PROHIBIDO: avanzar al siguiente paso sin que el gate haya retornado PASS.
PROHIBIDO: reportar un paso como "completado" si el gate no lo verificó.
PROHIBIDO: modificar archivos fuera de la lista allowed_files del plan activo.
OBLIGATORIO: leer config.md antes de cualquier acción en cada ciclo nuevo.
OBLIGATORIO: reportar el resultado real — nunca inventar que "todo está bien".
```

---

## PASO 0 — Context Guard

```
ANTES DE ACTUAR:
  VERIFICAR que la tarea pertenece al proyecto actual.
  VERIFICAR que los conceptos de la tarea existen en el stack del proyecto.
  Si la tarea es ajena al proyecto → STOP inmediato con explicación.
  Si es un concepto nuevo → marcar como CONCEPTO_NUEVO, no bloquearlo.

PROHIBIDO:
  Continuar con una tarea que claramente no pertenece al proyecto.
  Asumir que cualquier tarea es válida sin verificar scope.

OUTPUT REQUERIDO (para que el gate pase):
  { scope_confirmed: true, concepts: [...], is_project_related: true }
```

---

## PASO 1 — Analista

```
ANTES DE PLANIFICAR:
  1. Leer config.md → stack, módulos, reglas.
  2. Leer memoria/trabajo.md → ciclos completados, estado actual.
  3. Consultar grafo: node .agentic/grafo/grafo.cjs buscar "[tarea]" [área]
  4. Consultar AST: node .agentic/grafo/ast-indexer.cjs impacto "[archivo]"
     (para cada archivo que planifiques tocar)
  5. Consultar knowledge base: node .agentic/grafo/knowledge-ingestor.cjs query [módulo]
  6. Leer spec del módulo si existe: .agentic/specs/[módulo].md

PROHIBIDO:
  Planificar sin leer la spec del módulo si existe.
  Crear un plan que contradiga decisiones con Estado: ACTIVO.
  Dejar fases incompletas — TODAS las fases deben estar definidas desde el inicio.
  Inventar archivos que no existen en el proyecto.

OBLIGATORIO:
  Definir TODAS las fases desde el inicio, no solo la primera.
  Listar los archivos exactos a tocar en cada fase (allowed_files).
  Incluir criterios de aceptación medibles por QA.

OUTPUT REQUERIDO:
  { plan: {...}, phases: [...], area_kdd: "...", allowed_files: [...] }
```

---

## PASO 2/3 — Front / Back

```
ANTES DE IMPLEMENTAR:
  Verificar que el plan tiene allowed_files definido.
  Verificar contra denylist: NUNCA tocar .agentic/grafo/, node_modules/, archivos de config global.

PROHIBIDO:
  Tocar archivos no listados en allowed_files del plan.
  Modificar .agentic/agentes/, .agentic/grafo/schema.sql sin instrucción explícita.
  Dejar imports rotos, variables no usadas, o TODOs sin resolver en código nuevo.
  "Hacer que funcione rápido" sin considerar los patrones ALTA de la memoria.

OBLIGATORIO:
  Aplicar TODOS los patrones con Confianza: ALTA del área correspondiente.
  Respetar el estilo y convenciones del proyecto (leer un archivo similar existente).
  Reportar exactamente qué archivos se tocaron.

OUTPUT REQUERIDO:
  { files_touched: [...], diff_summary: "...", within_scope: true }
```

---

## PASO 4 — TDD + Self-Healing

```
PROHIBIDO — REGLAS DE HIERRO:
  ⛔ NUNCA marcar TDD como completado sin haber ejecutado los tests.
  ⛔ NUNCA modificar un test para que pase artificialmente.
  ⛔ NUNCA reportar "tests pasando" sin haber ejecutado: node .agentic/grafo/tdd-gate.cjs run [área]
  ⛔ NUNCA avanzar a QA si tdd-gate.cjs retorna exit code 1.
  ⛔ PROHIBIDO saltar TDD o reducir su alcance por ninguna razón.

OBLIGATORIO:
  Ejecutar: node .agentic/grafo/tdd-gate.cjs run [área]
  Si el gate reporta tests fallando → DIAGNÓSTICO → FIX → RE-EJECUTAR GATE.
  Máximo 3 iteraciones de self-healing. Si no pasa → STOP con reporte exacto.
  Registrar el episodio si hubo self-healing exitoso.

OUTPUT REQUERIDO (desde tdd-gate.cjs):
  { tests_found: [...(≥1)], all_passed: true, iterations: N, regressions: [] }
```

---

## PASO 5 — QA

```
PROHIBIDO — REGLAS DE HIERRO:
  ⛔ NUNCA ejecutar QA si TDD no pasó.
  ⛔ NUNCA marcar QA como PASS si algún criterio de aceptación no fue verificado.
  ⛔ NUNCA omitir la verificación de criterios de aceptación del plan.
  ⛔ NUNCA reportar "QA aprobado" si la suite completa tiene fallos.

OBLIGATORIO:
  Verificar CADA criterio de aceptación definido en el plan del Analista.
  Ejecutar la suite completa (no solo los tests del módulo).
  Reportar el qa_verdict como PASS | WARN | FAIL (no texto libre).

OUTPUT REQUERIDO:
  { acceptance_criteria_checked: true, full_suite_passed: true, regressions: [], qa_verdict: "PASS" }
```

---

## PASO 6 — ag:review

```
PROHIBIDO:
  ⛔ NUNCA ejecutar review si QA no pasó.
  ⛔ NUNCA marcar un BLOCKER como REQUIRED para hacerlo pasar.
  Omitir la verificación contra memoria KDD (errores, patrones, decisiones).

OBLIGATORIO:
  Verificar que el código no introduce ninguno de los errores registrados con Confianza: ALTA.
  Reportar blockers y required por separado.
  Si hay BLOCKERs → STOP. No negociar.

OUTPUT REQUERIDO:
  { blockers: [], required: [...], review_verdict: "CLEAN" | "REQUIRED" }
  (nunca "BLOCKERS" — si hay blockers, no llega al output)
```

---

## PASO 7 — Memoria

```
PROHIBIDO:
  ⛔ NUNCA ejecutar sync de memoria si el review no fue completado.
  Registrar episodios falsos o resumidos artificialmente.
  Omitir el registro de episodios cuando hubo self-healing.

OBLIGATORIO:
  Registrar episodio crudo (sin summarizar) de lo que ocurrió.
  Ejecutar: node .agentic/grafo/grafo.cjs sync
  Actualizar specs del módulo.
  Si hubo causal edges nuevos (caused_failure, was_fixed_by) → registrarlos.

OUTPUT REQUERIDO:
  { episodio_registrado: true, grafo_synced: true, specs_updated: [...] }
```

---

## INYECCIÓN DE REGLAS — CÓMO USAR ESTE ARCHIVO

El Orquestador inyecta las reglas de cada paso en el contexto del agente usando este formato:

```
## REGLAS OBLIGATORIAS PARA ESTE PASO (no negociables)
[contenido de la sección correspondiente]

⚠️ El harness verificará el OUTPUT REQUERIDO.
   Si el output no cumple el schema → el paso NO avanza.
```

**Referencia para el Orquestador:**
```bash
# Leer reglas de un paso específico
node -e "
const rules = require('fs').readFileSync('.agentic/agentes/harness-rules.md', 'utf8');
const match = rules.match(/## PASO [04] — TDD[\s\S]*?(?=\n## PASO|\n---\n## INYECCIÓN)/);
if (match) console.log(match[0]);
"
```
