'use strict';
/**
 * Página «Decisiones» del tablero: /decisiones. Se muestra dentro del dashboard como una pestaña más.
 *
 * El diseño es el del artefacto «Tablero de decisiones» (decisiones-pagina.html): lista y tablero con arrastre, filtros, panel de
 * detalle, acciones en lote y responsables. Los datos viven en el canal TEAMS del proyecto; lo que se responde, se crea o se mueve
 * llega solo a la cola del modelo que trabaja (Director o Cursor, en modo individual o en Teams): no hay que copiar ni pegar nada.
 *
 *   GET  /api/v1/tablero           configuración + elementos (formato del tablero)
 *   POST /api/v1/tablero-guardar   { id, cambios, texto }  — mismo origen + cabecera X-Akdd-Action (lo valida el servidor)
 *   POST /api/v1/tablero-crear     { id, cuerpo }
 *
 * El HTML es un archivo aparte para que sea legible y editable; este módulo solo lo entrega.
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, 'decisiones-pagina.html'), 'utf8');

module.exports = { HTML };
