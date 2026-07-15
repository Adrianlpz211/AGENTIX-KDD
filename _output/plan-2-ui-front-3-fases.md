# Plan 2 — Paridad de protección para UI/Front: 3 fases (Ojos → Memoria → Músculo)

> **✅ ESTADO: IMPLEMENTADO Y VERIFICADO (2026-07-15).** Ejecutado en C:\lumoV2
> (19/19 escenarios, incluyendo NAVEGADOR REAL: página sana → PASS; página con
> los 2 bugs de Salud360 reproducidos → exactamente 3 hallazgos:
> UI_ELEMENT_MISSING + UI_REQUIRED_ROTO + UI_SELECT_ROTO) y portado el mismo
> día a AGENTIX-KDD-main (paridad idéntica). Datos reales de Lumo tras Fase A:
> 27 forms, 25 selects, 105 fields, 1194 clases CSS, 1101 edges CSS→vista.
> El Plan 1 se re-verificó después (15/15) — cero regresión.
>
> **Refinamientos descubiertos al implementar (ya incorporados abajo):**
> 1. `required` se detecta EXACTO con `/\srequired(?=[\s=>/])/i` y viaja como
>    marcador `[required] ` al inicio del signature — un `class="required"` NO
>    es un campo required (nada de substring).
> 2. Fase C v1 usa `required-attr` (el atributo sigue puesto) en vez de
>    `form.checkValidity()` — checkValidity da falsos positivos con valores
>    precargados; el atributo es exacto. checkValidity queda para v2 si hace falta.
> 3. Un flujo SELECT genera DOS checks (element-exists + select-usable).
> 4. Para tests que editan archivos: respetar el EOL del archivo (con
>    autocrlf=true, EOL mixto hace que git declare el archivo ENTERO cambiado →
>    la contención ve todo como HIT — dirección conservadora-segura del guardia,
>    pero arruina la precisión del test).

> **Para ejecutar con `aa:` en el repo AGENTIX-KDD.** Documento autocontenido.
> Generado el 2026-07-15 con Fable 5 tras leer el código real. Ejecutar las
> fases EN ORDEN (B se para sobre A; C se para sobre A+B).
> Prerrequisito recomendado (no bloqueante): Plan 1
> (`_output/plan-1-opcion-b-regression-guard-lineas.md`) — la Fase B reutiliza
> su pregunta de contención; sin él, las fases A y B igual valen (mensajes
> enriquecidos a nivel archivo).

---

## Objetivo en una línea

Que el frontend/UI tenga las MISMAS tres patas de protección que hoy solo tiene
el backend: **anclas en el índice** (qué existe y dónde), **comportamientos
protegidos** (qué sabemos que funciona) y **verificador mecánico** (comprobarlo
sin depender de que un agente se acuerde).

## El porqué — dos bugs reales del cliente Salud360 (2026-07)

1. **Combobox que rompió selects existentes:** se aplicó un combobox a varios
   formularios; en vistas que no tenían select quedó bien, en vistas que YA
   tenían selects funcionando los rompió (dejaron de funcionar).
2. **CSS que rompió validaciones:** se trabajaron características CSS nuevas y
   en algunos formularios se rompieron validaciones existentes (`required`).

**Por qué se colaron (verificado en el código):**
- El extractor de flujos del Regression Guard (`regression-guard.cjs:85`) solo
  reconoce `app.get/post/...` — endpoints de servidor. Los ciclos de UI
  registran protecciones HUECAS (sin flujos, casi nunca con tests) → "esta
  vista ya tiene un select que funciona" nunca fue un comportamiento protegido.
- Los archivos `.css` y `.html` son INVISIBLES para todo el sistema: el mapa de
  lenguajes (`ast-indexer.cjs:106-124`) no los incluye → un cambio de CSS tiene
  blast radius CERO en el grafo; el análisis de impacto no dice nada.

**Estado de las tres patas para UI hoy:** anclas ~20% (solo funciones JS),
comportamientos ~0% (registros huecos), verificador ~15% (`browser-gate.cjs`
recién nacido: consola + captura, genérico, WARN). Semillas que SÍ existen:
`ui-native-gate.cjs` (reglas mecánicas extensibles vía `NATIVE_RULES`),
`browser-gate.cjs` (navegador real sin descargas), reglas UI en `patrones.md`.

## Principios NO NEGOCIABLES (heredados del Plan 1 + uno propio)

