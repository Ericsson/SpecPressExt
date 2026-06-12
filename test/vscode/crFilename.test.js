const assert = require('assert')

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
const Module = require('module')
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

const { generateCRFilename, formatExportTimestamp } = require('../../src/vscode/helpers')

// ── generateCRFilename ──

console.log('generateCRFilename - basic functionality')

test('generates filename with all required fields', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    rev: 2,
    Title: 'Correction to handover procedure'
  }
  const filename = generateCRFilename(crData)
  assert.ok(filename, 'should return a filename')
  assert.ok(filename.includes('R19-38.413'), 'should include release and spec')
  assert.ok(filename.includes('CR1234r2'), 'should include CR number with revision')
  assert.ok(filename.includes('Correction_to_handover_procedure'), 'should include sanitized title')
  assert.ok(filename.endsWith('.docx'), 'should end with .docx')
})

test('includes current timestamp in filename', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  const year = new Date().getFullYear().toString()
  assert.ok(filename.startsWith(year), 'should start with current year')
  // Check for YYYY-MM-DD_HH-MM-SS format
  assert.ok(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/.test(filename), 'should have timestamp format')
})

test('omits revision suffix when rev is 0', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    rev: 0,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.ok(filename.includes('CR1234_'), 'should have CR1234 without revision')
  assert.ok(!filename.includes('r0'), 'should not include r0')
})

test('omits revision suffix when rev is undefined', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.ok(filename.includes('CR1234_'), 'should have CR1234 without revision')
  assert.ok(!filename.match(/r\d/), 'should not include revision suffix')
})

test('includes revision suffix when rev > 0', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    rev: 3,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.ok(filename.includes('CR1234r3'), 'should include r3 suffix')
})

console.log('\ngenerateCRFilename - CR number formatting')

test('pads CR number with leading zeros to 4 digits', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 42,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.ok(filename.includes('CR0042'), 'should pad to 4 digits')
})

test('handles 4-digit CR numbers without padding', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 9999,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.ok(filename.includes('CR9999'), 'should keep 4 digits')
})

test('handles 1-digit CR numbers', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 5,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.ok(filename.includes('CR0005'), 'should pad to 4 digits')
})

console.log('\ngenerateCRFilename - title sanitization')

test('replaces spaces with underscores', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    Title: 'Correction to handover procedure'
  }
  const filename = generateCRFilename(crData)
  assert.ok(filename.includes('Correction_to_handover_procedure'), 'should replace spaces')
  assert.ok(!filename.includes(' '), 'should not contain spaces')
})

test('removes invalid filename characters', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    Title: 'Test: with/invalid\\chars|and?more*'
  }
  const filename = generateCRFilename(crData)
  assert.ok(!filename.includes(':'), 'should remove colon')
  assert.ok(!filename.includes('/'), 'should remove forward slash')
  assert.ok(!filename.includes('\\'), 'should remove backslash')
  assert.ok(!filename.includes('|'), 'should remove pipe')
  assert.ok(!filename.includes('?'), 'should remove question mark')
  assert.ok(!filename.includes('*'), 'should remove asterisk')
})

test('collapses multiple underscores', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    Title: 'Test   with    many     spaces'
  }
  const filename = generateCRFilename(crData)
  assert.ok(!filename.includes('__'), 'should not have consecutive underscores')
})

test('trims leading and trailing underscores from title', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    Title: '  Leading and trailing spaces  '
  }
  const filename = generateCRFilename(crData)
  const titlePart = filename.split('_').slice(-1)[0].replace('.docx', '')
  assert.ok(!titlePart.startsWith('_'), 'should not start with underscore')
  assert.ok(!titlePart.endsWith('_'), 'should not end with underscore')
})

test('truncates title to 50 characters', () => {
  const longTitle = 'This is a very long title that exceeds fifty characters and should be truncated'
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    Title: longTitle
  }
  const filename = generateCRFilename(crData)
  const parts = filename.split('_')
  const titlePart = parts.slice(4).join('_').replace('.docx', '')
  assert.ok(titlePart.length <= 50, `Title part should be <= 50 chars, got ${titlePart.length}`)
})

console.log('\ngenerateCRFilename - specification formats')

test('handles simple spec numbers', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.ok(filename.includes('R19-38.413'), 'should include spec number')
})

