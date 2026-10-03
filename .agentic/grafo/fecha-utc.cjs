'use strict';

/**
 * Un solo lector de fechas para el tablero, sus reportes y la API.
 *
 *   "2026-09-01 10:00:00"        SQLite, guardada en UTC → se le añade la Z
 *   "2026-09-01T10:00:00Z"       ISO con zona → se respeta
 *   "2026-09-01T10:00:00-04:00"  ISO con desfase → se respeta
 *   "2026-09-01"                 día → medianoche UTC
 *   cualquier otra cosa          null: "sin fecha", nunca una fecha inventada
 *
 * Se guarda en UTC; la zona solo entra al mostrar.
 */
function fechaUtc(x) {
  if (x == null || x === '') return null;
  if (typeof x === 'number') return Number.isFinite(x) ? new Date(x) : null;
  if (x instanceof Date) return Number.isNaN(x.getTime()) ? null : x;
  var s = String(x).trim();
  var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m) return null;
  if (!m[4] && m[7]) return null;
  var iso = m[4] ? s.replace(' ', 'T') : s + 'T00:00:00';
  if (!m[7]) iso += 'Z';
  var d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Date admite "31 de febrero" corriéndolo a marzo: se rechaza.
  var mes = +m[2], dia = +m[3];
  var diasMes = new Date(Date.UTC(+m[1], mes, 0)).getUTCDate();
  if (mes < 1 || mes > 12 || dia < 1 || dia > diasMes) return null;
  if (m[4] && (+m[4] > 23 || +m[5] > 59 || (m[6] && +m[6] > 59))) return null;
  return d;
}

/** Orden estable: fecha y luego id. Las filas sin fecha van al final. */
function compararPorFecha(a, b, campo) {
  var fa = fechaUtc(a[campo]), fb = fechaUtc(b[campo]);
  var ta = fa ? fa.getTime() : Infinity, tb = fb ? fb.getTime() : Infinity;
  if (ta !== tb) return ta < tb ? -1 : 1;
  var na = Number(a.id), nb = Number(b.id);
  if (a.id != null && b.id != null && isFinite(na) && isFinite(nb)) return na - nb;
  var ia = a.id == null ? '' : String(a.id), ib = b.id == null ? '' : String(b.id);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** Año-mes-día del instante en esa zona (undefined = la del sistema). */
function diaEnZona(d, zona) {
  if (!d) return null;
  var p = new Intl.DateTimeFormat('en-CA', { timeZone: zona || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  var v = {};
  p.forEach(function (x) { v[x.type] = x.value; });
  return v.year + '-' + v.month + '-' + v.day;
}

function formatearFecha(d, zona, conHora) {
  if (!d) return 'sin fecha';
  var o = { timeZone: zona || undefined, year: 'numeric', month: '2-digit', day: '2-digit' };
  if (conHora) { o.hour = '2-digit'; o.minute = '2-digit'; o.hour12 = false; }
  return new Intl.DateTimeFormat('es', o).format(d);
}

/** Zona de la configuración del proyecto ("Zona horaria: America/Caracas"); sin ella, la del sistema. */
function zonaDeConfig(textoConfig) {
  var m = /^\s*(?:zona[ _]horaria|timezone|tz)\s*:\s*([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}|UTC)\s*$/im.exec(String(textoConfig || ''));
  if (!m) return null;
  try { new Intl.DateTimeFormat('es', { timeZone: m[1] }); return m[1]; } catch (e) { return null; }
}

module.exports = { fechaUtc, compararPorFecha, diaEnZona, formatearFecha, zonaDeConfig };
