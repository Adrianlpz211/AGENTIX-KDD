#!/usr/bin/env node
/**
 * LÍNEA DE TIEMPO — Agentic KDD
 *
 * Rebobina el proyecto: qué pasó, en qué orden y cuánto tardó.
 *
 * Nació de un caso real: un defecto que era invisible mirando
 * el código —cada pieza estaba bien por separado— y se encontró comparando dos
 * fechas de modificación. Una vista fijó la versión de un archivo un minuto
 * ANTES de que ese archivo cambiara.
 *
 * La idea de fondo, en palabras del dev: "es como editar un vídeo; si hay un
 * fallo, el editor viaja en la línea de tiempo y encuentra dónde está".
 *
 * Hallazgo de diseño: la cinta YA está grabada. El disco guarda las fechas de
 * modificación y memoria.db tiene más de mil eventos con hora. Lo que faltaba
 * era el reproductor.
 *
 * Uso:
 *   node linea-tiempo.cjs ventana [desde] [hasta]   línea de tiempo de un rango
 *   node linea-tiempo.cjs orden                     detecta órdenes invertidos
 *   node linea-tiempo.cjs inicio "<tarea>"          marca el arranque de una tarea
 *   node linea-tiempo.cjs fin                       cierra y reporta cuánto tardó
 *   node linea-tiempo.cjs resumen [n]               tabla de los últimos n cierres
 *   node linea-tiempo.cjs ciclo <id>                qué pasó durante un ciclo
 *
 * Fail-soft: si falta la base o una fuente, sigue con las demás y lo dice.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/* ─────────────────────────── rutas y utilidades ─────────────────────────── */

const RAIZ = process.cwd();
const DB_PATH = path.join(RAIZ, ".agentic", "memoria.db");
const MARCA = path.join(RAIZ, ".agentic", "_tarea_en_curso.json");

const EXT = /\.(ts|tsx|js|jsx|cjs|mjs|html|css|scss|sql|md|json|py|cs|java|go|rb|php)$/i;
/**
 * Tolerancia del detector de orden invertido.
 * Varios archivos escritos por la misma operación comparten el segundo, y eso
 * no es un orden invertido: es un lote. H-09 —el caso que originó todo esto—
 * tenía un minuto de desfase. Con 10s se filtra el ruido sin perder casos reales.
 *
 * Importa que no grite en falso: una evidencia que falla sin motivo se acaba
 * ignorando, y entonces no sirve para nada.
 */
const TOLERANCIA_MS = 10 * 1000;

/**
 * Umbral de "escritura en lote".
 *
 * Una copia, una sincronización, un checkout o un formateo masivo cambian la
 * fecha de decenas de archivos en el mismo segundo SIN cambiar su contenido.
 * Esas fechas no son ediciones y no sirven para detectar orden invertido: si se
 * usan, el detector produce fantasmas.
 *
 * Caso real que lo motivó: 60 archivos con la misma marca (13:50:21) en un
 * proyecto, que generaban un hallazgo de caché vieja completamente falso.
 *
 * Regla: si más de este número de archivos comparten el mismo segundo, ese
 * segundo se descarta como momento de edición.
 */
const LOTE_MIN_ARCHIVOS = 8;

const IGNORA = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".venv", "__pycache__"]);

function abrirDB(readOnly = true) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    if (!fs.existsSync(DB_PATH)) return null;
    return new DatabaseSync(DB_PATH, { readOnly });
  } catch {
    return null;
  }
}

/**
 * SQLite guarda datetime('now') en UTC; el disco guarda hora local.
 * Todo se normaliza a Date local para que la línea de tiempo no mienta.
 * Este desfase ya causó confusión real: un cierre de las 10:13 aparecía
 * como 14:13 en el registro de ciclos.
 */
function fechaDB(txt) {
  if (!txt) return null;
  const s = String(txt).trim();
  if (!s) return null;
  // ISO con Z → ya es UTC explícito
  if (/Z$|[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  // "YYYY-MM-DD HH:MM:SS" de datetime('now') → UTC implícito
  const d = new Date(s.replace(" ", "T") + "Z");
  return isNaN(d) ? null : d;
}

const p2 = (n) => String(n).padStart(2, "0");
const hhmm = (d) => p2(d.getHours()) + ":" + p2(d.getMinutes());
const hhmmss = (d) => hhmm(d) + ":" + p2(d.getSeconds());
/** Si el desfase cruza días, la hora sola engaña: se añade la fecha. */
const sello = (d, mostrarDia) => (mostrarDia ? ymd(d) + " " : "") + hhmmss(d);
const ymd = (d) => d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());

function dur(ms) {
  if (ms == null || !isFinite(ms)) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  // 13 min 59 s se mostraba como "13 min" y perdía casi un minuto. Truncar hacia
  // abajo hace que dos fuentes den números distintos para lo mismo, y eso rompe
  // la confianza en el reporte antes que un número redondo la gane.
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return (s % 60) ? m + " min " + (s % 60) + "s" : m + " min";
  }
  // De una hora en adelante se muestran minutos, no segundos. Aquí hay que
  // redondear y no truncar: truncando, cada fila perdía hasta 59 s en silencio
  // y diez filas se comían cinco minutos que nadie veía desaparecer.
  const mTot = Math.round(s / 60);
  const h = Math.floor(mTot / 60);
  if (h < 24) return h + "h " + (mTot % 60) + "min";
  return Math.floor(h / 24) + "d " + (h % 24) + "h " + (mTot % 60) + "min";
}

/**
 * Redondea a la MISMA unidad que `dur()` va a imprimir, para que la suma de las
 * filas de una tabla dé exactamente el total de abajo.
 *
 * Sin esto cada fila redondeaba por su cuenta y el total por la suya: dos filas
 * de 2,4 s y 1,4 s se imprimían como «2s» y «1s», y el total como «4s». Una
 * tabla donde 2 + 1 = 4 invita justo a la desconfianza que el reporte existe
 * para quitar — y estos números los ven los jefes.
 *
 * Se pierde hasta media unidad de precisión en el total. Es el intercambio
 * correcto: por debajo de lo que la tabla muestra, esa precisión no significa
 * nada; una tabla que no cuadra sí.
 */
function cuantizar(ms) {
  if (ms == null || !isFinite(ms)) return 0;
  const s = Math.round(ms / 1000);
  return s < 3600 ? s * 1000 : Math.round(ms / 60000) * 60000;
}

/** Días naturales que abarca un rango (1 = todo en el mismo día). */
function diasQueAbarca(a, b) {
  const d1 = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const d2 = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((d2 - d1) / 86400000) + 1;
}

