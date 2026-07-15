'use strict';

/**
 * Endpoint Heuristic v2 — Agentic KDD v3.13 (Plan 4: portabilidad)
 *
 * Conecta front↔back por ruta de API para el Code Structure del dashboard.
 * Sigue siendo una HEURÍSTICA INFORMATIVA (alimenta un dibujo, nunca bloquea):
 * fallar aquí = una conexión de menos en el grafo, jamás un STOP incorrecto.
 *
 * Qué generaliza respecto al legacy (que vivía dentro de dashboard.cjs):
 *   1. BACK desde el ÍNDICE: los endpoints salen de ast_symbols kind='endpoint'
 *      (que ya habla Express/Fastify/NestJS/Flask/FastAPI/Django/Rails/Laravel/
 *      gin/Spring vía el catálogo del indexador) — ya no re-grepea archivos con
 *      un patrón angosto TS-only.
 *   2. MONTAJES generalizados: app.use('/p', LO_QUE_SEA) — función-fábrica
 *      create*Router (caso legacy), identificador importado, o require inline.
 *      Server files en .js/.ts/.mjs/.cjs/.jsx/.tsx (antes: solo .ts/.tsx).
 *   3. FRONT por perfil: esFront() de stack-profile.cjs (carpetas declaradas
 *      del proyecto) — sin perfil cae a public/ + .jsx/.tsx (comportamiento
 *      de hoy, nadie queda peor).
 *   4. LLAMADAS: fetch() y axios genéricos + los wrappers propios declarados
 *      en el perfil (api_wrappers) — antes: solo el wrapper api() de Lumo.
 *   5. NORMALIZACIÓN de rutas: :id (Express) / {id} (FastAPI-Spring) /
 *      <int:id> (Flask-Django) / ${...} (front) → comodín. Matching por
 *      segmentos exactos, igual que el legacy.
 *   6. ESCAPE HATCH: .agentic/endpoint-map.json — mapeo manual para el caso
 *      raro que ningún patrón cubre: { "ruta/front.js": ["GET /api/x"] }.
 *
 * Techo honesto (documentado, no se intenta): URLs armadas por concatenación
 * dinámica, GraphQL/tRPC/gRPC. Para eso está el escape hatch.
 */

const fs = require('fs');
const path = require('path');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

// ─── Rutas: normalización y matching ─────────────────────────────────────────

// Segmento comodín del back: :id | {id} | <int:id> | *
function esComodinBack(seg) {
  return seg.startsWith(':') || /^\{.*\}$/.test(seg) || /^<.*>$/.test(seg) || seg === '*';
}

function segMatch(frontSegs, backSegs) {
  if (frontSegs.length !== backSegs.length) return false;
  for (let i = 0; i < frontSegs.length; i++) {
    const f = frontSegs[i], b = backSegs[i];
    if (esComodinBack(b)) continue;
    if (f === ' ') continue; // el front tenía un ${...} dinámico en este segmento
    if (f !== b) return false;
  }
  return true;
}

const segs = (ruta) => String(ruta).split('?')[0].split('/').filter(Boolean);

// ─── Montajes: app.use('/prefijo', X) generalizado ───────────────────────────

const SERVER_FILE_RE = /(^|[\\/])(server|app|index|main)\.(js|ts|mjs|cjs|jsx|tsx)$/i;
const CODE_FILE_RE = /\.(js|ts|mjs|cjs|jsx|tsx)$/i;

function resolveImportTarget(spec, fromFileAbs, root) {
  if (!spec || !spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFileAbs), spec);
  const candidates = [base];
  const extMatch = base.match(/\.(js|jsx|mjs|cjs)$/i);
  if (extMatch) {
    const sinExt = base.slice(0, -extMatch[0].length);
    candidates.push(sinExt + '.ts', sinExt + '.tsx');
  }
  ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js'].forEach(e => candidates.push(base + e));
  for (const c of candidates) {
    if (safe(() => fs.existsSync(c) && fs.statSync(c).isFile(), false)) {
      return path.relative(root, c).replace(/\\/g, '/');
    }
  }
  return null;
}

