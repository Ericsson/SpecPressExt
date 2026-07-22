/**
 * Test script for multi-version DOCX DIFF
 *
 * Usage:
 *   node scripts/test-docx-diff.js <repoPath> <commit1> <commit2> [commit3] [commit4] [commit5|local]
 *
 * Example:
 *   node scripts/test-docx-diff.js "C:\repos\example-spec" abc1234 def5678 ghi9012
 *   node scripts/test-docx-diff.js "C:\repos\example-spec" abc1234 def5678 local
 *
 * Use "local" as the last argument to include uncommitted local files as the final version.
 *
 * This script simulates the DOCX DIFF workflow by:
 * 1. Generating DOCX files for each specified commit (or local files)
 * 2. Merging them with tracked changes via specpress mergeDocxVersions
 * 3. Saving the result to the OS temp directory
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const args = process.argv.slice(2)

if (args.length < 3) {
  console.error('Usage: node scripts/test-docx-diff.js <repoPath> <commit1> <commit2> [commit3] [commit4] [commit5|local]')
  console.error('')
  console.error('Example:')
  console.error('  node scripts/test-docx-diff.js "C:\\repos\\example-spec" abc1234 def5678 ghi9012')
  console.error('  node scripts/test-docx-diff.js "C:\\repos\\example-spec" abc1234 def5678 local')
  process.exit(1)
}

const repoPath = args[0]
const commits = args.slice(1)

if (commits.length < 2 || commits.length > 5) {
  console.error(`Error: Must provide 2-5 commits, got ${commits.length}`)
  process.exit(1)
}

if (!fs.existsSync(repoPath)) {
  console.error(`Error: Repository path does not exist: ${repoPath}`)
  process.exit(1)
}

try {
  execSync('git rev-parse --git-dir', { cwd: repoPath, stdio: 'ignore' })
} catch (e) {
  console.error(`Error: Not a git repository: ${repoPath}`)
  process.exit(1)
}

// Resolve commits to short hashes (keep 'local' as-is)
console.log('Validating commits...')
const commitLabels = []
for (let i = 0; i < commits.length; i++) {
  if (commits[i].toLowerCase() === 'local') {
    console.log(`  v${i + 1}: local files (current workspace)`)
    commits[i] = 'local'
    commitLabels.push('local')
  } else {
    try {
      const shortHash = execSync(`git rev-parse --short ${commits[i]}`, { cwd: repoPath, encoding: 'utf8' }).trim()
      const message = execSync(`git log -1 --format=%s ${commits[i]}`, { cwd: repoPath, encoding: 'utf8' }).trim()
      console.log(`  v${i + 1}: ${shortHash} - ${message}`)
      commits[i] = shortHash
      commitLabels.push(shortHash)
    } catch (e) {
      console.error(`Error: Invalid commit: ${commits[i]}`)
      process.exit(1)
    }
  }
}

// Find spec root
const possibleSpecRoots = ['spec', 'specification', 'src', '.']
let specRoot = null
for (const dir of possibleSpecRoots) {
  const testPath = path.join(repoPath, dir)
  if (fs.existsSync(testPath)) {
    try {
      const files = execSync(`git ls-tree -r --name-only ${commits[0]} -- "${dir}"`, { cwd: repoPath, encoding: 'utf8' })
      if (files.match(/\.(md|markdown|asn)$/m)) { specRoot = dir; break }
    } catch (e) { /* continue */ }
  }
}

if (!specRoot) {
  console.error('Error: Could not find spec root directory')
  console.error('Tried: ' + possibleSpecRoots.join(', '))
  process.exit(1)
}

console.log(`\nUsing spec root: ${specRoot}`)

const tmpDir = require('os').tmpdir()
const timestamp = Date.now()
const specRootPath = path.join(repoPath, specRoot)

const { collectFiles, concatenateFiles } = require('specpress/lib/common/specProcessor')
const { collectFilesFromCommit } = require('specpress/lib/common/gitHelpers')
const { Md2Docx } = require('specpress/lib/md2docx/md2docx')
const { createLocalResolver, createCommitResolver } = require('specpress/lib/common/fileResolver')
const { mergeDocxVersions } = require('specpress/lib/common/docxMerge')

async function generateDocx() {
  console.log('\nGenerating DOCX files...')
  const docxFiles = []

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i]
    const isLocal = commit === 'local'
    const label = isLocal ? 'local files' : commit
    const docxPath = path.join(tmpDir, `specpress_test_diff_v${i + 1}_${commitLabels[i]}_${timestamp}.docx`)

    console.log(`  Generating DOCX for v${i + 1} (${label})...`)

    let resolver, files, readFile, fileResolver

    if (isLocal) {
      resolver = createLocalResolver(repoPath, specRootPath)
      files = collectFiles([specRootPath])
    } else {
      resolver = createCommitResolver(repoPath, specRootPath, commit)
      files = collectFilesFromCommit(repoPath, [specRootPath], commit)
    }

    if (files.length === 0) {
      console.error(`Error: No markdown/ASN files found for v${i + 1} (${label})`)
      process.exit(1)
    }

    readFile = (f) => resolver.readFile(f, 'utf8')
    fileResolver = (f) => resolver.readFile(f)

    const content = concatenateFiles(files, readFile, specRootPath)

    const converter = new Md2Docx({
      updateFields: false,
      specRootPath,
      fileResolver,
    })

    await converter.convert(content, docxPath, path.dirname(files[0]), null, {})
    docxFiles.push(docxPath)
    console.log(`    → ${docxPath}`)
  }

  return docxFiles
}

generateDocx().then(async (docxFiles) => {
  console.log('\nMerging versions with tracked changes...')

  const outputFilename = `specpress_test_diff_${commitLabels.join('_')}.docx`
  const outputPath = path.join(tmpDir, outputFilename)

  const revisions = commits.slice(1).map((_, i) => ({
    docxPath: docxFiles[i + 1],
    authorName: commitLabels[i + 1],
  }))

  try {
    await mergeDocxVersions(docxFiles[0], revisions, outputPath, { backend: 'auto' })
    console.log(`\n✓ DOCX DIFF generated successfully!`)
    console.log(`  File: file:///${outputPath.replace(/\\/g, '/')}`)
  } catch (e) {
    console.error(`\n✗ Merge failed: ${e.message}`)
    console.error('\nGenerated DOCX files (kept for inspection):')
    docxFiles.forEach((f, i) => console.error(`  v${i + 1}: ${f}`))
    process.exit(1)
  }
}).catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
