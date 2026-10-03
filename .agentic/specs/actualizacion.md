# SPEC — actualizacion
Generado: 2026-10-02
Última actualización: 2026-10-02
Estado: IMPLEMENTADO

## Qué hace
Módulo actualizacion del proyecto Agency OS.
Tests: 304 pasando ✅

## Criterios de aceptación
- ✅ CRUD completo con tenant isolation (agencyId en todas las queries)
- ✅ 303 tests pasando en primera iteración
- ✅ 0 regresiones detectadas

## Archivos principales
| — | — |

## Tests
| Suite | Tests | Estado |
|-------|-------|--------|
| actualizacion.test.ts | 303 | ✅ PASS |

## Patrones aplicados
- Multi-tenancy: filtrar siempre por agencyId
- Soft delete: isActive=false en vez de DELETE
- JWT: agencyId en token payload

## Notas
Generado automáticamente por post-cycle.cjs v1.0
