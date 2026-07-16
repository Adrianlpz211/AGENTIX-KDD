# 🚀 Publicar Agentix v3.14.0 — tu chuleta (1 solo comando: el push ya lo hizo la IA)

> Estado al entregarte esto: los commits están hechos Y EMPUJADOS a GitHub
> (https://github.com/Adrianlpz211/AGENTIX-KDD, rama main). El chequeo
> pre-publicación pasó con la versión 3.14.0. Solo te queda UN comando.

---

## Lo único que te toca — desde la raíz del repo (esta carpeta):

```
npm publish
```

**Qué logra:** actualiza el paquete `agentic-kdd` en npm (el comando `akdd`).
El chequeo de seguridad (`prepublish-check.js`) corre solo antes de publicar.

**Si npm te pide sesión:** `npm whoami` — si da error, `npm login` con tu
cuenta de siempre y repite `npm publish`.

## Qué ya quedó hecho por la IA (no lo repitas)

- ✅ Push a GitHub main — con esto, `akdd update` YA entrega el motor v3.14
  a los clientes (canal del motor).
- ✅ Versión 3.14.0 en package.json.
- ✅ prepublish-check en verde.
- ✅ Fuera del repo y del paquete: repomix, RECUPERADO-DE-LUMO, life-logbook.

## Qué decirle a tus clientes después del publish

```
npm install -g agentic-kdd
akdd update
```

## Verificar que salió bien

- GitHub: el último commit dice "chore: bump version to 3.14.0".
- npm: `npm view agentic-kdd version` → `3.14.0`.

## Nota pendiente (decisión tuya, ya registrada)

El README sigue en v3.8.4 — la alineación completa (los 10 puntos + el
dossier como base) quedó para una pasada posterior; el dossier técnico vive en
`_output/AGENTIX-DOSSIER-v3.14.md`.
