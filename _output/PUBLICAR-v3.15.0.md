# 🚀 Subir y publicar Agentix v3.14.0 — tu chuleta (2 pasos, ~1 minuto)

> Estado real: los 5 commits están HECHOS y verificados localmente
> (v3.13 + v3.14 completos), el prepublish-check pasó en verde…
> **pero el push necesita TUS credenciales de GitHub** — el almacén de
> Windows no tiene sesión guardada y eso es lo único que la IA no puede
> (ni debe) hacer por ti. Diagnóstico confirmado: los intentos de push se
> quedaban esperando una ventana de login que nunca viste.

---

## Paso 1 — Subir a GitHub (te pedirá login UNA vez)

Abre una terminal en esta carpeta y corre:

```
git push origin main
```

Se abrirá una ventana de GitHub (navegador o popup) pidiéndote iniciar
sesión — es el login normal de GitHub, autorízalo y el push sale solo.
Windows recordará la sesión para las próximas veces.

**Qué logra:** sube los 5 commits (v3.12.1 + v3.13 + v3.14). Con esto,
`akdd update` YA entrega el motor nuevo a tus clientes.

## Paso 2 — Publicar el CLI en npm

```
npm publish
```

(El chequeo de seguridad corre solo. Si npm pide sesión: `npm login` primero.)

## Verificar que salió bien

- GitHub: el último commit debe decir "chore: bump version to 3.14.0".
- npm: `npm view agentic-kdd version` → `3.14.0`.

## Qué decirle a tus clientes después

```
npm install -g agentic-kdd
akdd update
```

## Lo que ya quedó hecho (no lo repitas)

- ✅ 5 commits listos: feat v3.13 · bump 3.13.0 · feat v3.14 · bump 3.14.0
  (+ el 3.12.1 tuyo que estaba sin subir)
- ✅ prepublish-check: PASS con 3.14.0
- ✅ Motor con paridad total lumoV2 ↔ main (14/14 archivos idénticos)
- ✅ Fuera del repo y del paquete: repomix, RECUPERADO-DE-LUMO, life-logbook
- 📝 Pendiente por decisión tuya: alinear el README (sigue en v3.8.4) — el
  dossier base está en `_output/AGENTIX-DOSSIER-v3.14.md`
