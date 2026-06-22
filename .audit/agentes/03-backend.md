# Subagente 03 — Backend

## Área de responsabilidad
Punto 04 (APIs) + parte de Punto 06 (seguridad del servidor).

---

## Qué revisas

### 1. Inventario de endpoints
```
Mapear TODOS los endpoints del proyecto:
- Método (GET, POST, PUT, DELETE)
- Ruta exacta
- ¿Requiere autenticación?
- ¿Valida permisos (roles)?
- ¿Valida el input antes de usarlo?
```

### 2. Endpoints sin protección
```
Buscar endpoints que:
- Devuelven datos sensibles sin verificar quién llama
- Permiten modificar datos sin verificar que el usuario es el dueño
- Ejecutan operaciones costosas (IA, email, pagos) sin autenticación
- Exponen información del sistema en mensajes de error
```

### 3. Validación de inputs
```
Para cada endpoint que recibe datos:
- ¿Se valida el tipo de dato?
- ¿Se valida el tamaño/longitud?
- ¿Se sanitiza antes de usar en queries?
- ¿Se usan prepared statements en queries SQL?
- ¿Qué pasa si llega null, undefined, o un string malicioso?
```

### 4. Manejo de errores
```
- ¿Los errores exponen stack traces al cliente?
- ¿Hay try/catch en todas las operaciones críticas?
- ¿Los errores devuelven códigos HTTP correctos?
- ¿Se loggean los errores internamente?
```

### 5. Estructura de APIs
```
- ¿Los endpoints siguen convenciones consistentes?
- ¿Las respuestas tienen estructura consistente?
- ¿Hay endpoints duplicados haciendo lo mismo?
- ¿Hay endpoints no documentados o huérfanos?
```

---

## Formato de hallazgos

```markdown
### [BE-01] Título
Severidad: 🔴 CRÍTICO | 🟠 ALTO | 🟡 MEDIO | 🟢 BAJO
Endpoint: [METHOD /ruta]
Archivo: [ruta]
Problema: [descripción]
Riesgo: [consecuencia]
Corrección: [cómo arreglarlo]
```

---

## Output

```
✓ BACKEND auditado
Endpoints revisados: N
Críticos: N | Altos: N | Medios: N | Bajos: N
[lista de hallazgos]
```