1. **Números/igualdad exacta, no reconocimiento de texto en prosa.**
2. **Portón cerrado ante la duda:** cualquier falla o dato faltante → el
   comportamiento actual. Nada nuevo puede dejar al sistema MENOS protegido.
3. **Aditivo, nunca renombrar:** hay 9 consumidores de `ast_symbols`
   (`causal-edges`, `collab-manager`, `context-enricher`, `grafo`,
   `health-check`, `mcp-server`, `metrics`, `dashboard`, `ast-indexer`).
   Solo se AGREGAN kinds nuevos; jamás se renombra ni cambia el formato de los
   existentes.

---

# FASE A — OJOS (indexar la materia del UI)

**Meta:** que formularios, campos, selects, `required`, clases CSS y "qué vista
usa qué clase" existan como símbolos y edges en el grafo, con línea.

### A1. Registrar los lenguajes nuevos

En `ast-indexer.cjs`:
- `LANGUAGE_MAP` += `'.html': 'html'`, `'.css': 'css'`
- `EXTRACTORS` += `html: extractHTML`, `css: extractCSS`

### A2. `extractHTML(content)` — nuevos kinds: `form`, `field`, `select`

- **Formularios:** patrón `/<form\b[^>]*>/gi`.
  - `symbol_name`: `form#<id>` si tiene id; si no `form[name=<name>]`; si no
    tiene ninguno `form@L<línea>` (estable dentro del archivo).
  - `kind: 'form'`, `line_start` = línea del match.
  - **`line_end`: buscar el PRIMER `</form>` posterior.** Esto es VÁLIDO solo
    aquí porque HTML **prohíbe forms anidados** — es la única etiqueta donde
    este atajo es correcto sin parser. NO generalizar el truco a divs u otras
    etiquetas anidables.
- **Campos:** patrón `/<(input|select|textarea)\b[^>]*>/gi`.
  - `select` → `kind: 'select'` (kind propio: es exactamente el caso del bug
    combobox y el guardia debe poder nombrarlo). `input`/`textarea` →
    `kind: 'field'`.
  - `symbol_name`: `select[name=<name>]` / `input[name=<name>]` (si no hay
    `name`, usar `id`; si no hay ninguno, `select@L<línea>`).
  - `signature` = el tag completo recortado a 100 chars — **aquí viaja el
    atributo `required`** (se detecta con `/\brequired\b/` sobre el tag).
    NO redefinir la columna `exported` para marcar "crítico": dejarla en 0 y
    detectar `required` desde `signature`. Las semánticas de columnas
    existentes no se tocan (principio 3).
  - `line_end`: línea donde cierra el `>` del tag (escanear desde el match —
    cubre atributos multilínea). Campo = etiqueta única, sin cuerpo.

### A3. `extractCSS(content)` — nuevos kinds: `css_class`, `css_id`

- Extraer solo las CABEZAS de selector: `/(^|\})\s*([^{}]+)\{/g` y de cada
  cabeza sacar tokens `.clase` y `#id`.
- `symbol_name` = el nombre SIN el punto/almohadilla (`btn-primary`), kind
  `css_class` / `css_id`, `line_start` = línea del selector.
- **NO indexar propiedades CSS** (color, margin…): es ruido puro que infla la
  tabla y no ancla nada. Selectores dentro de `@media` salen solos con el mismo
  regex — aceptable en v1.

### A4. Edges `USES_CLASS` — el blast radius del CSS (mata el bug #2)

1. En `extractJS` y `extractHTML`: capturar `class="..."`, `className="..."` y
   `className={\`...\`}` con contenido literal simple; por cada token de clase
   emitir `{ kind: 'USES_CLASS', to_symbol: <clase>, from_symbol: null }`.
2. Los edges nacen con `to_file = NULL` (en el momento de extraer un archivo no
   sabemos qué CSS define la clase). Agregar una **pasada de enlace
   post-index** — nueva función `linkCssEdges(db)`:
   - Para cada edge `USES_CLASS` con `to_file IS NULL`: buscar
     `ast_symbols WHERE kind='css_class' AND symbol_name = <clase>` (igualdad
     exacta) y setear `to_file`. Si la clase está definida en 2+ archivos CSS,
     crear un edge por cada definición.
   - Llamarla desde `indexProject()` DESPUÉS del loop de archivos y ANTES de
     `computePageRank()`.
