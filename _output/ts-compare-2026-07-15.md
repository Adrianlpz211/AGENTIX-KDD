# Reporte tree-sitter vs regex — 2026-07-15

Proyecto medido: `C:\lumoV2`
Índice regex: `C:\lumoV2\.agentic\memoria.db`

## Cobertura
- Archivos comparados: **314** (sin parser: 0 · fallos de parse: 0 · >500KB: 0 · faltantes: 0)
- Símbolos del índice regex: **2180** · emparejados con tree-sitter: **1989** (91.2%)
- Solo-regex (tree-sitter no los vio igual): 191 · Solo-tree-sitter (el regex no los captura): 237

## Distribución del error de line_end (todos los emparejados)
| delta | símbolos |
|---|---|
| 0 líneas (exacto) | 90 |
| 1-2 líneas | 1563 |
| 3-5 líneas | 104 |
| 6-20 líneas | 181 |
| >20 líneas | 51 |

## Lo que importa: SIN el último símbolo de cada archivo
(el último se estira hasta EOF por diseño del truco — sobra rango, dirección segura)
| delta | símbolos |
|---|---|
| 0 líneas (exacto) | 90 |
| 1-2 líneas | 1359 |
| 3-5 líneas | 99 |
| 6-20 líneas | 121 |
| >20 líneas | 11 |

**Precisión ≤2 líneas (sin-último): 86.3%** · Emparejamiento: 91.2%

## Dirección del error (la métrica decisiva para el guardia)
- **Sobra** (regex termina DESPUÉS del cierre real — revisa de más, dirección SEGURA): **1894**
- **Falta** (regex termina ANTES — deja líneas del símbolo fuera, dirección PELIGROSA): **5** (5 sin contar últimos-de-archivo)

## Veredicto (criterio del Plan 3: ≥90% emparejado y ≥95% con delta ≤2)
⚠️ **REVISAR: la aproximación se queda corta según el criterio.** Ver los peores casos abajo — si se concentran en un patrón puntual, puede arreglarse en el extractor regex antes de considerar la etapa 4.

## Peores 15 casos (delta > 5)
| archivo | símbolo | regex | tree-sitter | delta | dirección | ¿último del archivo? |
|---|---|---|---|---|---|---|
| tests\unit\workflow-engine.test.ts | function setIaRol | 73-549 | 73-75 | 474 | sobra (seguro) | sí (cola EOF) |
| tests\unit\session-manager.test.ts | type Row | 6-396 | 6-6 | 390 | sobra (seguro) | sí (cola EOF) |
| tests\unit\citas-node.test.ts | constant EMBUDO | 165-554 | 165-165 | 389 | sobra (seguro) | sí (cola EOF) |
| tests\unit\workflow-ia-usage.test.ts | function setTables | 47-222 | 47-61 | 161 | sobra (seguro) | sí (cola EOF) |
| tests\unit\valor-estimado.test.ts | function makeFakeSupabase | 3-167 | 3-16 | 151 | sobra (seguro) | sí (cola EOF) |
| tests\unit\pago-repository.test.ts | type PagoRow | 8-149 | 8-8 | 141 | sobra (seguro) | sí (cola EOF) |
| tests\unit\baileys-disconnect.test.ts | function makeFakeSocket | 15-167 | 15-30 | 137 | sobra (seguro) | sí (cola EOF) |
| tests\unit\baileys-reconnect.test.ts | function closeLoggedOut | 54-189 | 54-54 | 135 | sobra (seguro) | sí (cola EOF) |
| tests\unit\crear-puesto-ia.test.ts | function makeFakeSupabase | 3-149 | 3-24 | 125 | sobra (seguro) | sí (cola EOF) |
| tests\unit\release-conversation-bot.test.ts | type Row | 3-124 | 3-3 | 121 | sobra (seguro) | sí (cola EOF) |
| tests\unit\negocio-auth.test.ts | function mockRes | 53-153 | 53-55 | 98 | sobra (seguro) | sí (cola EOF) |
| tests\unit\message-store.test.ts | type StoreInternals | 15-102 | 15-15 | 87 | sobra (seguro) | sí (cola EOF) |
| tests\unit\workflow-asignado-linea.test.ts | function makeFakeSupabase | 5-115 | 5-31 | 84 | sobra (seguro) | sí (cola EOF) |
| src\flows\handlers\medinet.ts | constant HORARIOS_DEMO | 11-96 | 11-15 | 81 | sobra (seguro) | sí (cola EOF) |
| tests\unit\billing-sweeper.test.ts | type Negocio | 3-84 | 3-3 | 81 | sobra (seguro) | sí (cola EOF) |

---
Metodología: comparación top-level vs top-level (misma semántica que los regex anclados a columna 0). Solo lectura: ni la BD ni los archivos del proyecto medido fueron modificados. Los símbolos anidados/métodos (etapa 5 del plan) NO entran en esta medición.