const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
/** Sello legible con fecha: "vie 30/08 11:18:47". El trabajo se reparte en
 *  tandas a lo largo de varios días, así que la hora sola no ubica nada. */
function selloCompleto(d) {
  return DIAS[d.getDay()] + " " + p2(d.getDate()) + "/" + p2(d.getMonth() + 1) + " " + hhmmss(d);
}

function rel(p) {
  return path.relative(RAIZ, p).replace(/\\/g, "/");
}

/**
 * Segundos en los que se escribieron tantos archivos que no puede haber sido
 * una edición. Se devuelven para excluirlos del análisis de orden.
 */
function segundosEnLote(dirs) {
  const cuenta = new Map();
  const raices = dirs && dirs.length ? dirs : ["src", "app", "lib", "public", "database", "docs", "_output", "test", "tests"];
  const rec = (dir) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (IGNORA.has(it.name) || it.name.startsWith(".")) continue;
      const q = path.join(dir, it.name);
      if (it.isDirectory()) { rec(q); continue; }
      if (!EXT.test(it.name)) continue;
      try {
        const k = Math.floor(fs.statSync(q).mtime.getTime() / 1000);
        cuenta.set(k, (cuenta.get(k) || 0) + 1);
      } catch { /* ignorar */ }
    }
  };
  for (const r of raices) {
    const d = path.join(RAIZ, r);
    if (fs.existsSync(d)) rec(d);
  }
  const lotes = new Map();
  for (const [k, n] of cuenta) if (n >= LOTE_MIN_ARCHIVOS) lotes.set(k, n);
  return lotes;
}

/* ─────────────────────────── fuentes de eventos ─────────────────────────── */

/** Fechas de modificación del disco. Cero instrumentación: ya están ahí. */
function eventosDisco(desde, hasta, dirs) {
  const out = [];
  const raices = dirs && dirs.length ? dirs : ["src", "app", "lib", "public", "database", "docs", "_output", "test", "tests"];
  const recorrer = (dir) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (IGNORA.has(it.name) || it.name.startsWith(".")) continue;
      const p = path.join(dir, it.name);
      if (it.isDirectory()) { recorrer(p); continue; }
      if (!EXT.test(it.name)) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.mtime >= desde && st.mtime <= hasta) {
        out.push({ t: st.mtime, tipo: "archivo", que: rel(p), detalle: "" });
      }
    }
  };
  for (const r of raices) {
    const d = path.join(RAIZ, r);
    if (fs.existsSync(d)) recorrer(d);
  }
  return out;
}

/** Eventos ya registrados en memoria.db. Más de mil filas esperando lectura. */
function eventosDB(desde, hasta) {
  const db = abrirDB();
  if (!db) return { eventos: [], aviso: "memoria.db no disponible — solo fuentes de disco" };
  const out = [];
  const push = (t, tipo, que, detalle) => {
    const d = fechaDB(t);
    if (d && d >= desde && d <= hasta) out.push({ t: d, tipo, que, detalle: detalle || "" });
  };
  const safe = (fn) => { try { fn(); } catch { /* fuente ausente: se ignora */ } };

  safe(() => {
    for (const r of db.prepare("SELECT ts, gate, verdict, file FROM gate_events").all()) {
      push(r.ts, "gate", r.gate + " → " + r.verdict, r.file || "");
    }
  });
  safe(() => {
    for (const r of db.prepare("SELECT fecha_inicio, fecha_fin, tarea, modulo, duracion_ms FROM ciclos").all()) {
      push(r.fecha_inicio, "ciclo-inicio", (r.tarea || "").slice(0, 60), r.modulo || "");
      push(r.fecha_fin, "ciclo-fin", (r.tarea || "").slice(0, 60), dur(r.duracion_ms));
    }
  });
  safe(() => {
    for (const r of db.prepare("SELECT fecha_creacion, tipo, titulo, confianza FROM nodos").all()) {
      push(r.fecha_creacion, "memoria", (r.tipo || "?") + ": " + String(r.titulo || "").slice(0, 55), r.confianza || "");
    }
  });
  safe(() => {
    for (const r of db.prepare("SELECT fecha, tipo, resumen FROM episodios").all()) {
      push(r.fecha, "episodio", (r.tipo || "") + " " + String(r.resumen || "").slice(0, 50), "");
    }
  });
  safe(() => {
    for (const r of db.prepare("SELECT fecha_inicio, fecha_fin, nombre, estado FROM fases").all()) {
      push(r.fecha_fin || r.fecha_inicio, "fase", String(r.nombre || "").slice(0, 50), r.estado || "");
    }
  });
  return { eventos: out, aviso: null };
}

/* ─────────────────────────── ventana ─────────────────────────── */

/**
 * Acepta varias formas, porque el trabajo se reparte en días:
 *   "11:30"                  → esa hora, hoy
 *   "2026-08-30"             → todo ese día
 *   "2026-08-30 11:30"       → ese momento exacto
 *   "-3d"                    → hace 3 días
 *   "ayer"                   → el día anterior completo
 */
function parseMomento(txt, finDeDia) {
  const ahora = new Date();
  if (!txt) {
    const d = new Date(ahora);
    d.setHours(finDeDia ? 23 : 0, finDeDia ? 59 : 0, finDeDia ? 59 : 0, 0);
    return d;
  }
  const t = String(txt).trim().toLowerCase();

  let m = t.match(/^-(\d+)d$/);
  if (m) {
    const d = new Date(ahora);
    d.setDate(d.getDate() - Number(m[1]));
    d.setHours(finDeDia ? 23 : 0, finDeDia ? 59 : 0, finDeDia ? 59 : 0, 0);
    return d;
  }
  if (t === "ayer") {
    const d = new Date(ahora);
    d.setDate(d.getDate() - 1);
    d.setHours(finDeDia ? 23 : 0, finDeDia ? 59 : 0, finDeDia ? 59 : 0, 0);
    return d;
  }
  if (t === "hoy") {
    const d = new Date(ahora);
    d.setHours(finDeDia ? 23 : 0, finDeDia ? 59 : 0, finDeDia ? 59 : 0, 0);
    return d;
  }
  m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const d = new Date(ahora);
    d.setHours(+m[1], +m[2], finDeDia ? 59 : 0, 0);
    return d;
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], finDeDia ? 23 : 0, finDeDia ? 59 : 0, finDeDia ? 59 : 0, 0);
    return d;
  }
  const d = new Date(t.replace(" ", "T"));
  return isNaN(d) ? new Date(ahora) : d;
}
const parseHora = (txt, _base, fin) => parseMomento(txt, fin);

