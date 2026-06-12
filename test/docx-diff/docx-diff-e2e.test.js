/**
 * End-to-end test for multi-version DOCX DIFF
 * 
 * This script:
 * 1. Generates DOCX files from markdown sources in %TEMP%
 * 2. Runs VBScript to merge them with tracked changes
 * 3. Validates the output contains expected changes with correct authors
 * 
 * Usage: node test/fixtures/test-docx-diff-e2e.js
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const os = require('os')

// Get temp directory
const tempDir = os.tmpdir()
const testDir = path.join(tempDir, 'specpress-docx-diff-test-' + Date.now())

console.log('=== DOCX DIFF End-to-End Test ===\n')
console.log(`Working directory: ${testDir}\n`)

// Create temp directory
fs.mkdirSync(testDir, { recursive: true })

// Main test function
async function runE2ETest() {
  try {
  // Step 1: Generate DOCX files from markdown
  console.log('Step 1: Generating DOCX files from markdown sources...')
  
  const fixturesDir = __dirname
  const { MarkdownToDocxConverter } = require('specpress/lib/md2docx/md2docx')
  
  const versions = ['v1', 'v2', 'v3', 'v4']
  const docxFiles = []
  
  for (const version of versions) {
    const mdPath = path.join(fixturesDir, `test-${version}.md`)
    const docxPath = path.join(testDir, `test-${version}.docx`)
    
    if (!fs.existsSync(mdPath)) {
      throw new Error(`Markdown source not found: ${mdPath}`)
    }
    
    process.stdout.write(`  Converting test-${version}.md... `)
    
    const converter = new MarkdownToDocxConverter(
      null, // mermaidConfig
      null, // specRoot
      null, // mermaidRenderer
      null, // fileResolver
      { updateFields: false }
    )
    
    await converter.convert(mdPath, docxPath, fixturesDir, null, {})
    docxFiles.push(docxPath)
    console.log('✓')
  }
  
  console.log(`  Generated ${docxFiles.length} DOCX files\n`)
  
  // Step 2: Run VBScript to merge versions
  console.log('Step 2: Running VBScript to merge versions with tracked changes...')
  
  const outputPath = path.join(testDir, 'output.docx')
  const vbsPath = path.join(__dirname, '..', '..', 'scripts', 'merge-multi-version.vbs')
  
  const vbsArgs = [
    '//nologo',
    vbsPath,
    outputPath,
    docxFiles[0],
    docxFiles[1],
    'Author_v2',
    docxFiles[2],
    'Author_v3',
    docxFiles[3],
    'Author_v4'
  ]
  
  console.log('  Executing VBScript...')
  const vbsResult = spawnSync('cscript', vbsArgs, {
    encoding: 'utf8',
    timeout: 120000, // 2 minutes
    windowsHide: true
  })
  
  if (vbsResult.error) {
    throw new Error(`VBScript execution failed: ${vbsResult.error.message}`)
  }
  
  if (vbsResult.status !== 0) {
    console.error('  VBScript output:', vbsResult.stdout)
    console.error('  VBScript errors:', vbsResult.stderr)
    throw new Error(`VBScript exited with code ${vbsResult.status}`)
  }
  
  if (!vbsResult.stdout.includes('Success')) {
    throw new Error('VBScript did not report success')
  }
  
  console.log('  ✓ VBScript completed successfully\n')
  
  // Step 3: Validate the output
  console.log('Step 3: Validating tracked changes in output.docx...')
  
  // Import verification logic
  const { extractDocumentXml, parseTrackedChanges, validateChanges, EXPECTED_CHANGES } = require('./verify-docx-diff-lib')
  
  const xml = extractDocumentXml(outputPath)
  const trackedChanges = parseTrackedChanges(xml)
  
  console.log(`  Found ${trackedChanges.insertions.length} insertions and ${trackedChanges.deletions.length} deletions\n`)
  
  const validationResults = validateChanges(trackedChanges)
  
  // Print summary
  console.log('\n=== Test Results ===\n')
  
  const changesByAuthor = {}
  trackedChanges.insertions.forEach(change => {
    if (!changesByAuthor[change.author]) {
      changesByAuthor[change.author] = { insertions: 0, deletions: 0 }
    }
    changesByAuthor[change.author].insertions++
  })
  
  trackedChanges.deletions.forEach(change => {
    if (!changesByAuthor[change.author]) {
      changesByAuthor[change.author] = { insertions: 0, deletions: 0 }
    }
    changesByAuthor[change.author].deletions++
  })
  
  const sortedAuthors = Object.keys(changesByAuthor).sort()
  for (const author of sortedAuthors) {
    const counts = changesByAuthor[author]
    console.log(`  ${author}: ${counts.insertions} insertions, ${counts.deletions} deletions`)
  }
  
  console.log(`\n  Validation: ${validationResults.passed}/${Object.keys(EXPECTED_CHANGES).length} authors passed`)
  
  if (validationResults.errors.length > 0) {
    console.log('\n  Errors:')
    validationResults.errors.forEach(error => console.log(`    - ${error}`))
  }
  
  const success = validationResults.failed === 0
  console.log(`\n${success ? '✓' : '✗'} Overall: ${success ? 'PASSED' : 'FAILED'}`)
  
  // Cleanup
  console.log(`\nCleaning up temp directory: ${testDir}`)
  fs.rmSync(testDir, { recursive: true, force: true })
  
  process.exit(success ? 0 : 1)
  
} catch (error) {
  console.error(`\n✗ Test failed: ${error.message}`)
  console.error(error.stack)
  
  // Cleanup on error
  try {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  } catch (e) {
    // Ignore cleanup errors
  }
  
  process.exit(1)
}
}

// Run the test
runE2ETest().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
