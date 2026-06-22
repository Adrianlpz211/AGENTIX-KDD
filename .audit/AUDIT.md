# Departamento QA — Agentic KDD
# Palabra de activación: audit:

## Qué es esto
Sistema de auditoría profunda separado del pipeline de desarrollo.
El agente QA de Agentic KDD valida tareas individuales.
El Departamento Audit revisa el proyecto completo como producto.

## Comandos disponibles

```
audit: help        → muestra todos los comandos disponibles
audit: auditar     → auditoría completa (7 subagentes en paralelo)
audit: seguridad   → solo seguridad (secretos, auth, vulnerabilidades)
audit: frontend    → solo frontend (source maps, llaves, build)
audit: backend     → solo backend (endpoints, validación, APIs)
audit: datos       → solo BD y RLS
audit: performance → solo rendimiento (rate limiting, caché, escalabilidad)
audit: browser     → solo QA en navegador real
audit: codigo      → solo calidad de código y Git
```

## Cuando el usuario escribe audit: help

Mostrar exactamente esto:

```
╔══════════════════════════════════════════════════╗
║  DEPARTAMENTO QA — Agentic KDD                  ║
╚══════════════════════════════════════════════════╝

Comandos disponibles:

  audit: auditar     → auditoría completa (7 subagentes)
  audit: seguridad   → secretos, auth, vulnerabilidades
  audit: frontend    → source maps, llaves, build
  audit: backend     → endpoints, validación, APIs
  audit: datos       → RLS, BD expuesta, fugas
  audit: performance → rate limiting, caché, escalabilidad
  audit: browser     → QA real en navegador
  audit: codigo      → calidad de código, Git
  audit: help        → muestra este menú

El reporte se guarda en:
  _output/audit-[fecha].md
  .audit/reporte-actual.md

Para corregir hallazgos del reporte:
  aa: corrige el hallazgo SEG-01
  O simplemente pídelo directo en el chat
```

## Para corregir hallazgos del reporte

No hay comando especial — usa lo que prefieras:

```
# Con pipeline completo de Agentic KDD
aa: corrige el hallazgo SEG-01 del reporte de auditoría

# Directo en el chat (para correcciones puntuales)
"corrige la fuga de API key en src/config.js"
"agrega RLS a la tabla de pagos"
"implementa rate limiting en /api/ai"
```

## Dónde se guardan los reportes

```
_output/audit-[fecha].md    ← historial de auditorías
.audit/reporte-actual.md    ← siempre el más reciente
```

## Regla absoluta

`audit:` solo audita y reporta. No modifica código.
Las correcciones las decides tú y las ejecutas como prefieras.

## Archivos del Departamento
- `.audit/agentes/00-director.md`    → orquesta los subagentes
- `.audit/agentes/01-seguridad.md`   → auth, vulnerabilidades, secretos
- `.audit/agentes/02-frontend.md`    → source maps, llaves, build
- `.audit/agentes/03-backend.md`     → endpoints, validación, APIs
- `.audit/agentes/04-datos.md`       → RLS, BD, fugas de datos
- `.audit/agentes/05-performance.md` → rate limiting, caché, escalabilidad
- `.audit/agentes/06-browser.md`     → QA real en navegador
- `.audit/agentes/07-codigo.md`      → calidad, deuda técnica, Git