function cmdVentana(args) {
  const hoy = new Date();
  const desde = parseHora(args[0], hoy, false);
  const hasta = parseHora(args[1], hoy, true);
  const dirs = args.slice(2);

  const disco = eventosDisco(desde, hasta, dirs);
  const { eventos: db, aviso } = eventosDB(desde, hasta);
  const todo = [...disco, ...db].sort((a, b) => a.t - b.t);

  console.log("");
  const abarca = diasQueAbarca(desde, hasta);
  console.log(abarca > 1
    ? "  LÍNEA DE TIEMPO · " + ymd(desde) + " " + hhmm(desde) + " → " + ymd(hasta) + " " + hhmm(hasta) + "  (" + abarca + " días)"
    : "  LÍNEA DE TIEMPO · " + ymd(desde) + " · " + hhmm(desde) + " → " + hhmm(hasta));
  console.log("  " + todo.length + " eventos (" + disco.length + " de disco, " + db.length + " de memoria.db)");
  if (aviso) console.log("  ⚠ " + aviso);
  console.log("");

  if (!todo.length) {
    console.log("  (sin eventos en esa ventana)");
    console.log("");
    return;
  }

  const icono = {
    archivo: "·", gate: "▣", "ciclo-inicio": "▶", "ciclo-fin": "■",
    memoria: "◆", episodio: "○", fase: "◈"
  };

  let minuto = null;
  let dia = null;
  for (const e of todo) {
    if (abarca > 1) {
      const dd = ymd(e.t);
      if (dd !== dia) {
        console.log("");
        console.log("  ══ " + DIAS[e.t.getDay()] + " " + dd + " ══");
        dia = dd; minuto = null;
      }
    }
    const m = hhmm(e.t);
    if (m !== minuto) { console.log("  ┌─ " + m); minuto = m; }
    const ic = icono[e.tipo] || "·";
    const det = e.detalle ? "   (" + String(e.detalle).slice(0, 40) + ")" : "";
    console.log("  │ " + ic + " :" + p2(e.t.getSeconds()) + "  " + e.que + det);
  }
  console.log("");
  console.log("  ▶ inicio de ciclo  ■ fin  ▣ gate  ◆ memoria KDD  ◈ fase  ○ episodio  · archivo");
  console.log("");
}

/* ─────────────────────── detectores de orden invertido ─────────────────── */

/**
 * Una familia de defectos son "algo hecho en el orden equivocado". Son
 * invisibles al análisis estático porque cada pieza, mirada sola, es correcta.
 * Estos detectores no entienden el código: solo comparan cuándo se escribió qué.
 */
function cmdOrden(args) {
  // Por defecto solo mira lo reciente. Un archivo compartido que cambió hace
  // una semana deja "viejas" a las 40 vistas que lo referencian: cierto, pero
  // inútil como aviso. Lo accionable es "¿en esta sesión olvidé subir algo?".
  const todo = args.includes("--todo");
  const horas = Number((args.find((a) => /^--horas=/.test(a)) || "").split("=")[1]) || 12;
  const corte = todo ? 0 : Date.now() - horas * 3600 * 1000;

  console.log("");
  console.log("  ORDEN INVERTIDO — defectos que solo se ven comparando fechas");
  console.log(todo
    ? "  alcance: TODO el historial"
    : "  alcance: últimas " + horas + "h  (usa --todo para el historial completo)");
  console.log("");

  const lotes = segundosEnLote();
  const enLote = (d) => lotes.has(Math.floor(d.getTime() / 1000));
  if (lotes.size) {
    let tot = 0;
    for (const n of lotes.values()) tot += n;
    console.log("  ℹ " + lotes.size + " momento(s) con escritura en lote (" + tot +
      " archivos) se excluyen: son copias o sincronizaciones, no ediciones.");
    console.log("");
  }

  const hallazgos = [];

  /* ── 1 · Versión de caché vieja (el caso H-09) ── */
  const vistas = [];
  const buscarVistas = (dir) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (IGNORA.has(it.name) || it.name.startsWith(".")) continue;
      const q = path.join(dir, it.name);
      if (it.isDirectory()) { buscarVistas(q); continue; }
      if (/\.(html|tsx|jsx)$/i.test(it.name)) vistas.push(q);
    }
  };
  for (const r of ["public", "src", "app", "views", "templates"]) {
    const d = path.join(RAIZ, r);
    if (fs.existsSync(d)) buscarVistas(d);
  }

  const indice = new Map();
  const indexar = (dir) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (IGNORA.has(it.name) || it.name.startsWith(".")) continue;
      const q = path.join(dir, it.name);
      if (it.isDirectory()) { indexar(q); continue; }
      if (/\.(js|css|mjs|cjs)$/i.test(it.name) && !indice.has(it.name)) indice.set(it.name, q);
    }
  };
  for (const r of ["public", "src", "app", "assets", "static"]) {
    const d = path.join(RAIZ, r);
    if (fs.existsSync(d)) indexar(d);
  }

  // Se agrupa POR ARCHIVO, no por vista: si un compartido cambió y hay 40
  // vistas afectadas, es UN problema con 40 síntomas, no 40 problemas.
  const porArchivo = new Map();

  for (const v of vistas) {
    let html = "";
    try { html = fs.readFileSync(v, "utf8"); } catch { continue; }
    let stV;
    try { stV = fs.statSync(v); } catch { continue; }
    const vistos = new Set();
    for (const [, archivo, ver] of html.matchAll(/([\w.-]+\.(?:js|css))\?v=([\w.-]+)/gi)) {
      const clave = archivo + "|" + ver;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      const destino = indice.get(archivo);
      if (!destino) continue;
      let stA;
      try { stA = fs.statSync(destino); } catch { continue; }
      const desfase = stA.mtime - stV.mtime;
      if (desfase <= TOLERANCIA_MS) continue;
      if (stA.mtime.getTime() < corte) continue; // cambió hace mucho: no es de ahora
      if (enLote(stA.mtime) || enLote(stV.mtime)) continue; // fecha de lote: no es una edición
      if (!porArchivo.has(archivo)) {
        porArchivo.set(archivo, { archivo, cambio: stA.mtime, vistas: [] });
      }
      porArchivo.get(archivo).vistas.push({ vista: rel(v), ver, fijada: stV.mtime, desfase });
    }
  }

  for (const g of [...porArchivo.values()].sort((a, b) => b.cambio - a.cambio)) {
    g.vistas.sort((a, b) => b.desfase - a.desfase);
    hallazgos.push({
      tipo: "caché vieja",
      msg: g.archivo + " cambió a las " + sello(g.cambio, true) + " y " + g.vistas.length +
           " vista(s) siguen fijando una versión anterior:\n" +
           g.vistas.slice(0, 6).map((x) =>
             "        · " + x.vista + "  → ?v=" + x.ver + " (fijada " + sello(x.fijada, x.desfase > 86400000) + ")"
           ).join("\n") +
           (g.vistas.length > 6 ? "\n        · … y " + (g.vistas.length - 6) + " más" : ""),
      por: "Quien tenga esas versiones en caché recibe el archivo anterior. Subir el ?v=."
    });
  }

  /* ── 2 · Migración editada después de su verificador ── */
  const migDir = [path.join(RAIZ, "database"), path.join(RAIZ, "migrations"), path.join(RAIZ, "db")]
    .find((d) => fs.existsSync(d));
  if (migDir) {
    const migs = [];
    const rec = (dir) => {
      let items;
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        const q = path.join(dir, it.name);
        if (it.isDirectory()) { rec(q); continue; }
        if (/\.sql$/i.test(it.name)) migs.push(q);
      }
    };
    rec(migDir);
    for (const m of migs) {
      const base = path.basename(m);
      if (/VERIFICAR|verify/i.test(base)) continue;
      // El número debe coincidir EXACTO: "00" no empareja con "003b".
      const num = base.match(/^(\d+)(?=[^\d])/);
      if (!num) continue;
      const ver = migs.find((x) => {
        const b = path.basename(x);
        const bn = b.match(/^(\d+)(?=[^\d])/);
        return bn && bn[1] === num[1] && /VERIFICAR|verify/i.test(b);
      });
      if (!ver) continue;
      try {
        const a = fs.statSync(m).mtime, b = fs.statSync(ver).mtime;
        if (a - b > TOLERANCIA_MS && a.getTime() >= corte && !enLote(a) && !enLote(b)) {
          hallazgos.push({
            tipo: "migración editada tras su verificador",
            msg: base + " cambió a las " + hhmmss(a) + ", " + dur(a - b) + " después de " +
                 path.basename(ver) + " (" + hhmmss(b) + ")",
            por: "El verificador puede no cubrir lo último que se añadió a la migración."
          });
        }
      } catch { /* ignorar */ }
    }
  }

  if (!hallazgos.length) {
    console.log("  ✅ ninguno — no se detectaron órdenes invertidos");
    console.log("");
    return 0;
  }

  for (const h of hallazgos) {
    console.log("  ⚠ " + h.tipo);
    console.log("     " + h.msg);
    console.log("     → " + h.por);
    console.log("");
  }
  console.log("  " + hallazgos.length + " hallazgo(s)");
  console.log("");
  return hallazgos.length;
}

