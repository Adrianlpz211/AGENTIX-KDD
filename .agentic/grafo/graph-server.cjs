'use strict';
const http = require('http');
const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');
const { exportGraph } = require('./graph-export.cjs');

const PORT    = 9750;
const UI_DIR  = path.join(__dirname, 'graph-ui');
const PROJECT_ROOT = process.argv[2] || process.env.AGENTIX_ROOT || process.cwd();

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/graph.json') {
    try {
      const data = exportGraph(PROJECT_ROOT);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const full    = path.join(UI_DIR, urlPath);
  if (fs.existsSync(full) && fs.statSync(full).isFile()) {
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(fs.readFileSync(full));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Agentix Graph UI → ${url}\n`);
  try {
    const open = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    execSync(open, { stdio: 'ignore' });
  } catch {}
});
