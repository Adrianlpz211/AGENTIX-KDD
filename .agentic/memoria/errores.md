# Memoria de errores — KDD v2
<!--
Formato de cada entrada:
## [FECHA] [MÓDULO] — Título
Estado: RESUELTO
Confianza: BAJA | MEDIA | ALTA
Aplicado: 0
Útil: 0
Contexto: dónde ocurrió
Síntoma: error exacto
Causa: por qué ocurrió
Solución: qué se hizo
Evitar: qué no hacer
Aplicar cuando: en qué situaciones

La confianza sube automáticamente:
- Aplicado 3+ y Útil/Aplicado >= 0.7 → MEDIA
- Aplicado 7+ y Útil/Aplicado >= 0.8 → ALTA
-->

## Registro de errores

## [2026-07-15] [grafo] — line_end siempre 0: el INSERT de ast_symbols omite la columna
Estado: DETECTADO — pendiente de fix
Confianza: BAJA
Aplicado: 0
Útil: 0
Contexto: .agentic/grafo/ast-indexer.cjs:557 (INSERT de símbolos)
Síntoma: 321 funciones indexadas, 0 con line_end lleno — la columna existe en el schema pero siempre queda en 0
Causa: doble — (1) ningún extractor calcula line_end, y (2) aunque lo calculara, el INSERT no incluye la columna, así que jamás se escribiría
Solución: calcular line_end con el patrón "frontera por siguiente símbolo" (ver patrones.md) Y agregar la columna al INSERT — son dos arreglos, no uno
Evitar: asumir que una columna del schema se llena solo porque existe — siempre verificar que el INSERT la incluya
Aplicar cuando: se implemente precisión por líneas en Regression Guard (fase 1)

## [2026-07-15] [grafo] — tryTreeSitter es código muerto: nunca invocado + deps no instaladas
Estado: DETECTADO — decisión pendiente (conectar o retirar)
Confianza: BAJA
Aplicado: 0
Útil: 0
Contexto: .agentic/grafo/ast-indexer.cjs:504
Síntoma: existe el wrapper tryTreeSitter (web-tree-sitter + grammars WASM) pero indexFile jamás lo llama, y ni web-tree-sitter ni tree-sitter-wasms están en package.json ni en node_modules (verificado 2026-07-15)
Causa: la capa 2 de la estrategia declarada en la cabecera del archivo ("tree-sitter cuando esté disponible") nunca se conectó
Solución: pendiente — o se conecta en la fase 2 de precisión, o se retira para no dar falsa sensación de que tree-sitter está activo
Evitar: creer que la precisión de tree-sitter está activa — hoy TODO el grafo AST sale del fallback regex
Aplicar cuando: se evalúe la ruta de precisión exacta (fase 2)
