---
tipo: gotcha
regla: "Resumen de la regla en una línea — qué NO hacer o qué SI hacer"
severidad: ALTO
afecta: [src/módulo/archivo.ts, src/otro/]
area: nombre-del-módulo
date: YYYY-MM-DD
autor: nombre-dev
---

# Gotcha: [título descriptivo]

## Regla

**[EN UNA LÍNEA: qué está prohibido o qué es obligatorio]**

## Contexto

_¿Por qué existe esta regla? ¿Cuál fue el bug o el pain que la generó?_

## ❌ Ejemplo incorrecto

```typescript
// Este código rompe la regla
const resultado = await hacerAlgo();
// Problema: [explicar qué falla]
```

## ✅ Ejemplo correcto

```typescript
// Este código aplica la regla
const resultado = await hacerAlgoCorrectamente();
// Por qué funciona: [explicar]
```

## Consecuencias si no se sigue

* _Consecuencia 1 — ej: leak de memoria_
* _Consecuencia 2 — ej: inconsistencia en DB_

## Historia

_¿Cuándo ocurrió el bug? ¿En qué módulo? Referencia al episodio si existe._

---

**Severidad ALTO**: el agente SIEMPRE aplica esta regla, sin excepción.
**Severidad MEDIO**: el agente aplica y menciona en el plan.
**Severidad BAJO**: el agente sugiere, no fuerza.
