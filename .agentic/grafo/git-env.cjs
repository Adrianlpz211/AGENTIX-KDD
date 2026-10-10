#!/usr/bin/env node
'use strict';
/* Entorno sin las variables de git que un hook le deja al proceso.
 *
 * El 10/10/2026 la suite de pruebas de Agentix corrió DENTRO de un hook de commit (tdd-gate lanza `npm test` desde el
 * post-commit) y heredó GIT_DIR / GIT_INDEX_FILE del repo real. Las pruebas hacen `git init`, `git config user.name prueba`
 * y `git commit` en carpetas temporales: con esas variables puestas, git ignora la carpeta y escribe en el repo REAL.
 * Resultado medido: core.bare=true, identidad «prueba», ramas y commits de prueba en main, y el índice destrozado.
 *
 * Todo proceso que Agentix lance para correr PRUEBAS (las del propio Agentix o las del proyecto del cliente) debe usar este
 * entorno. NO se usa para los comandos de git que el propio Agentix corre sobre el proyecto (esos necesitan lo que el hook dejó).
 */
const VARIABLES_DE_GIT = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH', 'GIT_CEILING_DIRECTORIES',
];

/** Copia del entorno sin ninguna variable que apunte a un repo concreto. */
function entornoSinGit(env) {
  const salida = Object.assign({}, env || process.env);
  for (const k of VARIABLES_DE_GIT) delete salida[k];
  return salida;
}

module.exports = { entornoSinGit, VARIABLES_DE_GIT };
