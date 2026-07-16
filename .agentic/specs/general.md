# SPEC — general
Generado: 2026-07-14
Última actualización: 2026-07-15
Estado: IMPLEMENTADO

## Qué hace
Módulo general del proyecto Agency OS.
Tests: 0 pasando ✅

## Criterios de aceptación
- ✅ CRUD completo con tenant isolation (agencyId en todas las queries)
- ✅ 0 tests pasando en primera iteración
- ✅ 0 regresiones detectadas

## Archivos principales
| — | — |

## Tests
| Suite | Tests | Estado |
|-------|-------|--------|
| general.test.ts | 0 | ✅ PASS |

## Patrones aplicados
- Multi-tenancy: filtrar siempre por agencyId
- Soft delete: isActive=false en vez de DELETE
- JWT: agencyId en token payload

## Notas
Generado automáticamente por post-cycle.cjs v1.0