/* ─────────────────────── medir tareas ─────────────────────── */

/**
 * Medición de tareas.
 *
 * Un dev no trabaja del tirón hasta terminar: trabaja en tandas de horas a lo
 * largo de varios días. Por eso se guardan SESIONES, no solo inicio y fin.
 *
 * Y se reportan dos números distintos, porque confundirlos engaña:
 *   · TRANSCURRIDO — del primer arranque al último cierre (tiempo de calendario)
 *   · TRABAJADO    — la suma de las sesiones reales
 * Una tarea abierta el lunes y cerrada el jueves puede haber sido 4h de trabajo.
 * Decir "3 días" sería falso; decir "4h en 3 días" es la verdad.
 */

/**
 * Quién está midiendo. Dos agentes en la misma carpeta comparten el archivo de
 * marca, así que sin esto el arranque de uno cierra la tarea del otro.
 *   --actor=<x>  →  $AKDD_ACTOR  →  "default"
 */
function actorDe(args) {
  const f = (args || []).find((a) => String(a).startsWith("--actor="));
  if (f) return f.slice(8).trim() || "default";
  return (process.env.AKDD_ACTOR || "default").trim() || "default";
}

/**
 * La parcela de un actor dentro de la marca compartida.
 * Migra el formato antiguo (lote/abierta sueltos) la primera vez que se lee.
 */
function parcela(marca, actor) {
  const m = marca && typeof marca === "object" ? marca : {};
  if (!m.actores) {
    m.actores = {};
    // Formato viejo: lo que hubiera pasa a ser de quien lo lea primero.
    if (m.lote || m.abierta) {
      m.actores[actor] = { lote: m.lote || [], abierta: m.abierta || null };
      delete m.lote; delete m.abierta;
    }
  }
  if (!m.actores[actor]) m.actores[actor] = { lote: [], abierta: null };
  return m;
}

function leerMarca() {
  try { return JSON.parse(fs.readFileSync(MARCA, "utf8")); } catch { return null; }
}
function escribirMarca(marca) {
  try {
    fs.mkdirSync(path.dirname(MARCA), { recursive: true });
    fs.writeFileSync(MARCA, JSON.stringify(marca, null, 2), "utf8");
    return true;
  } catch (e) {
    console.log("  ⚠ no se pudo escribir la marca: " + e.message);
    return false;
  }
}

/** Suma de sesiones cerradas + la abierta si la hay. */
function trabajado(t, hasta) {
  let ms = 0;
  for (const s of t.sesiones || []) {
    if (s.fin) ms += new Date(s.fin) - new Date(s.inicio);
    else if (hasta) ms += hasta - new Date(s.inicio);
  }
  return ms;
}
function primerInicio(t) {
  const ss = t.sesiones || [];
  return ss.length ? new Date(ss[0].inicio) : null;
}

function cmdInicio(args) {
  const tarea = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  const actor = actorDe(args);
  const marca = parcela(leerMarca() || {}, actor);
  const m = marca.actores[actor];

  // Retomar la misma tarea: nueva sesión, no tarea nueva
  if (!tarea && m.abierta) {
    const t = m.abierta;
    const ss = t.sesiones || [];
    if (ss.length && !ss[ss.length - 1].fin) {
      console.log("  ℹ ya hay una sesión abierta en \"" + t.tarea + "\" desde " +
        selloCompleto(new Date(ss[ss.length - 1].inicio)));
      return;
    }
    ss.push({ inicio: new Date().toISOString(), fin: null });
    t.sesiones = ss;
    if (escribirMarca(marca)) {
      console.log("  ▶ sesión " + ss.length + " de \"" + t.tarea + "\" · " + selloCompleto(new Date()));
    }
    return;
  }

  if (!tarea) {
    console.log("  uso: linea-tiempo.cjs inicio \"<descripción de la tarea>\"");
    console.log("       (sin texto, retoma la tarea abierta en una sesión nueva)");
    return;
  }

  // Había otra tarea abierta: se cierra y pasa al lote
  if (m.abierta) {
    const t = m.abierta;
    const ss = t.sesiones || [];
    if (ss.length && !ss[ss.length - 1].fin) ss[ss.length - 1].fin = new Date().toISOString();
    t.cerradaAuto = true;
    m.lote.push(t);
    console.log("  ⚠ \"" + t.tarea + "\" estaba abierta: se cierra y se añade al lote.");
  }

  m.abierta = { tarea, sesiones: [{ inicio: new Date().toISOString(), fin: null }] };
  if (escribirMarca(marca)) {
    console.log("  ▶ tarea iniciada · " + selloCompleto(new Date()) + " · " + tarea);
  }
}

