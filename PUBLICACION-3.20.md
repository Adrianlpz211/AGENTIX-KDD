# Publicar Agentix 3.20.x

Este documento prepara la publicación; **no afirma que una versión ya esté publicada**. Para saber qué hay publicado: `npm view agentic-kdd version`.

## Antes de publicar

1. Revisar los cambios. No incluir `memoria.db`, respaldos (`.agentic/_update/`), sesiones, telemetría, credenciales ni reportes privados en Git.
2. Ejecutar `npm ci` y `npm run release:check`. Exigir `PASS` en `_output/release-<versión>/verification.json` y leer las limitaciones del reporte. El reporte dice en qué plataforma y Node corrió: **no se infiere de otras**.
3. El paquete `agentic-kdd` contiene el servidor MCP; no existe otro paquete.
4. No ejecutar `npm publish` hasta decidir publicar la versión revisada. Un número publicado no se puede reutilizar.

### Qué certifica `release:check` (y qué no)

Suite completa sin omitidas; el tarball sin datos privados; el tarball **instalado en limpio** actualizando consumidores construidos con los motores **publicados** 3.19.0 y 3.20.0 (`--check`, `update`, repetición idempotente, MCP por stdio con las herramientas nuevas registradas, `--rollback` con el motor anterior leyendo la base migrada); que **leer con el motor nuevo una base vieja no la migra** (ni un byte cambia); que tras el upgrade funcionan la captura idempotente, la cola, el índice por capas, la compactación con recuperación por hash y los paquetes TEAMS (snapshot y delta); una segunda instalación con las dependencias **opcionales presentes** pero sin compilar; y sondas adversariales. **No** certifica una sesión real de Cursor/Claude, WhatsApp ni sistemas consumidores distintos de esos.

## Publicar: flujo recomendado (GitHub Actions con OIDC)

Archivo: `.github/workflows/publish-npm.yml`. Corre sólo manualmente desde `main`, verifica en Windows y Linux con Node 22/24 (donde existe un conector SQLite apto) y publica **exactamente el tarball cuyo SHA está en el reporte**.

En GitHub crea el environment `npm-production` con revisión humana. En npmjs.com, con una cuenta que administre `agentic-kdd`: Settings → Trusted publishing → GitHub Actions:

- Organization or user: `Adrianlpz211`
- Repository: `AGENTIX-KDD`
- Workflow filename: `publish-npm.yml`
- Environment name: `npm-production`

Después: Actions → **Publish npm (manual)** → Run workflow con la versión.

## Alternativa local

`npm login` de forma interactiva (no pegues contraseñas ni tokens en un chat); comprobar `npm whoami`. `npm publish` ejecuta `prepublishOnly` (la barrera completa). Para inspeccionar sin publicar: `node scripts/publish-verified.cjs --dry-run`. Si tu cuenta pide verificación en dos pasos, npm abre el navegador para autenticarte: no se puede automatizar.

## Después de publicar — verificar lo publicado

```bash
npm run release:verify
```

Descarga de npm lo que de verdad se publicó y comprueba que (1) la versión está y es `latest`, (2) el tarball es **byte a byte** el que verificó `release:check` (mismo sha256 e integridad), y (3) ese paquete descargado actualiza un consumidor real 3.19.0 con un solo comando: `VERIFIED`, memoria conservada por contenido y repetición `NO_CHANGES_VERIFIED`. Deja `published-verification.json` junto al reporte.

## Para los usuarios

```bash
npm install -g agentic-kdd@latest
akdd mcp --global              # una vez por máquina: refresca el lanzador global
cd "ruta-del-proyecto"
akdd update --check            # opcional: el plan, sin cambiar nada
akdd update                    # respalda, migra de forma compatible y verifica
akdd health
```

`akdd update` migra el esquema por sí mismo y sale con código 0 sólo si el resultado es verificable. Estados, qué puede bloquearlo y los límites del rollback están en el README. Un conector SQLite apto (`node:sqlite` en Node ≥ 22.13, o un `better-sqlite3` compatible) es requisito del update; sin él se niega antes de escribir y explica cómo resolverlo.
