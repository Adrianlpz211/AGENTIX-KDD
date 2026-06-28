# DESIGN_SYSTEM.md — API Contract Reference
<!-- Agentic KDD — API Design System -->
<!-- El agente Back lee este archivo antes de cualquier tarea de API -->

## Stack de Backend
- Framework: (completar: FastAPI / Express / Fastify / NestJS)
- ORM: (completar: SQLAlchemy / Prisma / TypeORM)
- Auth: JWT (access 15min + refresh 7d)
- DB: (completar: PostgreSQL / MySQL / SQLite)

## Convenciones de API

### Rutas
```
GET    /recursos/          → listar (con filtros y paginación)
POST   /recursos/          → crear
GET    /recursos/{id}      → obtener por ID
PUT    /recursos/{id}      → actualizar completo
PATCH  /recursos/{id}      → actualizar parcial
DELETE /recursos/{id}      → eliminar (soft delete preferido)
```

### Respuestas de éxito
```json
// Lista
{
  "data": [...],
  "total": 100,
  "page": 1,
  "per_page": 20
}

// Item único
{
  "id": "uuid",
  "...campos": "..."
}

// Creación exitosa → 201
// Actualización exitosa → 200
// Sin contenido → 204
```

### Respuestas de error
```json
{
  "detail": "Mensaje de error legible",
  "code": "ERROR_CODE_SNAKE_CASE"
}
```

### Códigos de error estándar
- 400 Bad Request — validación fallida
- 401 Unauthorized — sin token o token inválido
- 403 Forbidden — token válido pero sin permiso
- 404 Not Found — recurso no existe
- 409 Conflict — duplicado o violación de constraint
- 422 Unprocessable Entity — pydantic validation error
- 500 Internal Server Error — error inesperado

## Reglas de negocio críticas
<!-- COMPLETAR con las reglas de tu dominio -->
<!-- Ejemplo: -->
```
OVERTIME_THRESHOLD = 8       # horas por día antes de overtime
OVERTIME_MULTIPLIER = 1.5    # multiplicador de tarifa
INVOICE_DUE_DAYS = 30        # días de plazo en facturas
INVOICE_PREFIX = "AGY"       # prefijo de números de factura
```

## Multi-tenancy
- Toda tabla de datos tiene `agency_id` (o equivalente)
- Toda query DEBE filtrar por `agency_id` del token JWT
- Nunca exponer datos de un tenant a otro
- El campo `agency_id` en requests del body se IGNORA — siempre del token

## Paginación
```
?page=1&per_page=20          → paginación estándar
?cursor=xxx                   → cursor-based (preferido para listas grandes)
?search=texto                 → búsqueda fulltext
?sort=campo&order=asc|desc   → ordenamiento
```

## Autenticación
```
Authorization: Bearer <access_token>
X-Refresh-Token: <refresh_token>   (solo en /auth/refresh)
```

## Convenciones de naming
- Rutas: snake_case y plural → /agency_users/
- Campos en JSON: snake_case
- IDs: UUID v4
- Fechas: ISO 8601 → "2026-06-27T18:00:00Z"
- Booleanos: is_active, has_*, can_*

## Campos auditables estándar
Toda tabla de datos debe tener:
```
id          UUID PRIMARY KEY
created_at  TIMESTAMP WITH TIME ZONE
updated_at  TIMESTAMP WITH TIME ZONE
is_active   BOOLEAN DEFAULT true
```

---
> Actualiza este archivo cuando cambies la API o las reglas de negocio.
> El agente Back lo lee antes de cada tarea.
