# Memoria de patrones — KDD v2
<!--
Formato:
## [FECHA] Nombre del patrón
Prioridad: ALTA | MEDIA
Confianza: BAJA | MEDIA | ALTA
Aplicado: 0
Útil: 0
Aplica a: front | back | ambos
Regla: qué hacer
Razón: por qué
Ejemplo: caso concreto
Excepción: cuándo NO aplica
-->

## Patrones activos
_Sin patrones registrados aún._

### Prisma: filtrar SIEMPRE por agencyId en queries — nunca cross-tenant
**confianza**: ALTA
**módulo**: global
**regla**: Toda query Prisma sobre datos de usuario DEBE incluir where: { agencyId } — nunca omitir este filtro
**detectado por**: post-cycle (2026-07-11)
**aplicado**: 1
**útil**: 1
**estado**: ACTIVO
**última validación**: 2026-07-11

### Prisma: usar include:{} explícito para evitar N+1 queries
**confianza**: ALTA
**módulo**: database
**regla**: Nunca hacer queries en loop — usar include para cargar relaciones en una sola query
**detectado por**: post-cycle (2026-07-11)
**aplicado**: 1
**útil**: 1
**estado**: ACTIVO
**última validación**: 2026-07-11

### Soft delete: isActive=false en vez de DELETE en tablas de usuario
**confianza**: ALTA
**módulo**: global
**regla**: Nunca hacer DELETE hard en tablas de datos — usar isActive=false o deletedAt para preservar integridad referencial
**detectado por**: post-cycle (2026-07-11)
**aplicado**: 1
**útil**: 1
**estado**: ACTIVO
**última validación**: 2026-07-11

### Vitest: tests deben ser independientes — sin estado compartido entre tests
**confianza**: MEDIA
**módulo**: tests
**regla**: Usar beforeEach para resetear mocks — nunca depender de orden de ejecución de tests
**detectado por**: post-cycle (2026-07-11)
**aplicado**: 1
**útil**: 1
**estado**: ACTIVO
**última validación**: 2026-07-11
