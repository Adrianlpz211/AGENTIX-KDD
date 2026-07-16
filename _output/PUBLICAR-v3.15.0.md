# 🚀 Subir y publicar Agentix v3.15.0 — tu chuleta (2 pasos, ~1 minuto)

> Estado real: los commits están HECHOS y verificados localmente
> (v3.13 + v3.14 + **v3.15 endurecimiento estructural**), el prepublish-check
> pasó en verde… **pero el push necesita TUS credenciales de GitHub** — el
> almacén de Windows no tiene sesión guardada y eso es lo único que la IA no
> puede (ni debe) hacer por ti. Diagnóstico confirmado: los intentos de push
> se quedaban esperando una ventana de login que nunca viste.

---

## Paso 1 — Subir a GitHub (te pedirá login UNA vez)

Abre una terminal en esta carpeta y corre:

```
git push origin main
```

Se abrirá una ventana de GitHub (navegador o popup) pidiéndote iniciar
sesión — es el login normal de GitHub, autorízalo y el push sale solo.
Windows recordará la sesión para las próximas veces.

**Qué logra:** sube TODOS los commits pendientes (v3.12.1 + v3.13 + v3.14 +
v3.15). Con esto, `akdd update` YA entrega el motor nuevo a tus clientes.

## Paso 2 — Publicar el CLI en npm

```
npm publish
```

(El chequeo de seguridad corre solo. Si npm pide sesión: `npm login` primero.)

## Verificar que salió bien

- GitHub: el último commit debe decir "chore: bump version to 3.15.0".
- npm: `npm view agentic-kdd version` → `3.15.0`.

## Qué decirle a tus clientes después

```
npm install -g agentic-kdd
akdd update
```

## ¿Y los clientes que ya tienen la versión vieja? — PROBADO, no prometido

Se simuló un cliente real con base de datos v3.12 (sin gate_events, sin
anclas, tabla de símbolos sin line_end, sin sello de versión) y se le corrió
el motor v3.15 encima. Resultado: **31/31 checks en verde, dos veces** —
una con better-sqlite3 y otra en una máquina SIN better-sqlite3 (fallback
node:sqlite, el caso Windows sin compilador):

- Su memoria (decisiones, errores, patrones, behaviors) sobrevive INTACTA.
- Las tablas y columnas nuevas aparecen solas (migraciones tolerantes).
- El grafo de código se reconstruye solo UNA vez (sello INDEX_VERSION) y
  queda con la precisión nueva por líneas; después vuelve a usar caché.
- Su conocimiento viejo protege con las armas nuevas: el escáner de valores
  de negocio detectó una contradicción usando una regla guardada meses atrás.

O sea: `akdd update` y a trabajar. Nada que migrar a mano.

## Lo que ya quedó hecho (no lo repitas)

- ✅ Commits listos: feat v3.13 · bump 3.13.0 · feat v3.14 · bump 3.14.0 ·
  chuleta · **feat v3.15 (Plan 7)** · **bump 3.15.0**
- ✅ prepublish-check: PASS con 3.15.0
- ✅ Motor con paridad byte a byte lumoV2 ↔ main (13 archivos del Plan 7)
- ✅ v3.15 verificado con 31 checks + re-run de los planes 1/2/4/5/6
- ✅ Fuera del repo y del paquete: repomix, RECUPERADO-DE-LUMO, life-logbook
- 📝 Pendiente por decisión tuya: alinear el README (sigue en v3.8.4) — el
  dossier base está en `_output/AGENTIX-DOSSIER-v3.14.md`
