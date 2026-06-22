# Subagente 04 — Datos y Base de Datos

## Área de responsabilidad
Punto 02 (RLS) — el candado más importante para una app multiusuario.

---

## Qué revisas

### 1. Row Level Security (RLS)
```
Para cada tabla de la BD:
- ¿Tiene RLS activado?
- ¿Las políticas RLS son correctas?
  → Un usuario solo puede ver/editar sus propias filas
  → Las políticas usan auth.uid() o equivalente
- ¿Hay tablas con datos sensibles sin RLS?
  → usuarios, pagos, mensajes, documentos, configuraciones
```

### 2. Acceso a la BD
```
- ¿La cadena de conexión está en variables de entorno?
- ¿Hay acceso directo a la BD desde el cliente?
  → Nunca debería haber queries directos desde el frontend
- ¿Las credenciales de BD tienen los permisos mínimos necesarios?
  → No usar usuario root/admin para la app
- ¿La BD está expuesta a internet o solo accesible desde el servidor?
```

### 3. Fugas de datos en APIs
```
- ¿Los endpoints devuelven más campos de los necesarios?
  → SELECT * cuando debería ser SELECT campo1, campo2
- ¿Se devuelven campos sensibles que el cliente no necesita?
  → passwords hasheados, tokens internos, IDs de admin
- ¿La paginación está implementada correctamente?
  → Sin paginación, alguien puede pedir millones de registros
```

### 4. Borrado de datos
```
- ¿El borrado es lógico (soft delete) o físico?
- ¿Los datos borrados siguen siendo accesibles?
- ¿Hay datos de usuarios que deberían eliminarse y no se eliminan?
```

### 5. Integridad de datos
```
- ¿Las tablas tienen foreign keys donde deberían?
- ¿Hay índices en los campos que se usan para filtrar/buscar?
- ¿Las columnas tienen constraints correctos (NOT NULL, UNIQUE)?
```

---

## Formato de hallazgos

```markdown
### [DB-01] Título
Severidad: 🔴 CRÍTICO | 🟠 ALTO | 🟡 MEDIO | 🟢 BAJO
Tabla: [nombre]
Problema: [descripción]
Riesgo: [consecuencia — especialmente en términos de privacidad]
Corrección: [SQL o cambio necesario]
```

---

## Output

```
✓ DATOS/BD auditado
Tablas revisadas: N
Con RLS: N | Sin RLS: N
Críticos: N | Altos: N | Medios: N | Bajos: N
[lista de hallazgos]
```
