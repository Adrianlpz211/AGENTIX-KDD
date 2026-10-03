# Benchmark de esfuerzo — 2026-10-02

node v24.21.0 · win32 · política v1. Bytes = archivos y paquetes que Agentix hace cargar (proxy). Tokens del host: **NO_VERIFICADO**.

| fixture | esperado | tier | bytes ant → nuevo | Δ bytes | pasos ant → nuevo | tests | tibio reutiliza |
|---|---|---|---|---|---|---|---|
| low-texto | LOW | LOW | 54199 → 5442 | 90 % | 13 → 6 | check relevante | sí |
| low-estilo | LOW | LOW | 54199 → 5447 | 90 % | 13 → 6 | check relevante | sí |
| low-rename | LOW | LOW | 54199 → 5457 | 90 % | 13 → 6 | check relevante | sí |
| low-bug-obvio | LOW | LOW | 54199 → 5441 | 90 % | 13 → 6 | check relevante | sí |
| low-test | LOW | LOW | 54199 → 5451 | 90 % | 13 → 6 | check relevante | sí |
| med-bug | MEDIUM | MEDIUM | 54199 → 37054 | 32 % | 13 → 10 | dirigidos | sí |
| med-feature | MEDIUM | MEDIUM | 54199 → 40649 | 25 % | 13 → 10 | dirigidos | sí |
| med-refactor | MEDIUM | MEDIUM | 54199 → 37250 | 31 % | 13 → 10 | dirigidos | sí |
| med-validacion | MEDIUM | MEDIUM | 54199 → 37100 | 32 % | 13 → 10 | dirigidos | sí |
| med-api | MEDIUM | MEDIUM | 54199 → 37068 | 32 % | 13 → 10 | dirigidos | sí |
| high-auth | HIGH | HIGH | 54199 → 48043 | 11 % | 13 → 13 | suite completa | sí |
| high-contrato | HIGH | HIGH | 54199 → 48007 | 11 % | 13 → 13 | suite completa | sí |
| high-transaccion | HIGH | HIGH | 54199 → 48007 | 11 % | 13 → 13 | suite completa | sí |
| high-transversal | HIGH | HIGH | 54199 → 48331 | 11 % | 13 → 13 | suite completa | sí |
| high-datos | HIGH | HIGH | 54199 → 48159 | 11 % | 13 → 13 | suite completa | sí |

## Veredicto (umbral fijado antes de correr)

- LOW: mediana de reducción de bytes 90 %, de pasos 54 % — umbral 30 % → **CUMPLE**
- Mínimos (scope, protected-files, security, leases) en las 15: **sí**
- HIGH conserva tdd, preservation, qa y reviewer: **sí**
- Tareas que escalaron respecto a lo esperado: ninguna
- CLAUDE.md (56080 B) se carga igual en ambos: PENDIENTE — CLAUDE.md lo carga el host igual en ambos pipelines; nucleo-reglas.md existe pero CLAUDE.md no se recortó.
- Instalación/indexación: excluida (costo de primera vez, se mide aparte).

Estos números miden cuánto contexto y cuántos pasos se piden, no la calidad del resultado.
