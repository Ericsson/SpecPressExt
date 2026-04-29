const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const testDir = path.join(__dirname, '..', 'test')
const quick = process.argv.includes('--quick')

/** Test files skipped in --quick mode (e.g. slow DOCX tests). */
const SLOW_TESTS = new Set(['paragraphClassification.test.js'])

function findTests(dir) {
  const results = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) results.push(...findTests(full))
    else if (entry.name.endsWith('.test.js')) results.push(full)
  }
  return results.sort()
}

const allTests = findTests(testDir)
const tests = quick ? allTests.filter(t => !SLOW_TESTS.has(path.basename(t))) : allTests
const skipped = allTests.length - tests.length
let failed = 0

for (const t of tests) {
  const label = path.relative(testDir, t)
  console.log(`\n── ${label} ──`)
  try {
    execSync(`node "${t}"`, { stdio: 'inherit' })
  } catch (e) {
    failed++
  }
}

console.log(`\n${'═'.repeat(40)}`)
console.log(`${tests.length} test file(s), ${failed} failed${skipped ? `, ${skipped} skipped (--quick)` : ''}`)
process.exit(failed > 0 ? 1 : 0)
