# Publicar Agentix 3.20

La versión local está preparada; este documento no afirma que ya esté publicada.

## Antes de publicar

1. Revisar los cambios de Cursor y de esta revisión. No incluir memoria.db, sesiones, telemetría, credenciales ni reportes privados en Git.
2. Ejecutar `npm ci` y `npm run release:check`. Exigir PASS en verification.json. Revisar también las limitaciones del reporte.
3. Revisar y subir los archivos de código, tests, scripts, README, package.json, package-lock.json y vendor del dashboard. La excepción de .gitignore permite incluir los vendors locales; no omitirlos del commit.
4. El paquete agentic-kdd contiene el servidor MCP. Este procedimiento publica ese paquete; no publica otro paquete agentic-kdd-mcp.
5. No ejecutar npm publish hasta decidir publicar la versión revisada. No es posible reutilizar un número ya publicado.

## Configuración recomendada: GitHub Actions con OIDC

Archivo preparado: .github/workflows/publish-npm.yml. Corre sólo manualmente desde main. El workflow anterior (`publish.yml`, disparado por tag `v*` con un `NPM_TOKEN` y un job para un `packages/mcp` que no existe) se retiró en esta revisión: publicaba sin pasar por la barrera, y con los dos archivos un `git push --tags` habría publicado por el camino viejo. Si en GitHub quedó guardado el secreto `NPM_TOKEN`, ya no lo usa nada; se puede borrar. Verifica Windows y Linux con Node 22/24; después la tarea de publicación vuelve a validar y publica exactamente el tarball cuyo SHA está en el reporte.

En GitHub, crear el environment `npm-production` y configurar revisión humana antes de la tarea publish.

En npmjs.com, iniciar sesión con una cuenta que administre agentic-kdd. Abrir el paquete → Settings → Trusted publishing → GitHub Actions e indicar:

- Organization or user: Adrianlpz211
- Repository: AGENTIX-KDD
- Workflow filename: publish-npm.yml
- Environment name: npm-production
- Allowed actions: permitir `npm publish` para este workflow.

Esta asociación se debe guardar en npm; crear el YAML local no la crea. No hace falta guardar un token de escritura en el repositorio. Requisitos oficiales: npm >=11.5.1 y Node >=22.14; el workflow usa Node 24.

Una vez revisado y subido el cambio, abrir Actions → Publish npm (manual) → Run workflow, versión 3.20.0. Aprobar el environment únicamente si las verificaciones y los cambios son aceptables.

Fuente: [Trusted publishing, documentación oficial npm](https://docs.npmjs.com/trusted-publishers/).

## Alternativa local

No hay autenticación npm confirmada en esta máquina. Usar `npm login` de forma interactiva; no pegar contraseñas ni tokens en un chat. Comprobar `npm whoami` y que la cuenta administre el paquete.

Desde el checkout, repetir `npm run release:check`. Inspeccionar sin publicar con `node scripts/publish-verified.cjs --dry-run`.

Para una publicación local expresamente aprobada, publicar el tarball revisado de _output/release-3.20.0/ con npm publish, --access public y --registry https://registry.npmjs.org/. Los tarballs no ejecutan la barrera del checkout: por eso validar antes es obligatorio. La opción recomendada sigue siendo el workflow con aprobación y comparación de SHA.

## Después de publicar

Comprobar `npm view agentic-kdd version` y probar una instalación limpia. En cada consumidor:

```powershell
npm install -g agentic-kdd@3.20.0
akdd mcp --global          # una vez por máquina: refresca el lanzador global
cd "ruta-del-consumidor"
akdd update
akdd health
```

Para habilitar el nuevo esquema de memoria en proyectos 3.19, detener agentes y autorizar `akdd update --migrate`. Revisar el respaldo y el resultado; conservarlo hasta completar la prueba del consumidor. La actualización del código sola mantiene la base byte por byte y no migra automáticamente.
