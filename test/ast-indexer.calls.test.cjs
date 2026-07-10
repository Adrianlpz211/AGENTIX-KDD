'use strict';
const assert = require('node:assert');
const { extractCallsWithinFile } = require('../.agentic/grafo/ast-indexer.cjs');

const content = `
function helper(x) {
  return x + 1;
}

function main() {
  const y = helper(5);
  return y;
}
`;

const symbols = [
  { symbol_name: 'helper', line_start: 2 },
  { symbol_name: 'main', line_start: 6 },
];

const edges = extractCallsWithinFile(content, symbols);

assert.strictEqual(edges.length, 1, `esperaba 1 edge CALLS, obtuve ${edges.length}`);
assert.strictEqual(edges[0].kind, 'CALLS');
assert.strictEqual(edges[0].from_symbol, 'main');
assert.strictEqual(edges[0].to_symbol, 'helper');

console.log('✅ ast-indexer.calls.test.cjs — PASS');
