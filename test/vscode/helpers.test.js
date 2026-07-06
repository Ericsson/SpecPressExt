const assert = require('assert')
const path = require('path')
const Module = require('module')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
    failed++
  }
}

// ── Mock vscode module ──
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode'
  return origResolve.call(this, request, ...args)
}
require.cache['vscode'] = {
  id: 'vscode', filename: 'vscode', loaded: true,
  exports: {
    window: { showInformationMessage: () => Promise.resolve(null) },
    env: { openExternal: () => {} },
    Uri: { file: (p) => ({ fsPath: p }) }
  }
}

const { formatExportTimestamp } = require('../../src/vscode/helpers')

// ── formatExportTimestamp ──

console.log('formatExportTimestamp')

test('returns string in YYYY-MM-DD HH-MM-SS format', () => {
  const ts = formatExportTimestamp()
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(ts), `Got: ${ts}`)
})

test('returns current date', () => {
  const ts = formatExportTimestamp()
  const year = new Date().getFullYear().toString()
  assert.ok(ts.startsWith(year))
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
