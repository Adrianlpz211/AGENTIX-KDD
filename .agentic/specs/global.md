# SPEC — global
Generado: 2026-09-03
Última actualización: 2026-09-03
Estado: IMPLEMENTADO

## Qué hace
Módulo global del proyecto Agency OS.
Tests: 99 pasando ✅

## Criterios de aceptación
- ✅ CRUD completo con tenant isolation (agencyId en todas las queries)
- ✅ 88 tests pasando en primera iteración
- ✅ 0 regresiones detectadas

## Archivos principales
| — | — |

## Tests
| Suite | Tests | Estado |
|-------|-------|--------|
| global.test.ts | 88 | ✅ PASS |

## Patrones aplicados
- Multi-tenancy: filtrar siempre por agencyId
- Soft delete: isActive=false en vez de DELETE
- JWT: agencyId en token payload

## Notas
Generado automáticamente por post-cycle.cjs v1.0
