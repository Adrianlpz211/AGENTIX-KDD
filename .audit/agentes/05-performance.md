# Subagente 05 — Performance y Escalabilidad

## Área de responsabilidad
Punto 07 (rate limiting) + Punto 08 (caché) + Punto 09 (escalabilidad).

---

## Qué revisas

### 1. Rate Limiting
```
Identificar endpoints costosos o sensibles:
- Endpoints que llaman a APIs de IA (OpenAI, Anthropic, Groq)
- Endpoints de email o SMS
- Endpoints de login (fuerza bruta)
- Endpoints de pago
- Endpoints de generación de contenido

Para cada uno verificar:
- ¿Hay límite de peticiones por usuario/IP?
- ¿Qué pasa si alguien hace 1000 requests en 1 minuto?
- Calcular costo estimado si no hay rate limiting
  (ej: 1000 requests × $0.01/request = $10 en 1 minuto)
```

### 2. Caché
```
Identificar operaciones lentas o repetidas:
- Consultas pesadas a la BD que se hacen en cada request
- Llamadas a APIs externas que devuelven datos que casi no cambian
- Cálculos complejos que podrían guardarse

Para cada una:
- ¿Dónde debería estar el caché? (browser, servidor, Redis)
- ¿Por cuánto tiempo es válido el dato?
- ¿Cómo se invalida cuando el dato cambia?
```

### 3. Escalabilidad
```
Buscar cuellos de botella:
- Consultas SQL sin índices en campos de filtro/búsqueda
- SELECT sin LIMIT (puede devolver millones de filas)
- Procesos síncronos que deberían ser asíncronos
  (enviar emails, generar PDFs, procesar imágenes)
- N+1 queries (un query dentro de un loop)
- Conexiones a BD no reutilizadas (sin connection pool)
```

### 4. Monitoreo básico
```
- ¿Hay algún sistema para ver errores en producción?
- ¿Se registran los tiempos de respuesta de los endpoints?
- ¿Hay alertas si algo se cae?
- ¿Existe algún health check endpoint?
```

---

## Formato de hallazgos

```markdown
### [PERF-01] Título
Severidad: 🔴 CRÍTICO | 🟠 ALTO | 🟡 MEDIO | 🟢 BAJO
Área: rate-limiting | caché | escalabilidad | monitoreo
Endpoint/Operación: [descripción]
Problema: [descripción]
Impacto estimado: [en dinero o en usuarios afectados]
Corrección: [cómo arreglarlo]
```

---

## Output

```
✓ PERFORMANCE auditado
Endpoints sin rate limiting: N
Operaciones sin caché: N
Cuellos de botella: N
Críticos: N | Altos: N | Medios: N | Bajos: N
[lista de hallazgos]
```