function cmdPausa(args) {
  const actor = actorDe(args);
  const marca = parcela(leerMarca() || {}, actor);
  const m = marca.actores[actor];
  if (!m || !m.abierta) { console.log("  ⚠ no hay tarea abierta"); return; }
  const ss = m.abierta.sesiones || [];
  const ult = ss[ss.length - 1];
  if (!ult || ult.fin) { console.log("  ℹ no hay sesión abierta que pausar"); return; }
  ult.fin = new Date().toISOString();
  if (escribirMarca(marca)) {
    console.log("  ⏸ sesión pausada · " + selloCompleto(new Date()) +
      " · llevas " + dur(trabajado(m.abierta)) + " trabajados en \"" + m.abierta.tarea + "\"");
    console.log("     para retomar:  linea-tiempo.cjs inicio");
  }
}

function cmdFin(args) {
  const actor = actorDe(args);
  const marca = parcela(leerMarca() || {}, actor);
  const m = marca.actores[actor];
  if (!m || !m.abierta) {
    console.log("  ⚠ no hay tarea abierta. Usa: linea-tiempo.cjs inicio \"<tarea>\"");
    return;
  }
  const parcial = args.includes("--parcial");
  const ahora = new Date();
  const t = m.abierta;
  const ss = t.sesiones || [];
  if (ss.length && !ss[ss.length - 1].fin) ss[ss.length - 1].fin = ahora.toISOString();
  t.parcial = parcial;

  const lote = [...(m.lote || []), t];
  console.log("");

  if (lote.length === 1) {
    reportarUna(t);
  } else {
    reportarLote(lote);
  }

  // Se borra solo la parcela propia: otro agente puede tener la suya abierta.
  delete marca.actores[actor];
  if (Object.keys(marca.actores).length === 0) {
    try { fs.unlinkSync(MARCA); } catch { /* ya no está */ }
  } else {
    escribirMarca(marca);
    console.log("  ℹ otras mediciones siguen abiertas: " +
      Object.keys(marca.actores).join(", "));
    console.log("");
  }
}

function reportarUna(t) {
  const a = primerInicio(t);
  const ss = t.sesiones || [];
  const b = new Date(ss[ss.length - 1].fin);
  const transc = b - a;
  const trab = trabajado(t);
  const dias = diasQueAbarca(a, b);

  console.log("  ⏱  " + t.tarea);
  console.log("");
  console.log("     inicio    " + selloCompleto(a));
  console.log("     fin       " + selloCompleto(b));
  if (dias > 1 || ss.length > 1) {
    console.log("     sesiones  " + ss.length + " en " + dias + " día(s)");
    console.log("");
    for (const [i, x] of ss.entries()) {
      const xa = new Date(x.inicio), xb = new Date(x.fin);
      console.log("       " + (i + 1) + ". " + selloCompleto(xa) + " → " + hhmmss(xb) + "   " + dur(xb - xa));
    }
    console.log("");
    console.log("     TRABAJADO     " + dur(trab));
    console.log("     transcurrido  " + dur(transc) + "   (incluye noches y pausas)");
  } else {
    console.log("     duración  " + dur(trab));
  }
  if (t.parcial) {
    console.log("");
    console.log("     ⚠ PARCIAL — se paró a medias, no cuenta como tarea completa");
  }
  console.log("");
}

function reportarLote(lote) {
  console.log("  ⏱  RESUMEN · " + lote.length + " tareas");
  console.log("");
  const anchoT = Math.min(46, Math.max(14, ...lote.map((x) => x.tarea.length)));
  console.log("  " + "Tarea".padEnd(anchoT) + " │ Desde              │ Hasta              │ Trabajado │ Ses.");
  console.log("  " + "─".repeat(anchoT) + "─┼────────────────────┼────────────────────┼───────────┼─────");

  let total = 0, parciales = 0, minA = null, maxB = null;
  for (const x of lote) {
    const a = primerInicio(x);
    const ss = x.sesiones || [];
    const b = ss.length && ss[ss.length - 1].fin ? new Date(ss[ss.length - 1].fin) : null;
    if (!a || !b) continue;
    const trab = trabajado(x);
    // Se acumula lo YA redondeado a la unidad que imprime la fila: así el total
    // de abajo es la suma de lo que se ve arriba, no otro número parecido.
    if (x.parcial) parciales++; else total += cuantizar(trab);
    if (!minA || a < minA) minA = a;
    if (!maxB || b > maxB) maxB = b;
    console.log("  " + x.tarea.slice(0, anchoT).padEnd(anchoT) + " │ " +
      selloCompleto(a).padEnd(18) + " │ " + selloCompleto(b).padEnd(18) + " │ " +
      dur(trab).padStart(9) + " │ " + String(ss.length).padStart(4) +
      (x.parcial ? "  (parcial)" : ""));
  }
  console.log("  " + "─".repeat(anchoT) + "─┴────────────────────┴────────────────────┴───────────┴─────");
  console.log("  " + "TOTAL TRABAJADO".padEnd(anchoT) + " │                    │                    │ " + dur(total).padStart(9));
  if (minA && maxB) {
    const dias = diasQueAbarca(minA, maxB);
    console.log("  " + ("transcurrido: " + dur(maxB - minA)).padEnd(anchoT) + " │  " + dias + " día(s) de calendario");
  }
  console.log("");
  console.log("  El total suma solo tareas completas.");
  if (parciales) {
    console.log("  " + parciales + " parcial(es) se listan pero no cuentan: una tarea que se paró");
    console.log("  a medias no mide nada útil.");
  }
  console.log("");
}

/**
 * Tiempos de un módulo o de lo que coincida con un texto.
 *
 * El caso real: cuatro módulos repartidos entre cuatro devs. Tres entregaron,
 * uno no. La pregunta útil no es quién —eso ya se sabe por el reparto— sino
 * cuánto costó y dónde se atascó.
 *
 * Busca primero por módulo/área exacta; si no hay nada, por texto de la tarea.
 * Así `tiempos compras` y `tiempos cotizacion` funcionan los dos sin que
 * nadie tenga que saber cuál de las dos cosas es.
 */
