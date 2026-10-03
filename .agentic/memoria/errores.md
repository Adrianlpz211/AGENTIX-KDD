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

## [2026-10-02] [actualizacion] — La barrera de release se puso roja por un aviso de tar, no por un fallo
Estado: RESUELTO
Confianza: BAJA
Aplicado: 0
Útil: 0
Contexto: scripts/release-check.cjs → test/init-update-uniforme.test.cjs (H26) empaqueta el checkout entero con src/tar-extract.js createTarGz mientras el resto de la suite escribe estado en .agentic/
Síntoma: `tar terminó con código 1` con stderr `tar: AGENTIX-KDD-main/.agentic: file changed as we read it`. Pasaba suelto (`npm test`) y fallaba dentro de `npm run release:check`: carrera, no determinista
Causa: GNU tar devuelve 1 (no 2) cuando un archivo cambió mientras lo leía; el .tar.gz queda completo. run-safe trata cualquier código ≠0 como error. Además el fixture incluía memoria.db-wal, telemetria/, _executions/ y _output/, que son exactamente lo que cambia solo
Solución: `avisoTolerable(err)` en tar-extract (código 1 y TODAS las líneas de stderr son ese aviso → el archivo vale); `EXCLUIR_ESTADO_VOLATIL` compartido por los tests que empaquetan el repo (nombres sueltos, válidos en GNU tar y bsdtar; `_LOCKS.md` NO va porque es managed). Test: test/tar-aviso-tolerable.test.cjs
Evitar: tratar el código 1 de GNU tar como fatal; empaquetar el checkout con la base y las trazas dentro; excluir con `_*` (se lleva `_LOCKS.md`)
Aplicar cuando: un test o script empaquete el proyecto en vivo, o una barrera falle con "file changed as we read it"

## [2026-10-03] [mcp] — akdd mcp --global nunca funcionó: ruta que Cursor no lee y motor de UN proyecto
Estado: RESUELTO
Confianza: BAJA
Aplicado: 0
Útil: 0
Contexto: src/mcp-setup.js (modo --global) y .agentic/grafo/mcp-server.cjs (bucle JSON-RPC)
Síntoma: con --global, Cursor no mostraba Agentix; la entrada global apuntaba al mcp-server.cjs del proyecto donde se corrió y el servidor tomaba ROOT de la carpeta de arranque
Causa: (1) se escribía en %APPDATA%/Cursor/User/globalStorage/mcp.json; Cursor lee ~/.cursor/mcp.json en los tres sistemas. (2) Una entrada global con la ruta del motor de un proyecto hace que otros proyectos corran ese motor (otra versión) y, según el cwd, lean otra memoria. (3) El servidor respondía con error sin id a las notificaciones (notifications/initialized) y no contestaba ping
Solución: src/mcp-launcher.cjs copiado a ~/.agentix/; resuelve el proyecto (AGENTIX_PROJECT_ROOT=${workspaceFolder} en Cursor, PROJECT_ROOT, CLAUDE_PROJECT_DIR o subiendo desde el cwd) y arranca el mcp-server.cjs DE ESE proyecto con PROJECT_ROOT fijado; sin proyecto sirve solo agentix_status. Claude Code con --scope user. El servidor ignora mensajes sin id y responde ping. Test: test/mcp-global.test.cjs
Evitar: registrar globalmente una ruta dentro de un proyecto; responder a notificaciones JSON-RPC; asumir la ruta de config de un IDE sin comprobar que la lee
Aplicar cuando: se toque la configuración MCP, se agregue soporte a otro IDE o el MCP "no aparezca" en un proyecto

## [2026-10-03] [host-hooks] — El guardia del IDE sembró src/.agentic/ y casi viaja en el paquete npm
Estado: RESUELTO
Confianza: BAJA
Aplicado: 0
Útil: 0
Contexto: .agentic/grafo/host-guard.cjs (raíz del evento) — la sesión de Claude Code estaba en src/
Síntoma: release check FAIL "Datos privados en paquete": src/.agentic/_hooks-eventos.jsonl dentro del tarball
Causa: el guardia tomaba como raíz el cwd del payload tal cual y creaba .agentic donde fuera
Solución: raizProyecto() sube desde el primer candidato (mismo orden: workspace_roots, cwd, CLAUDE_PROJECT_DIR) hasta la carpeta con .agentic/grafo; anotarEvento no escribe si no hay .agentic. .npmignore con **/.agentic/_*. Test: test/host-guard-raiz.test.cjs
Evitar: cambiar el orden de prioridad de candidatos (rompió P16 y GATE-PAYLOAD) o saltar a otro candidato
Aplicar cuando: algo escriba estado bajo .agentic a partir de un cwd recibido