3. **Resultado esperado:** `node .agentic/grafo/ast-indexer.cjs impacto styles.css`
   pasa de silencio total a listar las vistas que usan sus clases. El Context
   Enricher y el análisis de impacto lo heredan gratis.

### A5. ⚠️ La trampa del caché (idéntica al Plan 1)

`indexFile()` se salta archivos cuyo hash no cambió — los extractores nuevos NO
corren sobre archivos viejos. Tras implementar la fase:

```bash
node .agentic/grafo/ast-indexer.cjs clear && node .agentic/grafo/ast-indexer.cjs index
```

### A6. Verificación de la Fase A

- Crear fixture: `pruebas-ui/vista.html` (un `<form id="login">` con 2 inputs
  `required` y un `<select name="linea">` con opciones) + `pruebas-ui/estilos.css`
  (2 clases, una usada en la vista).
- `node .agentic/grafo/ast-indexer.cjs symbols pruebas-ui/vista.html` debe
  listar: 1 form (con line_start y line_end reales), 2 field, 1 select.
- `node .agentic/grafo/ast-indexer.cjs impacto pruebas-ui/estilos.css` debe
  mostrar la vista como dependiente.
- `akdd health` y el dashboard sin errores (consumidores intactos).
- Borrar fixtures al terminar.

---

# FASE B — MEMORIA (protecciones UI reales)

**Meta:** que los ciclos exitosos de UI registren comportamientos protegidos con
anclas verificables — igual que el back registra endpoints.

### B1. `extractFlows` v2 (`regression-guard.cjs:75-94`)

Hoy solo emite flujos backend (`GET /path`) y con el bug de `router.*` (si el
Plan 1 ya lo arregló, esta edición es idempotente — verificar antes).

Agregar: para cada archivo del changeset con extensión `.html/.js/.jsx/.ts/.tsx`,
**consultar el ÍNDICE en vez de re-regexear**:

```sql
SELECT symbol_name, kind, signature FROM ast_symbols
WHERE file = ? AND kind IN ('form','select','field')
```

y emitir flujos con formato estable = prefijo + `symbol_name` EXACTO:

- `FORM form#login` — por cada form
- `SELECT select[name=linea]` — por cada select
- `REQUIRED input[name=email]` — por cada field/select cuyo `signature`
  contenga `required`

**Por qué desde el índice y no con regex propio:** una sola fuente de verdad de
nombres. Si `extractFlows` generara los nombres con SU propio regex, cualquier
divergencia de un carácter contra el indexador rompería el JOIN por igualdad —
la lección del Paso 5 del Plan 1.

### B2. `registerBehavior` — sin cambio de schema

`critical_flows` ya es TEXT JSON: los flujos UI entran igual que los endpoints y
escalan con la misma regla de siempre (`pass_count` 5+ → HIGH). Si el Paso 6 del
Plan 1 está hecho, `protected_symbols` también captura los símbolos UI tocados —
misma migración tolerante, no duplicarla (usar `try/catch ALTER TABLE`).

### B3. La contención del Plan 1, generalizada a UI

En el lookup del veredicto (Paso 4b del Plan 1), mapear prefijo de flow → kind:

| Prefijo del flow | kind buscado |
|---|---|
| `GET/POST/PUT/DELETE/PATCH ` | `endpoint` |
| `FORM ` | `form` |
| `SELECT ` | `select` |
| `REQUIRED ` | `field` o `select` (IN) |

El resto (frescura por hash, igualdad exacta, DOUBT→nivel archivo) es idéntico
y NO se reimplementa — es la misma función.

### B4. Resultado esperado (el bug #1 muerto)

Vista con select protegido (3+ ciclos verdes) → un ciclo nuevo la toca →
ANTES de construir:

```
⚠️ REGRESSION GUARD: tocas "select[name=linea]" en vista negocio.html
   (líneas 40-52) — protegido con 4 ciclos verdes. Verificar que sigue
   operativo después del cambio.
```

### B5. Verificación de la Fase B

- Con la fixture de A6: correr `registerBehavior` (CLI `register`) sobre la
  vista → inspeccionar `protected_behaviors.critical_flows`: debe contener
  `FORM form#login`, `SELECT select[name=linea]`, 2 × `REQUIRED ...`.
- Simular HIT/MISS/DOUBT como en el Paso 7 del Plan 1 pero con el select.

---

# FASE C — MÚSCULO (browser-gate por comportamiento)

**Meta:** que "el formulario sigue validando" y "el select sigue funcionando" se
comprueben en un navegador real, mecánicamente — el equivalente UI de "correr
los tests del behavior".