test('handles spec numbers with dash', () => {
  const crData = {
    Release: 18,
    Specification: '38.101-1',
    CR: 5678,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.ok(filename.includes('R18-38.101-1'), 'should include spec with dash')
})

console.log('\ngenerateCRFilename - release numbers')

test('handles single-digit release', () => {
  const crData = {
    Release: 8,
    Specification: '38.413',
    CR: 1234,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.ok(filename.includes('R8-'), 'should include single-digit release')
})

test('handles double-digit release', () => {
  const crData = {
    Release: 20,
    Specification: '38.413',
    CR: 1234,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.ok(filename.includes('R20-'), 'should include double-digit release')
})

console.log('\ngenerateCRFilename - missing fields')

test('returns null when crData is null', () => {
  const filename = generateCRFilename(null)
  assert.strictEqual(filename, null, 'should return null')
})

test('returns null when crData is undefined', () => {
  const filename = generateCRFilename(undefined)
  assert.strictEqual(filename, null, 'should return null')
})

test('returns null when Release is missing', () => {
  const crData = {
    Specification: '38.413',
    CR: 1234,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.strictEqual(filename, null, 'should return null')
})

test('returns null when Specification is missing', () => {
  const crData = {
    Release: 19,
    CR: 1234,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.strictEqual(filename, null, 'should return null')
})

test('returns null when CR is missing', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.strictEqual(filename, null, 'should return null')
})

test('returns null when Title is missing', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234
  }
  const filename = generateCRFilename(crData)
  assert.strictEqual(filename, null, 'should return null')
})

test('returns null when Release is 0', () => {
  const crData = {
    Release: 0,
    Specification: '38.413',
    CR: 1234,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.strictEqual(filename, null, 'should return null for Release 0')
})

test('returns null when CR is 0', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 0,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.strictEqual(filename, null, 'should return null for CR 0')
})

test('returns null when Title is empty string', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    Title: ''
  }
  const filename = generateCRFilename(crData)
  assert.strictEqual(filename, null, 'should return null for empty title')
})

console.log('\ngenerateCRFilename - complete examples')

test('example 1: typical CR with revision', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    rev: 2,
    Title: 'Correction to handover procedure'
  }
  const filename = generateCRFilename(crData)
  assert.ok(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_R19-38\.413_CR1234r2_Correction_to_handover_procedure\.docx$/.test(filename),
    `Filename format incorrect: ${filename}`)
})

test('example 2: CR without revision', () => {
  const crData = {
    Release: 20,
    Specification: '21.905',
    CR: 42,
    Title: 'Addition of new IE'
  }
  const filename = generateCRFilename(crData)
  assert.ok(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_R20-21\.905_CR0042_Addition_of_new_IE\.docx$/.test(filename),
    `Filename format incorrect: ${filename}`)
})

test('example 3: spec with dash, high CR number', () => {
  const crData = {
    Release: 18,
    Specification: '38.101-1',
    CR: 5678,
    rev: 1,
    Title: 'Editorial corrections'
  }
  const filename = generateCRFilename(crData)
  assert.ok(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_R18-38\.101-1_CR5678r1_Editorial_corrections\.docx$/.test(filename),
    `Filename format incorrect: ${filename}`)
})

console.log('\ngenerateCRFilename - edge cases')

test('handles title with only special characters', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    Title: '***///|||'
  }
  const filename = generateCRFilename(crData)
  // Should sanitize to underscores and collapse
  assert.ok(filename, 'should generate filename')
  assert.ok(!filename.includes('*'), 'should remove asterisks')
  assert.ok(!filename.includes('/'), 'should remove slashes')
})

test('handles title with mixed case', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    Title: 'CoRrEcTiOn To HaNdOvEr'
  }
  const filename = generateCRFilename(crData)
  assert.ok(filename.includes('CoRrEcTiOn_To_HaNdOvEr'), 'should preserve case')
})

test('handles title with numbers', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    Title: 'Update to section 5.2.3 and 7.1.2'
  }
  const filename = generateCRFilename(crData)
  assert.ok(filename.includes('Update_to_section_5.2.3_and_7.1.2'), 'should preserve numbers and dots')
})

test('handles very high revision number', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    rev: 99,
    Title: 'Test'
  }
  const filename = generateCRFilename(crData)
  assert.ok(filename.includes('CR1234r99'), 'should handle high revision')
})

console.log('\ngenerateCRFilename - error handling')

test('handles exception gracefully', () => {
  const crData = {
    Release: 19,
    Specification: '38.413',
    CR: 1234,
    Title: { invalid: 'object' } // Invalid type
  }
  const filename = generateCRFilename(crData)
  assert.strictEqual(filename, null, 'should return null on error')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
