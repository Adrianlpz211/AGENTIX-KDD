# Plan 7 — Endurecimiento estructural (cero features nuevas: más estricto, más segmentado, más honesto)

> ## ✅ ESTADO: COMPLETADO Y VERIFICADO — 2026-07-15 (v3.15.0)
> Las 7 tareas implementadas en lumoV2, verificadas (31/31 checks del
> verify-plan7 + re-run de Planes 1/2/4/5/6 en verde) y portadas a main con
> paridad byte a byte. La suite corrió DOS veces: en lumoV2 con better-sqlite3
> y en main con el fallback node:sqlite (better-sqlite3 ausente de verdad) —
> ambos caminos 31/31.
>
> **Refinamientos descubiertos durante la ejecución** (no estaban en el plan):
> 1. `MADUREZ.json` vive DENTRO de `.agentic/grafo/` (no en `.agentic/`):
>    update.js solo re-copia grafo/ a los clientes — afuera nunca les llegaría.
> 2. La frontera de madurez aplica a requires **de carga** (columna 0); las
>    invocaciones perezosas fail-soft pueden cruzar hacia arriba (así es la
>    arquitectura real del motor: 8 cruces perezosos legítimos, 0 de carga).
>    El lint distingue ambos mecánicamente.
> 3. El lint encontró 2 requires de carga reales que corregir: post-cycle→
>    parallel-guard (se volvió perezoso) y grafo→area-detector (area-detector
>    ascendió a core por mérito). causal-edges ascendió a core; coverage-meter
>    descendió a experimental (depende de ts-enricher).
> 4. **Hallazgo de la corrida en main**: 4 módulos (lock-manager,
>    regression-guard, spec-gate, akdd-analyze) requerían better-sqlite3 SIN
>    fallback a node:sqlite — en una máquina sin toolchain de compilación
>    (optionalDependency fallida) dos módulos core crasheaban. Corregido con
>    el patrón canónico + polyfills mínimos (pragma/transaction) en
>    lock-manager. Los otros 37 módulos ya lo tenían.
> 5. ALTER tolerantes extra en initASTSchema (line_end/content_hash) para el
>    caso extremo de una tabla ast_symbols antiquísima sin esas columnas.

> **Para ejecutar con `aa: sprint`.** Nace del cruce de dos auditorías externas
> + el criterio interno (2026-07-16): tres de las cuatro "debilidades
> estructurales" señaladas comparten UNA raíz — que la invocación y el registro
> de protecciones dependan de la obediencia del modelo — y UNA cura: moverlas a
> hierro (hooks, escáneres, locks, manifiestos). Este plan NO agrega superficie
> de usuario; endurece la que existe. Principios de siempre: números-no-prosa,
> fail-closed/soft, ALTER tolerantes, nunca peor que ayer.

## Las 7 tareas

| # | Tarea | Debilidad que mata |
|---|---|---|
| T6→primera | **INDEX_VERSION: migración automática del grafo** — el indexador estampa su versión en project_settings; al detectar mismatch (cliente viejo tras `akdd update`) hace clear+reindex completo UNA vez, solo. Sin esto, el cliente viejo queda con line_end=0 y kinds viejos cacheados para siempre (DOUBT eterno = seguro pero sin valor nuevo) | La pregunta del dueño: "¿los clientes viejos cargan sus grafos nuevos sin problemas?" — ahora SÍ, solos |
| T5 | **Etiqueta `source` en telemetría** (`mechanical` \| `protocol`) — columna tolerante + escritores; permite MEDIR qué fracción de protecciones es hierro vs obediencia | "Agéntico como protocolo, no magia" — medible |
| T2 | **spec-value-scan.cjs** — escáner MECÁNICO de valores de negocio vigilados en el diff staged (la lista del Spec Gate: trial_days, rate_limit…): si una línea del diff toca una clave vigilada con un número distinto al de memoria → WARN + evento. Solo la franja semántica queda en el modelo | El "punto ciego dentro del punto ciego" (mitad 1) |
| T1 | **Pre-commit hook de gates mecánicos** — install-hooks instala (además del post-commit) un pre-commit que corre security-scan + spec-value-scan sobre lo staged. SIEMPRE exit 0 en v1 (visible, no bloqueante — la escalada a bloqueo se gana). La invocación deja de depender del LLM | El "punto ciego dentro del punto ciego" (mitad 2: obediencia) |
| T3 | **Evidencia de paralelismo por LOCKS** — MODO LEGIÓN instruye a cada sub-agente a adquirir su lock de módulo; el Parallel Guard acepta como evidencia ventanas de lock SOLAPADAS de instancias distintas (mecánico, independiente del cwd y de transcripts) | Falsos negativos del Parallel Guard |
| T4 | **Manifiesto de madurez + lint de dependencias** — `.agentic/MADUREZ.json` (módulo→nivel: core/stable/experimental) + `madurez-lint.cjs` que lee los require() reales del motor y falla si core→experimental. Sin mover carpetas (cero churn) | Complejidad sin fronteras |
| T7 | **Verificación de la RUTA DE UPGRADE** — simular un cliente con BD vieja (sin gate_events, sin anclas, sin protected_symbols, ast_symbols sin line_end): correr el motor nuevo encima y probar que (a) nada truena, (b) las columnas/tablas aparecen solas, (c) el índice se auto-migra por versión, (d) los behaviors viejos degradan a nivel-archivo (diseñado). + re-run Planes 1/2/5/6 + porte + commits v3.15.0 + prepublish | La confianza del lanzamiento |

## Qué NO hace este plan
- No mueve módulos de carpeta (el manifiesto es datos, no mudanza).
- No bloquea commits de clientes (pre-commit v1 = WARN visible, exit 0).
- No intenta mecanizar el juicio semántico (esa franja queda declarada en el
  modelo, con telemetría alrededor — es la frontera honesta).
- No agrega features de usuario.

## Verificación mínima
Upgrade simulado en verde · pre-commit dispara sin LLM y registra con
source=mechanical · spec-value-scan detecta un cambio de valor vigilado ·
lock-windows solapadas dan CONFIRMADO al guard · lint pasa en el motor actual
· regresión total (planes 1/2/5/6) · prepublish v3.15.0 PASS.
