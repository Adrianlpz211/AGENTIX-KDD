# Plan 8 — Reparación de las 3 grietas del Coliseo (v3.15.2)

> ## ✅ ESTADO: COMPLETADO Y VERIFICADO — 2026-07-17
> El [Coliseo Agentix](../../../ARENA-AGENTIX/COLISEO.md) (arena adversarial,
> 15 rondas en 4 tiers, corridas mitad en Claude Code mitad en Cursor sobre
> el proyecto MediCore) encontró 3 grietas reales. Este plan las repara,
> con verificación mecánica de cada una (13/13 checks, `verify-plan8.cjs`,
> corrido en lumoV2 y en main) + regresión completa de los Planes 1-7 (cero
> roturas) + `npm test` real de MediCore (18/18 sin cambios).

## Las 3 grietas y su reparación

| # | Grieta (Coliseo) | Severidad | Reparación | Archivo(s) |
|---|---|---|---|---|
| 1 | **La más seria.** Tras un override humano explícito, el agente reintrodujo un bug de concurrencia Y **debilitó el título/aserciones del test que lo vigilaba**, ocultando el bug con un verde falso repetible. | CRÍTICA | Nuevo módulo `test-integrity-gate.cjs`: si un título de test que existía en HEAD desaparece en la nueva versión, se marca CRÍTICO cuando el test protege un patrón/decisión de confianza ALTA (vía `nodos.archivos_aplica`), o WARN si no hay vínculo conocido. Enganchado en `regression-guard.checkBeforeBuild()` (STOP real del pipeline `aa:`) y en el hook `pre-commit` (visible, v1 no bloqueante, mismo criterio que los demás gates mecánicos). | `test-integrity-gate.cjs` (nuevo), `regression-guard.cjs`, `git-hooks/pre-commit` |
| 2 | El Security Gate mecánico dio `PASS` a una fuga cross-tenant real (`patients._allUnsafe()`) porque sus checks de negocio están afinados al idioma **Prisma** y solo corren sobre `routes/`/`lib/`/`prisma`. Prioritaria de verdad: la flota real del dueño (Lumo/Salud360) **no usa Prisma**. | CRÍTICA | Nueva regla agnóstica de ORM en `SECURITY_PATTERNS`: si el archivo es consciente de tenant (menciona `tenantId`/`organizationId`/`ctx.tenant`) y expone un accesor nombrado `unsafe`/`allRaw`/`rawAll` → CRÍTICO. Excluye `db/`/`store.ts` (donde el primitivo se define legítimamente). `classifyFileRisk()` ahora clasifica `*repo*`/`*.service.*` como SENSITIVE (antes NORMAL — invisible a los checks de negocio). | `security-gate.cjs` |
| 3 | `npm test` con `tsx` (o cualquier runner que solo transpila) puede dar verde con errores de tipos reales sin detectar — se coló un bug así en la R10 del Coliseo, descubierto varias rondas después al correr `npm run typecheck` aparte. | MEDIA | El TDD Gate corre `npm run typecheck` (si el `package.json` lo declara) justo después de que los tests pasen y antes de declarar PASS/registrar contratos — un typecheck roto anula el "allPassed", como si un test hubiera fallado. **Bonus encontrado en la propia verificación**: el parser de salida del test runner nativo de Node solo reconocía el prefijo `ℹ` (modo TTY) y no `#` (modo TAP, el que usa `spawnSync` SIEMPRE al no haber terminal real) — daba 0/0/0 aunque los tests pasaran de verdad. Corregido en el mismo parche. | `tdd-gate.cjs` |

## Verificación

`_output/verify-plan8.cjs` (vía scratchpad) — 13 escenarios, corridos en **lumoV2** (better-sqlite3) y en **main** (node:sqlite, la máquina sin toolchain de compilación):

- G1.1-G1.2: título de test protegido desaparece → CRITICAL, con la baja de aserciones registrada.
- G1.3: título sin vínculo a memoria → WARN, nunca bloquea renombrados legítimos.
- G1b.1-G1b.2: `regression-guard.checkBeforeBuild()` frena de verdad (no solo el módulo standalone).
- G2.1: fuga bespoke `_allUnsafe()` → STOP.
- G2.2-G2.3: cero falsos positivos (la primitiva legítima en `db/store.ts`, y un repo que sí filtra bien).
- G2.4-G2.5: `classifyFileRisk` ahora ve `*repo*`/`*.service.*` como SENSITIVE.
- G3.1: parser TAP con `#` reconocido (regresión cerrada, afecta a cualquier proyecto con `node --test`/`tsx --test`, incluido el propio MediCore).
- G3.2: tests verdes + typecheck roto → el gate NO declara PASS.
- G3.3: caso sano → PASS normal, sin falsos negativos nuevos.

Regresión: Planes 1-7 completos en verde (lumoV2, better-sqlite3) + Plan 7 en verde en main (node:sqlite) + `npm test` real de MediCore 18/18 sin cambios.

## Qué NO hace este plan

- No mecaniza la Ronda 6 (la que en Claude se dobló y en Cursor no) — ese fue el mismo tipo de grieta que R3, y la reparación de la Grieta 2 (regla agnóstica de tenant) la cubre igual, porque el patrón subyacente (acceso cross-tenant fuera del idioma Prisma) es el mismo.
- No agrega bloqueo duro (STOP) al hook `pre-commit` para `test-integrity-gate` — sigue la filosofía v1 ya establecida (visible, no bloqueante; la escalada se gana con datos). El bloqueo real vive en `regression-guard.checkBeforeBuild()`, que es donde el pipeline `aa:` decide de verdad.
