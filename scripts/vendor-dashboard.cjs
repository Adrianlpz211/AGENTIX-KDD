'use strict';

/** Empaqueta localmente las librerías del tablero (mismas versiones que el CDN). */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', '.agentic', 'grafo', 'vendor');
const ASSETS = [
  { name: 'd3.min.js', url: 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js' },
  { name: '3d-force-graph.min.js', url: 'https://unpkg.com/3d-force-graph@1.80.0/dist/3d-force-graph.min.js' },
  { name: 'three.min.js', url: 'https://unpkg.com/three@0.160.0/build/three.min.js' },
  { name: 'three-spritetext.min.js', url: 'https://unpkg.com/three-spritetext@1.10.0/dist/three-spritetext.min.js' },
  { name: 'force-graph.min.js', url: 'https://unpkg.com/force-graph@1.43.5/dist/force-graph.min.js' },
];

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function bajar(url) {
  return new Promise((ok, no) => {
    const pedir = (u, n) => {
      https.get(u, { headers: { 'User-Agent': 'agentix-vendor' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && n < 4) {
          return pedir(res.headers.location, n + 1);
        }
        if (res.statusCode !== 200) return no(new Error(u + ' → ' + res.statusCode));
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => ok(Buffer.concat(chunks)));
      }).on('error', no);
    };
    pedir(url, 0);
  });
}

async function instalar() {
  fs.mkdirSync(DIR, { recursive: true });
  const out = [];
  for (const a of ASSETS) {
    const dest = path.join(DIR, a.name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      out.push({ name: a.name, status: 'YA_ESTABA', sha256: sha(fs.readFileSync(dest)), bytes: fs.statSync(dest).size });
      continue;
    }
    const buf = await bajar(a.url);
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    out.push({ name: a.name, status: 'DESCARGADO', sha256: sha(buf), bytes: buf.length });
  }
  const man = { schema_version: 1, assets: out, at: new Date().toISOString() };
  fs.writeFileSync(path.join(DIR, 'manifiesto.json'), JSON.stringify(man, null, 2));
  return man;
}

function verify() {
  const faltan = ASSETS.filter((a) => !fs.existsSync(path.join(DIR, a.name)) || fs.statSync(path.join(DIR, a.name)).size < 1000);
  return { ok: faltan.length === 0, faltan: faltan.map((a) => a.name) };
}

module.exports = { instalar, verify, ASSETS, DIR };

if (require.main === module) {
  const cmd = process.argv[2] || 'install';
  if (cmd === 'verify') {
    const r = verify();
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exitCode = 1;
  } else {
    instalar().then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => {
      console.error(e.message || e);
      process.exitCode = 2;
    });
  }
}