// Devuelve { porArchivo: {relFile → prefijo}, porCreator: {createXRouter → prefijo} }
// Los archivos "server" se buscan en codeNodes Y en disco (raíz + src/ + server/
// + api/, profundidad 1): un server.js minimalista (solo require + app.use +
// listen, típico de Express plano) no produce NINGÚN símbolo, así que no existe
// como nodo del grafo — sin el escaneo de disco sus montajes serían invisibles.
function collectMounts(codeNodes, root) {
  const porArchivo = {};
  const porCreator = {};
  const candidatos = new Map(); // relFile → true (dedupe entre codeNodes y disco)
  codeNodes.filter(n => SERVER_FILE_RE.test(n.file))
    .forEach(n => candidatos.set(n.file.replace(/\\/g, '/'), true));
  for (const dir of ['', 'src', 'server', 'api', 'backend']) {
    const abs = dir ? path.join(root, dir) : root;
    const entries = safe(() => fs.readdirSync(abs, { withFileTypes: true }), []);
    for (const e of entries) {
      if (!e.isFile() || !SERVER_FILE_RE.test(e.name)) continue;
      candidatos.set((dir ? dir + '/' : '') + e.name, true);
    }
  }
  // También los subdirectorios de codeNodes con endpoints: su server suele
  // vivir al lado (ej. pruebas/miniapp/server.js junto a pruebas/miniapp/rutas.js).
  const dirsConEndpoints = new Set(
    codeNodes.filter(n => (n.extraSymbols || []).some(s => s.kind === 'endpoint'))
      .map(n => path.dirname(n.file.replace(/\\/g, '/'))));
  for (const d of dirsConEndpoints) {
    const abs = path.join(root, d);
    const entries = safe(() => fs.readdirSync(abs, { withFileTypes: true }), []);
    for (const e of entries) {
      if (!e.isFile() || !SERVER_FILE_RE.test(e.name)) continue;
      candidatos.set(d + '/' + e.name, true);
    }
  }

  for (const relFile of candidatos.keys()) {
    const sf = { file: relFile };
    const abs = path.join(root, sf.file);
    const content = safe(() => fs.readFileSync(abs, 'utf8'), null);
    if (!content) continue;

    // mapa identificador → specifier de import/require del MISMO archivo
    const importOf = {};
    let im;
    const importPats = [
      /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,                    // import x from './y'
      /import\s*\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]/g,              // import { a, b } from './y'
      /(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g, // const x = require('./y')
    ];
    for (const pat of importPats) {
      pat.lastIndex = 0;
      while ((im = pat.exec(content)) !== null) {
        if (pat === importPats[1]) {
          im[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()).filter(Boolean)
            .forEach(nombre => { importOf[nombre] = im[2]; });
        } else {
          importOf[im[1]] = im[2];
        }
      }
    }

    // a) legacy: .use('/p', createXRouter( ... ))
    const useCreator = /\.use\(\s*['"`]([^'"`]+)['"`]\s*,\s*(create\w*Router)\s*\(/g;
    let m;
    while ((m = useCreator.exec(content)) !== null) porCreator[m[2]] = m[1];

    // b) identificador: .use('/p', rutas) — resolver rutas → archivo vía imports
    const useIdent = /\.use\(\s*['"`]([^'"`]+)['"`]\s*,\s*([A-Za-z_$][\w$]*)\s*[),]/g;
    while ((m = useIdent.exec(content)) !== null) {
      const spec = importOf[m[2]];
      if (!spec) continue;
      const target = resolveImportTarget(spec, abs, root);
      if (target) porArchivo[target.toLowerCase()] = m[1];
    }

    // c) require inline: .use('/p', require('./rutas'))
    const useRequire = /\.use\(\s*['"`]([^'"`]+)['"`]\s*,\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = useRequire.exec(content)) !== null) {
      const target = resolveImportTarget(m[2], abs, root);
      if (target) porArchivo[target.toLowerCase()] = m[1];
    }
  }
  return { porArchivo, porCreator };
}

// ─── Núcleo ───────────────────────────────────────────────────────────────────

function computeEndpointEdges(codeNodes, root, profileOverride) {
  if (!Array.isArray(codeNodes) || !codeNodes.length) return [];

  // Perfil (opcional): esFront + api_wrappers. Sin perfil, esFront degrada a
  // public/ + .jsx/.tsx y los wrappers a ['api'] — comportamiento de hoy.
  // profileOverride (tests / callers avanzados) evita leer la BD.
  let esFront, profile = null;
  try {
    const sp = require(path.join(__dirname, 'stack-profile.cjs'));
    profile = profileOverride !== undefined ? profileOverride : safe(() => sp.loadProfile(root), null);
    esFront = (file) => sp.esFront(file, profile);
  } catch {
    esFront = (file) => {
      const f = String(file).replace(/\\/g, '/');
      return f.startsWith('public/') || /\.(jsx|tsx)$/i.test(f);
    };
  }

  // 1. BACK desde el índice: codeNodes traen extraSymbols (kind 'endpoint')
  //    con symbol_name 'METHOD /ruta' — generados por el catálogo del indexador.
  const { porArchivo, porCreator } = collectMounts(codeNodes, root);
  const backendRoutes = [];
  for (const n of codeNodes) {
    const eps = (n.extraSymbols || []).filter(s => s.kind === 'endpoint');
    if (!eps.length) continue;
    const fileNorm = n.file.replace(/\\/g, '/');
    if (esFront(fileNorm)) continue; // un endpoint indexado en el front no es una ruta del back

    // prefijo de montaje: por archivo (ident/require) o por función-fábrica (legacy)
    let prefix = porArchivo[fileNorm.toLowerCase()] || null;
    if (!prefix && Object.keys(porCreator).length) {
      const content = safe(() => fs.readFileSync(path.join(root, n.file), 'utf8'), null);
      const creatorMatch = content && content.match(/export\s+function\s+(create\w*Router)/);
      if (creatorMatch && porCreator[creatorMatch[1]]) prefix = porCreator[creatorMatch[1]];
    }

    for (const ep of eps) {
      const sep = ep.name || ep.symbol_name || '';
      const espacio = sep.indexOf(' ');
      if (espacio <= 0) continue;
      const ruta = sep.slice(espacio + 1);
      const fullPath = (prefix ? prefix + '/' + ruta : ruta).replace(/\/+/g, '/');
      backendRoutes.push({ file: n.file, path: fullPath });
    }
  }
  if (!backendRoutes.length) return [];

  // 2. FRONT: llamadas de red en archivos front — wrappers del perfil + fetch + axios
  const wrapperNames = (profile && Array.isArray(profile.api_wrappers) && profile.api_wrappers.length)
    ? profile.api_wrappers
    : ['api'];
  const litRe = '(`[^`]*`|\'[^\']*\'|"[^"]*")';
  const callPatterns = [
    ...wrapperNames
      .filter(w => /^[A-Za-z_$][\w$]*$/.test(w)) // nombres seguros para regex
      .map(w => new RegExp('\\b' + w + '\\(\\s*' + litRe, 'g')),
    new RegExp('\\bfetch\\(\\s*' + litRe, 'g'),
    new RegExp('\\baxios\\.(?:get|post|put|patch|delete)\\(\\s*' + litRe, 'g'),
    new RegExp('\\baxios\\(\\s*\\{[^}]*url\\s*:\\s*' + litRe, 'g'),
  ];

  // Archivos front a escanear: los del grafo (codeNodes) + un recorrido de
  // disco de las carpetas front declaradas — simétrico al fix de los server
  // files: un archivo "pegamento" (solo fetch/llamadas, sin funciones propias)
  // no produce símbolos y por lo tanto no existe como nodo; sin el recorrido
  // de disco sus llamadas serían invisibles.
  const frontFileSet = new Map(); // norm → ruta original
  for (const n of codeNodes) {
    const fileNorm = n.file.replace(/\\/g, '/');
    if (esFront(fileNorm) && CODE_FILE_RE.test(fileNorm)) frontFileSet.set(fileNorm.toLowerCase(), n.file);
  }
  const frontDirsScan = (profile && Array.isArray(profile.front_dirs) && profile.front_dirs.length)
    ? profile.front_dirs : ['public'];
  const MAX_FRONT_SCAN = 500;
  const walkFront = (dirRel, depth) => {
    if (depth > 3 || frontFileSet.size >= MAX_FRONT_SCAN) return;
    const abs = path.join(root, dirRel);
    const entries = safe(() => fs.readdirSync(abs, { withFileTypes: true }), []);
    for (const e of entries) {
      if (frontFileSet.size >= MAX_FRONT_SCAN) return;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const rel = dirRel + '/' + e.name;
      if (e.isDirectory()) walkFront(rel, depth + 1);
      else if (CODE_FILE_RE.test(e.name)) frontFileSet.set(rel.toLowerCase(), rel);
    }
  };
  frontDirsScan.forEach(d => walkFront(String(d).replace(/\\/g, '/'), 0));

  const frontCalls = [];
  for (const file of frontFileSet.values()) {
    const content = safe(() => fs.readFileSync(path.join(root, file), 'utf8'), null);
    if (!content) continue;
    for (const re of callPatterns) {
      re.lastIndex = 0;
      let cm;
      while ((cm = re.exec(content)) !== null) {
        const inner = cm[1].slice(1, -1).replace(/\$\{[^}]*\}/g, ' ');
        // solo rutas relativas de API (empiezan con /) — URLs externas http(s) son ruido
        if (!inner.trim().startsWith('/')) continue;
        frontCalls.push({ file, raw: inner });
      }
    }
  }

  // 3. ESCAPE HATCH: .agentic/endpoint-map.json — { "front.js": ["GET /api/x"] }
  const manualEdges = [];
  const mapPath = path.join(root, '.agentic', 'endpoint-map.json');
  const manual = safe(() => JSON.parse(fs.readFileSync(mapPath, 'utf8')), null);
  if (manual && typeof manual === 'object') {
    for (const [frontFile, flowList] of Object.entries(manual)) {
      (Array.isArray(flowList) ? flowList : []).forEach(flow => {
        const espacio = String(flow).indexOf(' ');
        const ruta = espacio > 0 ? String(flow).slice(espacio + 1) : String(flow);
        const fSegs = segs(ruta);
        backendRoutes.forEach(br => {
          if (segMatch(fSegs, segs(br.path))) {
            manualEdges.push({ frontFile: frontFile.replace(/\//g, path.sep), backFile: br.file });
          }
        });
      });
    }
  }

  if (!frontCalls.length && !manualEdges.length) return [];

  // 4. MATCH segmento a segmento (idéntico en espíritu al legacy)
  const seen = new Set();
  const result = [];
  const push = (frontFile, backFile) => {
    const key = frontFile + '|' + backFile;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ frontFile, backFile });
  };
  for (const fc of frontCalls) {
    const fSegs = segs(fc.raw);
    for (const br of backendRoutes) {
      if (segMatch(fSegs, segs(br.path))) push(fc.file, br.file);
    }
  }
  manualEdges.forEach(e => push(e.frontFile, e.backFile));

  return result;
}

module.exports = { computeEndpointEdges, segMatch, collectMounts, esComodinBack };