/**
 * Comparación entre módulos — la vista de "tres entregaron y uno no".
 *
 * Cuando cada módulo lo lleva un dev distinto, poner los módulos en la misma
 * tabla es lo que hace visible dónde está el atasco. Se ordena por ciclos,
 * porque el número de vueltas es lo que más habla cuando no hay duraciones.
 *
 * Deliberadamente NO calcula un ranking ni marca a nadie: muestra las columnas
 * y deja la lectura a quien conoce el reparto y el alcance de cada módulo. Un
 * módulo con el triple de ciclos puede ser el triple de grande.
 */
function compararModulos() {
  const db = abrirDB();
  if (!db) { console.log("  ⚠ memoria.db no disponible"); return; }
  let filas = [];
  try {
    filas = db.prepare(
      "SELECT IFNULL(NULLIF(modulo,''),'(sin módulo)') m, COUNT(*) ciclos, " +
      "       SUM(CASE WHEN duracion_ms > 0 THEN 1 ELSE 0 END) con_dur, " +
      "       SUM(CASE WHEN duracion_ms > 0 THEN duracion_ms ELSE 0 END) ms, " +
      "       SUM(stops_count) stops, MAX(tests_pasando) tests, " +
      "       MIN(fecha_fin) desde, MAX(fecha_fin) hasta " +
      "FROM ciclos GROUP BY m ORDER BY ciclos DESC"
    ).all();
  } catch (e) { console.log("  ⚠ " + e.message); return; }

  if (!filas.length) { console.log("  Sin ciclos registrados todavía."); return; }

  console.log("");
  console.log("  TIEMPOS POR MÓDULO");
  console.log("");
  const a = 22;
  console.log("  " + "Módulo".padEnd(a) + " │ Ciclos │ Días │ STOP │ Tests │ Trabajado");
  console.log("  " + "─".repeat(a) + "─┼────────┼──────┼──────┼───────┼──────────");
  let sinDatoAlguno = 0;
  for (const f of filas) {
    const d1 = fechaDB(f.desde), d2 = fechaDB(f.hasta);
    const dias = d1 && d2 ? diasQueAbarca(d1, d2) : 0;
    const trab = f.con_dur > 0 ? dur(f.ms) : "—";
    if (!f.con_dur) sinDatoAlguno++;
    console.log("  " + String(f.m).slice(0, a).padEnd(a) + " │ " +
      String(f.ciclos).padStart(6) + " │ " + String(dias || "—").padStart(4) + " │ " +
      String(f.stops || 0).padStart(4) + " │ " + String(f.tests ?? "—").padStart(5) + " │ " +
      trab.padStart(9));
  }
  console.log("");
  console.log("  Cómo leer esto: los ciclos son las vueltas que dio el módulo, los días");
  console.log("  el calendario que abarcó, y los STOP las veces que un gate lo frenó.");
  console.log("  Un módulo con muchos ciclos puede ser simplemente más grande — la tabla");
  console.log("  no dice quién va lento, dice dónde mirar.");
  console.log("");
  if (sinDatoAlguno) {
    console.log("  ⚠ " + sinDatoAlguno + " módulo(s) sin ninguna duración: sus ciclos se cerraron antes");
    console.log("     de que existiera la medición. Ciclos, días y STOPs sí son completos.");
    console.log("");
  }
  console.log("  Detalle de uno:  linea-tiempo.cjs tiempos <módulo>");
  console.log("");
}

/**
 * Minúsculas y sin tildes, para comparar texto escrito por personas.
 * "Requisición" y "requisicion" son la misma palabra para quien pregunta.
 */
