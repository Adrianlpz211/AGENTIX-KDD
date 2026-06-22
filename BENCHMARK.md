# Benchmark — Agentic KDD en proyectos reales

> Este documento contiene datos reales de proyectos en uso activo.
> No es documentación de intención — es evidencia de uso.

---

## Proyectos activos

### Glowly — Beauty SaaS
**Stack:** Next.js 14 App Router · TypeScript · Supabase PostgreSQL (18 tablas)
**Estado:** En desarrollo activo con Agentic KDD

**Output real de `node .agentic/grafo/grafo.cjs stats`:**
```
  GRAFO DE CONOCIMIENTO — Agentic KDD

  Total nodos: 14 | Relaciones: 48

  Por tipo:
    error:    2
    patron:   6
    decision: 6

  Por confianza:
    ALTA: 5
    MEDIA: 4
    BAJA: 5

  Reglas ALTA (permanentes — aplicadas automáticamente en cada ciclo):
    [patron] Design system antes de UI nueva (global)
    [patron] Queries solo en lib/supabase/queries/ (global)
    [patron] Menus flotantes con flip automatico (frontend)
    [patron] Contraste admin oscuro vs cards blancas (frontend)
    [patron] Citas por turno, hora al confirmar (citas)
```

**Decisiones arquitectónicas registradas:**
```
[decision] Validar primero en Ktalogo antes de standalone  — ALTA
[decision] wa.me como fallback permanente                   — ALTA
[decision] Hosting independiente en Railway                 — ALTA
[decision] Supabase RLS sobre auth.uid()                    — MEDIA
[decision] App Router (no Pages Router)                     — MEDIA
[decision] Server Components por defecto                    — MEDIA
```

---

### Wapi — WhatsApp Bot Service
**Stack:** Node.js · TypeScript · Supabase
**Estado:** En desarrollo activo con Agentic KDD

**Output real de `node .agentic/grafo/grafo.cjs stats`:**
```
  GRAFO DE CONOCIMIENTO — Agentic KDD

  Total nodos: 8 | Relaciones: 6

  Por tipo:
    error:    2
    patron:   2
    decision: 4

  Por confianza:
    ALTA: 3
    MEDIA: 2
    BAJA: 3

  Reglas ALTA (permanentes):
    [decision] wa.me como fallback permanente (integracion)
    [decision] Validar primero en Ktalogo (arquitectura)
    [decision] Hosting independiente en Railway (devops)
```

---

## Comparativa de latencia de consulta

| Sistema | Tipo de memoria | Latencia típica |
|---------|----------------|-----------------|
| **Agentic KDD v2.1** | SQLite + 6 índices compuestos | **<5ms** |
| Agentic KDD v2.0 | SQLite sin índices compuestos | 10–50ms |
| GBrain | PGLite indexado | <5ms |
| Claude + Obsidian | Markdown files | 200–2000ms |
| Sin sistema | Contexto manual en cada sesión | — |

---

## Cómo verificar el uso real

Cualquiera que instale Agentic KDD y lo use activamente puede correr:

```bash
# Ver estado actual del grafo
node .agentic/grafo/grafo.cjs stats

# Ver métricas de ciclos completados
node .agentic/grafo/grafo.cjs metricas

# Ver snapshot actual de memoria
node .agentic/grafo/grafo.cjs snapshot

# Abrir dashboard con datos reales
node dashboard.cjs
```

El dashboard en **Metrics → Memory evolution** muestra cómo el grafo
creció desde el primer ciclo hasta ahora — evidencia directa del uso real.

---

## Lo que demuestra que no es teórico

1. **El grafo crece con el uso** — los nodos, relaciones y confianzas
   son generados por ciclos `aa:` reales, no escritos manualmente.

2. **Las reglas ALTA tienen historial** — campos `Aplicado` y `Útil`
   con valores reales de cuántas veces se usó y ayudó cada patrón.

3. **Los snapshots registran el antes/después** — la tabla `ciclos`
   guarda el estado de memoria al inicio y fin de cada ciclo,
   mostrando exactamente cómo cambió el conocimiento.

4. **Los logs de observabilidad existen** — `_output/log-YYYY-MM.md`
   con cada ciclo registrado automáticamente.

5. **El dashboard muestra datos SQLite reales** — no hardcoded,
   no ejemplos. Lo que ves en Metrics es lo que realmente pasó.

---

*Última actualización: 2026-06-18*
*Para reportar métricas de tu proyecto: github.com/Adrianlpz211/Agentic-KDD/issues*