### C1. Config del proyecto: `.agentic/browser-gate.json`

Mapear archivo→URL es información del proyecto, no adivinable:

```json
{
  "devCommand": "npm run dev",
  "port": 3000,
  "readyTimeoutMs": 20000,
  "routes": {
    "src/views/negocio.html": "/negocio",
    "src/views/login.html": "/login"
  }
}
```

**Sin config → el gate corre en modo genérico actual (consola + captura) y
agrega WARN "browser-gate.json faltante — checks por comportamiento
desactivados".** Fail-closed: la ausencia de config = comportamiento de hoy,
nunca un error.

### C2. `browser-gate.cjs` v2 — checks mecánicos por comportamiento

Para cada vista tocada que tenga behaviors UI (leídos de
`protected_behaviors.critical_flows`), además de los checks actuales
(console/pageerror/screenshot, que se MANTIENEN):

1. **element-exists:** el `symbol_name` ES casi un selector CSS. Traducción
   documentada: `form#login` → `form#login`; `select[name=linea]` →
   `select[name="linea"]` (agregar comillas al valor del atributo).
   `page.$(selector)` debe devolver elemento.
2. **required-blocks:** con el form vacío,
   `page.$eval('<form-selector>', f => f.checkValidity())` debe dar `false`.
   `checkValidity()` es mecánico y NO envía nada — cero efectos secundarios.
   (Este check mata el bug #2: CSS/JS que rompe `required` se detecta aquí.)
3. **select-usable:**
   `page.$eval('<select-selector>', s => s.options.length > 0 && !s.disabled)`
   debe dar `true`.

**Fuera de alcance v1 (documentar como futuro, no construir ahora):**
comparación visual de screenshots, interacciones complejas (drag, teclado),
multi-navegador.

### C3. Severidad — WARN primero, STOP se gana

- v1: **SIEMPRE WARN** (mismo criterio que `ui-native-gate` y el browser-gate
  actual: visible en el reporte, nunca bloquea).
- Escalada a STOP: SOLO con flag explícito `--strict` **y** behavior HIGH
  (5+ ciclos). Nunca STOP por defecto en la primera release — primero se
  observa la tasa de falsos positivos en proyectos reales.

### C4. Integración en el pipeline

Editar `.agentic/agentes/05-qa.md`: después de que los tests pasan, si el
changeset toca vistas con behaviors UI **y** existe `browser-gate.json` →
correr el gate con las rutas afectadas y adjuntar findings + screenshot al
reporte de QA. Respetar el diseño existente del gate: navegador del sistema
por defecto, `--own` opcional, **jamás auto-descargar binarios**.

### C5. Verificación de la Fase C (los dos bugs de Salud360 como casos de prueba)

1. **Caso required:** en la fixture, quitar `required` de un input (o agregar
   `novalidate` al form) → correr el gate → debe reportar `required-blocks
   FAIL` con la vista y el behavior.
2. **Caso select:** vaciar las `<option>` del select → `select-usable FAIL`.
3. **Caso CSS:** cambiar la clase usada por la vista → el impacto (Fase A)
   lista la vista → el gate la visita → consola limpia = PASS con evidencia.
4. Sin `browser-gate.json` → modo genérico + WARN de config, exit 0.

---

## Qué NO hacer (las 3 fases)

- NO renombrar kinds ni formatos de `symbol_name` existentes (9 consumidores).
- NO indexar propiedades CSS ni cada `div` con id — el ruido produce fatiga de
  alertas, y la fatiga mata al guardia (deja de ser escuchado).
- NO auto-descargar navegadores (respetar el diseño `--own`).
- NO STOP por defecto en Fase C v1.
- NO generar nombres de símbolo con regex propios fuera del indexador — el
  índice es la única fuente de nombres.
- NO usar el atajo del `</form>` para otras etiquetas (solo forms no anidan).
- NO olvidar el reindex forzado tras la Fase A (trampa del caché).

## Orden, dependencias y al terminar

- **A → B → C.** B3 depende del Paso 4 del Plan 1; si no está, B registra
  flujos igual (valen para mensajes enriquecidos) y la contención se conecta
  después.
- Al terminar CADA fase (obligatorio, CLAUDE.md):

```bash
node .agentic/grafo/post-cycle.cjs grafo --tests=[N] --task="UI Front fase [A|B|C] — [descripción]"
```