function sinTildes(x) {
  return String(x == null ? "" : x)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Ciclos cuya duración se rescató a mano. Se consultan aparte para poder
 * marcarlos: un número medido por una persona no puede presentarse igual que uno
 * medido por la máquina.
 */
function ciclosRescatados(db) {
  const set = new Set();
  try {
    for (const r of db.prepare(
      "SELECT cycle_hint FROM gate_events WHERE gate = 'BACKFILL_TIEMPO'"
    ).all()) if (r.cycle_hint) set.add(String(r.cycle_hint));
  } catch { /* sin libreta: no se marca nada */ }
  return set;
}

/**
 * Rescata una medición hecha fuera de la herramienta.
 *
 *   backfill --ciclo="<texto de la tarea>" --desde="2026-08-30 10:50:17" \
 *            --hasta="2026-08-30 11:04:16" --motivo="doc 25, cronometrado a mano"
 *
 * Sin --aplicar solo muestra qué haría. Sin --motivo no hace nada: un número sin
 * procedencia no entra en la base.
 */
function cmdBackfill(args) {
  const arg = (n) => {
    const f = args.find((a) => a.startsWith("--" + n + "="));
    return f ? f.slice(n.length + 3).trim() : "";
  };
  const texto = arg("ciclo"), desde = arg("desde"), hasta = arg("hasta");
  const motivo = arg("motivo"), aplicar = args.includes("--aplicar");

  if (!texto || !desde || !hasta) {
    console.log("  uso: linea-tiempo.cjs backfill --ciclo=\"<texto>\" --desde=\"YYYY-MM-DD HH:MM:SS\" \\");
    console.log("                                 --hasta=\"YYYY-MM-DD HH:MM:SS\" --motivo=\"<de dónde salió>\" [--aplicar]");
    console.log("");
    console.log("  Sin --aplicar solo muestra qué haría.");
    return;
  }
  if (!motivo) {
    console.log("  ⚠ falta --motivo. Un número sin procedencia no entra en la base:");
    console.log("     quien lea el reporte tiene que poder saber de dónde salió.");
    return;
  }

  const db = abrirDB(false);
  if (!db) { console.log("  ⚠ memoria.db no disponible para escritura"); return; }

  let filas = [];
  try {
    const todos = db.prepare("SELECT id, ciclo_id, tarea, fecha_inicio, fecha_fin, duracion_ms FROM ciclos ORDER BY id").all();
    const n = sinTildes(texto);
    filas = todos.filter((c) => sinTildes(c.tarea).includes(n));
  } catch (e) { console.log("  ⚠ " + e.message); return; }

  if (!filas.length) { console.log("  ⚠ ningún ciclo coincide con \"" + texto + "\""); return; }
  if (filas.length > 1) {
    console.log("  ⚠ \"" + texto + "\" coincide con " + filas.length + " ciclos. Afina el texto:");
    for (const f of filas) console.log("     · " + String(f.tarea).slice(0, 70));
    return;
  }

  const c = filas[0];
  // Las fechas se guardan en UTC, como datetime('now') de SQLite.
  const a = new Date(String(desde).replace(" ", "T")), b = new Date(String(hasta).replace(" ", "T"));
  if (isNaN(a) || isNaN(b)) { console.log("  ⚠ fechas no válidas (formato: YYYY-MM-DD HH:MM:SS)"); return; }
  if (b <= a) { console.log("  ⚠ el fin no puede ser anterior al inicio"); return; }
  const ms = b - a;
  const utc = (d) => d.toISOString().replace("T", " ").slice(0, 19);

  console.log("");
  console.log("  " + String(c.tarea).slice(0, 66));
  console.log("     antes    " + (c.duracion_ms > 0 ? dur(c.duracion_ms) : "sin duración"));
  console.log("     después  " + dur(ms) + "   (" + selloCompleto(a) + " → " + selloCompleto(b) + ")");
  console.log("     motivo   " + motivo);
  console.log("");

  if (!aplicar) { console.log("  (simulación — añade --aplicar para escribirlo)"); console.log(""); return; }

  try {
    db.prepare("UPDATE ciclos SET fecha_inicio = ?, fecha_fin = ?, duracion_ms = ? WHERE id = ?")
      .run(utc(a), utc(b), ms, c.id);
    // El rastro: sin esto, mañana nadie sabe que este número lo puso una persona.
    db.prepare(
      "INSERT INTO gate_events (ts, gate, verdict, detalle, cycle_hint, source) " +
      "VALUES (datetime('now'), 'BACKFILL_TIEMPO', 'OK', ?, ?, 'manual')"
    ).run(motivo, String(c.ciclo_id));
    console.log("  ✅ rescatado. Saldrá marcado con * en las tablas.");
  } catch (e) { console.log("  ⚠ " + e.message); }
  console.log("");
}

function cmdTiempos(args) {
  const q = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  // Sin argumento, la pregunta suele ser "¿cómo va cada módulo?" — no "cómo se usa esto".
  if (!q) { compararModulos(); return; }
  const db = abrirDB();
  if (!db) { console.log("  ⚠ memoria.db no disponible"); return; }

  const COLS = "ciclo_id, tarea, modulo, area, fecha_inicio, fecha_fin, duracion_ms, " +
               "tests_pasando, stops_count, review_blockers";
  // Se trae todo y se filtra aquí: SQLite no ignora tildes en LIKE, y la tabla
  // de ciclos es lo bastante pequeña como para que no importe.
  let filas = [], porTexto = false;
  try {
    const todos = db.prepare("SELECT " + COLS + " FROM ciclos ORDER BY id").all();
    const n = sinTildes(q);
    filas = todos.filter((c) => sinTildes(c.modulo) === n || sinTildes(c.area) === n);
    if (!filas.length) {
      porTexto = true;
      filas = todos.filter((c) => sinTildes(c.tarea).includes(n));
    }
  } catch (e) { console.log("  ⚠ " + e.message); return; }

  console.log("");
  if (!filas.length) {
    console.log("  Sin ciclos para \"" + q + "\" — ni como módulo ni en el texto de las tareas.");
    console.log("");
    console.log("  Módulos con ciclos registrados:");
    try {
      for (const r of db.prepare(
        "SELECT IFNULL(NULLIF(modulo,''),'(sin módulo)') m, COUNT(*) n FROM ciclos GROUP BY m ORDER BY n DESC LIMIT 10"
      ).all()) console.log("    " + String(r.n).padStart(4) + "  " + r.m);
    } catch { /* ignorar */ }
    console.log("");
    return;
  }

  const rescatados = ciclosRescatados(db);
  console.log("  TIEMPOS · " + q + (porTexto ? "  (coincidencia en el texto de la tarea)" : "  (módulo)"));
  console.log("");

  const anchoT = 44;
  console.log("  " + "Tarea".padEnd(anchoT) + " │ Cerrado          │   Duración  │ Tests │ STOP");
  console.log("  " + "─".repeat(anchoT) + "─┼──────────────────┼─────────────┼───────┼─────");

  let conDur = 0, sinDur = 0, totalMs = 0, stops = 0, blockers = 0, hayRescate = false;
  let minA = null, maxB = null;

  for (const f of filas) {
    const a = fechaDB(f.fecha_inicio), b = fechaDB(f.fecha_fin);
    let d = "—";
    const ms = f.duracion_ms > 0 ? f.duracion_ms : (a && b ? b - a : 0);
    // Una duración real necesita que el arranque se haya marcado. Los ciclos
    // viejos tienen inicio = fin y valen 0: se cuentan aparte, no como "0 min".
    if (ms > 0) { conDur++; totalMs += cuantizar(ms); d = dur(ms); } else sinDur++;
    // El asterisco: lo midió una persona, no la máquina. La distinción no se pierde.
    const rescatado = rescatados.has(String(f.ciclo_id));
    if (rescatado) { d = "*" + d; hayRescate = true; }
    stops += Number(f.stops_count || 0);
    blockers += Number(f.review_blockers || 0);
    if (b) { if (!minA || (a || b) < minA) minA = a || b; if (!maxB || b > maxB) maxB = b; }
    console.log("  " + String(f.tarea || "").slice(0, anchoT).padEnd(anchoT) + " │ " +
      (b ? selloCompleto(b).padEnd(16) : "?".padEnd(16)) + " │ " + d.padStart(11) + " │ " +
      String(f.tests_pasando ?? "—").padStart(5) + " │ " + String(f.stops_count ?? 0).padStart(4));
  }
  console.log("  " + "─".repeat(anchoT) + "─┴──────────────────┴─────────────┴───────┴─────");
  console.log("");

  console.log("  ciclos          " + filas.length);
  if (minA && maxB) {
    console.log("  desde / hasta   " + selloCompleto(minA) + "  →  " + selloCompleto(maxB));
    console.log("  abarca          " + diasQueAbarca(minA, maxB) + " día(s) de calendario");
  }
  if (conDur) console.log("  TRABAJADO       " + dur(totalMs) + "   (sobre " + conDur + " de " + filas.length + " ciclos)");
  console.log("  STOPs            " + stops + (blockers ? "   ·  bloqueos de review: " + blockers : ""));
  console.log("");

  // Lo que estos números no pueden decir, dicho antes de que alguien los use mal.
  if (sinDur) {
    console.log("  ⚠ " + sinDur + " de " + filas.length + " ciclos SIN duración: se cerraron antes de que");
    console.log("     existiera la medición, y su hora de arranque no se guardó en ninguna");
    console.log("     parte. No son ciclos de 0 minutos: son ciclos sin dato.");
    if (conDur) console.log("     El TRABAJADO de arriba cubre solo los " + conDur + " que sí lo tienen.");
    else console.log("     Por eso no hay un total de tiempo que mostrar.");
    console.log("");
  }
  if (hayRescate) {
    console.log("  * = duración rescatada de una medición hecha a mano, anterior a la");
    console.log("     herramienta. Es un número real, pero lo tomó una persona, no la");
    console.log("     máquina. Su procedencia está en la libreta (gate_events).");
    console.log("");
  }
  console.log("  Los ciclos y los STOPs sí son historial completo: un módulo con muchos");
  console.log("  ciclos y muchos STOPs costó más que uno con pocos, y eso se ve sin");
  console.log("  duraciones. Lo que ningún número de aquí dice es si quedó BIEN.");
  console.log("");
}

function cmdResumen(args) {
  const n = Number(args[0]) || 10;
  const db = abrirDB();
  if (!db) { console.log("  ⚠ memoria.db no disponible"); return; }
  let filas = [];
  try {
    filas = db.prepare(
      "SELECT tarea, modulo, fecha_inicio, fecha_fin, duracion_ms, tests_pasando, stops_count " +
      "FROM ciclos ORDER BY id DESC LIMIT ?"
    ).all(n);
  } catch (e) { console.log("  ⚠ " + e.message); return; }

  console.log("");
  console.log("  ÚLTIMOS " + filas.length + " CICLOS");
  console.log("");
  // Una tabla de ciclos de un solo día no necesita fecha en cada fila; una que
  // abarca varios, sí — o no se sabe si "21:31" fue hoy o el martes pasado.
  const dias = new Set();
  for (const f of filas) { const a = fechaDB(f.fecha_inicio); if (a) dias.add(ymd(a)); }
  const variosDias = dias.size > 1;

  console.log("  Tarea                                    │ Inicio   │ Fin      │ Duración │ Tests │ Stops");
  console.log("  ─────────────────────────────────────────┼──────────┼──────────┼──────────┼───────┼──────");
  let sinDuracion = 0;
  let diaActual = null;
  for (const f of filas) {
    const a = fechaDB(f.fecha_inicio), b = fechaDB(f.fecha_fin);
    let d = "—";
    // duracion_ms es el valor guardado y tiene precisión de milisegundo; las
    // fechas solo llegan al segundo. Restarlas perdía los ciclos cortos.
    const ms = f.duracion_ms > 0 ? f.duracion_ms : (a && b ? b - a : 0);
    if (ms > 0) d = dur(ms); else sinDuracion++;
    if (variosDias) {
      const dd = a ? ymd(a) : "sin fecha";
      if (dd !== diaActual) {
        console.log("  ── " + (a ? DIAS[a.getDay()] + " " + dd : dd) + " ──");
        diaActual = dd;
      }
    }
    console.log("  " + String(f.tarea || "").slice(0, 40).padEnd(40) + " │ " +
      (a ? hhmmss(a) : "  ?     ") + " │ " + (b ? hhmmss(b) : "  ?     ") + " │ " +
      d.padStart(8) + " │ " + String(f.tests_pasando ?? "—").padStart(5) + " │ " +
      String(f.stops_count ?? 0).padStart(5));
  }
  console.log("");
  if (sinDuracion) {
    console.log("  ⚠ " + sinDuracion + " ciclo(s) sin duración real: `fecha_inicio` se rellenó con la hora");
    console.log("     del cierre. Se arregla marcando el arranque con:  linea-tiempo.cjs inicio \"<tarea>\"");
    console.log("");
  }
}

function cmdCiclo(args) {
  const id = Number(args[0]);
  if (!id) { console.log("  uso: linea-tiempo.cjs ciclo <id>"); return; }
  const db = abrirDB();
  if (!db) { console.log("  ⚠ memoria.db no disponible"); return; }
  let c;
  try { c = db.prepare("SELECT * FROM ciclos WHERE id=?").get(id); } catch { }
  if (!c) { console.log("  no existe el ciclo " + id); return; }
  const a = fechaDB(c.fecha_inicio), b = fechaDB(c.fecha_fin);
  console.log("");
  console.log("  CICLO " + id + " · " + (c.tarea || ""));
  console.log("  " + (a ? hhmmss(a) : "?") + " → " + (b ? hhmmss(b) : "?") +
    (a && b && b - a > 0 ? "  (" + dur(b - a) + ")" : "  (sin duración registrada)"));
  console.log("");

  // Qué aprendió la memoria durante el ciclo: comparar los dos censos
  try {
    const si = JSON.parse(c.snapshot_inicio || "{}");
    const sf = JSON.parse(c.snapshot_fin || "{}");
    const ti = (si.totales && si.totales.total) || 0;
    const tf = (sf.totales && sf.totales.total) || 0;
    if (tf !== ti) {
      console.log("  memoria KDD: " + ti + " → " + tf + " nodos (" + (tf - ti > 0 ? "+" : "") + (tf - ti) + ")");
    } else {
      console.log("  memoria KDD: sin cambio medible (los dos censos son del mismo instante)");
    }
  } catch { /* sin snapshots */ }

  if (a && b) {
    console.log("");
    cmdVentana([hhmm(a), hhmm(b)]);
  }
}

/* ─────────────────────────── entrada ─────────────────────────── */

const [, , cmd, ...args] = process.argv;

switch ((cmd || "").toLowerCase()) {
  case "ventana": case "dia": case "día": cmdVentana(args); break;
  case "orden": cmdOrden(args); break;
  case "inicio": cmdInicio(args); break;
  case "fin": cmdFin(args); break;
  case "pausa": cmdPausa(args); break;
  case "tiempos": cmdTiempos(args); break;
  case "backfill": cmdBackfill(args); break;
  case "resumen": cmdResumen(args); break;
  case "ciclo": cmdCiclo(args); break;
  default:
    console.log("");
    console.log("  LÍNEA DE TIEMPO — Agentic KDD");
    console.log("");
    console.log("  ventana [desde] [hasta]   qué pasó en un rango (por defecto, hoy)");
    console.log("  orden                     detecta defectos de orden invertido");
    console.log("  inicio \"<tarea>\"          marca el arranque · sin texto, retoma la abierta");
    console.log("  fin [--parcial]           cierra y reporta cuánto tardó");
    console.log("  pausa                     pausa la sesión (retomar con: inicio)");
    console.log("");
    console.log("  --actor=<nombre>  separa la medición de cada agente o dev que");
    console.log("                    trabaje en la misma carpeta (o $AKDD_ACTOR).");
    console.log("                    Sin esto, el arranque de uno cierra la tarea del otro.");
    console.log("  tiempos                   compara todos los módulos entre sí");
    console.log("  backfill --ciclo=..       rescata una medición hecha fuera de la herramienta");
    console.log("  tiempos <módulo|texto>    el detalle de un módulo o un proceso");
    console.log("  resumen [n]               tabla de los últimos n ciclos");
    console.log("  ciclo <id>                qué pasó durante un ciclo");
    console.log("");
}
