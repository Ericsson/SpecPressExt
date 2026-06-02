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
 * 2. Calling the VBScript to merge them with tracked changes
 * 3. Saving the result to the test-output directory
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

// Parse command line arguments
const args = process.argv.slice(2)

if (args.length < 3) {
  console.error('Usage: node scripts/test-docx-diff.js <repoPath> <commit1> <commit2> [commit3] [commit4] [commit5|local]')
  console.error('')
  console.error('Example:')
  console.error('  node scripts/test-docx-diff.js "C:\\repos\\example-spec" abc1234 def5678 ghi9012')
  console.error('  node scripts/test-docx-diff.js "C:\\repos\\example-spec" abc1234 def5678 local')
  console.error('')
  console.error('Arguments:')
  console.error('  repoPath  - Path to the git repository containing the specification')
  console.error('  commit1   - First commit hash (baseline)')
  console.error('  commit2   - Second commit hash')
  console.error('  commit3-5 - Optional additional commit hashes (up to 5 total)')
  console.error('  local     - Use "local" as the last argument to include uncommitted local files')
  process.exit(1)
}

const repoPath = args[0]
const commits = args.slice(1)

if (commits.length < 2 || commits.length > 5) {
  console.error(`Error: Must provide 2-5 commits, got ${commits.length}`)
  process.exit(1)
}

// Validate repository path
if (!fs.existsSync(repoPath)) {
  console.error(`Error: Repository path does not exist: ${repoPath}`)
  process.exit(1)
}

// Check if it's a git repository
try {
  execSync('git rev-parse --git-dir', { cwd: repoPath, stdio: 'ignore' })
} catch (e) {
  console.error(`Error: Not a git repository: ${repoPath}`)
  process.exit(1)
}

// Validate commits
console.log('Validating commits...')
const commitLabels = [] // Store labels for display
for (let i = 0; i < commits.length; i++) {
  if (commits[i].toLowerCase() === 'local') {
    // Special case: local files
    console.log(`  v${i + 1}: local files (current workspace)`)
    commitLabels.push('local')
  } else {
    try {
      const shortHash = execSync(`git rev-parse --short ${commits[i]}`, { 
        cwd: repoPath, 
        encoding: 'utf8' 
      }).trim()
      const message = execSync(`git log -1 --format=%s ${commits[i]}`, { 
        cwd: repoPath, 
        encoding: 'utf8' 
      }).trim()
      console.log(`  v${i + 1}: ${shortHash} - ${message}`)
      commits[i] = shortHash // Use short hash
      commitLabels.push(shortHash)
    } catch (e) {
      console.error(`Error: Invalid commit: ${commits[i]}`)
      process.exit(1)
    }
  }
}

// Find spec root (look for common spec directories)
const possibleSpecRoots = ['spec', 'specification', 'src', '.']
let specRoot = null

for (const dir of possibleSpecRoots) {
  const testPath = path.join(repoPath, dir)
  if (fs.existsSync(testPath)) {
    // Check if it contains markdown or ASN files
    try {
      const files = execSync(`git ls-tree -r --name-only ${commits[0]} -- "${dir}"`, {
        cwd: repoPath,
        encoding: 'utf8'
      })
      if (files.match(/\.(md|markdown|asn)$/m)) {
        specRoot = dir
        break
      }
    } catch (e) {
      // Continue searching
    }
  }
}

if (!specRoot) {
  console.error('Error: Could not find spec root directory')
  console.error('Tried: ' + possibleSpecRoots.join(', '))
  process.exit(1)
}

console.log(`\nUsing spec root: ${specRoot}`)

// Create output directory in temp folder
const tmpDir = require('os').tmpdir()
const outputDir = path.join(tmpDir, 'specpress-test-output')
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true })
}

const timestamp = Date.now()

console.log('\nGenerating DOCX files...')

// Load required modules
const { collectFilesFromCommit } = require('specpress/lib/common/gitHelpers')
const { concatenateFiles } = require('specpress/lib/common/specProcessor')
const { MarkdownToDocxConverter } = require('specpress/lib/md2docx/md2docx')

// Helper to extract files from commit
function extractFilesFromCommit(commit) {
  const cache = new Map()
  const prefix = specRoot === '.' ? '' : specRoot + '/'
  
  try {
    const tar = execSync(`git archive ${commit} -- "${prefix}"`, {
      cwd: repoPath,
      maxBuffer: 50 * 1024 * 1024
    })
    
    let offset = 0
    while (offset < tar.length - 512) {
      const header = tar.slice(offset, offset + 512)
      const name = header.slice(0, 100).toString().replace(/\0/g, '').trim()
      if (!name) break
      
      const sizeStr = header.slice(124, 136).toString().replace(/\0/g, '').trim()
      const size = parseInt(sizeStr, 8) || 0
      offset += 512
      
      if (size > 0 && /\.(md|markdown|asn|json|png|jpg|jpeg|gif|bmp|svg)$/.test(name)) {
        const isImage = /\.(png|jpg|jpeg|gif|bmp|svg)$/.test(name)
        const content = isImage
          ? tar.slice(offset, offset + size)
          : tar.slice(offset, offset + size).toString('utf8')
        cache.set(path.join(repoPath, name), content)
      }
      offset += Math.ceil(size / 512) * 512
    }
  } catch (e) {
    console.error(`Error extracting files from ${commit}: ${e.message}`)
    process.exit(1)
  }
  
  return cache
}

// Helper to create file resolver
function makeCachedFileResolver(cache) {
  const normPath = (p) => p.replace(/\\/g, '/').toLowerCase()
  return (filePath) => {
    if (cache.has(filePath)) return cache.get(filePath)
    const target = normPath(filePath)
    for (const [key, val] of cache) {
      if (normPath(key) === target) return val
    }
    return fs.readFileSync(filePath)
  }
}

function makeCachedTextReader(cache) {
  const normPath = (p) => p.replace(/\\/g, '/').toLowerCase()
  return (filePath) => {
    if (cache.has(filePath)) {
      const content = cache.get(filePath)
      return Buffer.isBuffer(content) ? content.toString('utf8') : content
    }
    const target = normPath(filePath)
    for (const [key, val] of cache) {
      if (normPath(key) === target) {
        return Buffer.isBuffer(val) ? val.toString('utf8') : val
      }
    }
    return fs.readFileSync(filePath, 'utf8')
  }
}

// Generate DOCX for each commit
const docxFiles = []
const specRootPath = path.join(repoPath, specRoot)

async function generateDocx() {
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i]
    const isLocal = commit === 'local'
    const label = isLocal ? 'local files' : commit
    const versionLabel = isLocal ? 'local' : commit
    
    // Look for existing DOCX file (any timestamp)
    const pattern = `test_diff_v${i + 1}_${versionLabel}_`
    const existingFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith(pattern) && f.endsWith('.docx'))
    
    let docxPath
    if (existingFiles.length > 0) {
      // Use existing file
      docxPath = path.join(tmpDir, existingFiles[0])
      console.log(`  v${i + 1} (${label}): Using existing file`)
      docxFiles.push(docxPath)
      continue
    }
    
    // Generate new file with current timestamp
    docxPath = path.join(tmpDir, `test_diff_v${i + 1}_${versionLabel}_${timestamp}.docx`)
    console.log(`  Generating DOCX for v${i + 1} (${label})...`)
    
    let files, cache, readFile, fileResolver
    
    if (isLocal) {
      // Use local files from filesystem
      const { collectFiles } = require('specpress/lib/common/specProcessor')
      files = collectFiles([specRootPath])
      
      if (files.length === 0) {
        console.error(`Error: No markdown/ASN files found in local workspace`)
        process.exit(1)
      }
      
      // Use default file reading (no cache needed)
      readFile = undefined
      fileResolver = null
    } else {
      // Collect files from commit
      files = collectFilesFromCommit(repoPath, [specRootPath], commit)
      
      if (files.length === 0) {
        console.error(`Error: No markdown/ASN files found in commit ${commit}`)
        process.exit(1)
      }
      
      // Extract file contents
      cache = extractFilesFromCommit(commit)
      readFile = makeCachedTextReader(cache)
      fileResolver = makeCachedFileResolver(cache)
    }
    
    // Concatenate files
    const content = concatenateFiles(files, readFile, specRootPath)
    
    // Write to temp markdown file
    const tempMd = path.join(tmpDir, `test_diff_v${i + 1}_${timestamp}.md`)
    fs.writeFileSync(tempMd, content)
    
    // Generate DOCX (docxPath already defined above)
    
    try {
      const converter = new MarkdownToDocxConverter(
        null, // mermaidConfig
        specRootPath,
        null, // mermaidRenderer (skip mermaid for testing)
        fileResolver,
        { updateFields: false }
      )
      
      await converter.convert(tempMd, docxPath, path.dirname(files[0]), null, {})
      docxFiles.push(docxPath)
      console.log(`    → ${docxPath}`)
      
      // Clean up temp markdown
      fs.unlinkSync(tempMd)
    } catch (e) {
      console.error(`Error generating DOCX for ${commit}: ${e.message}`)
      process.exit(1)
    }
  }
}

// Run the async generation
generateDocx().then(() => {
  console.log('\nCalling VBScript to merge versions...')
  
  // Build output filename using commit labels
  const outputFilename = `test_diff_${commitLabels.join('_')}.docx`
  const outputPath = path.join(outputDir, outputFilename)
  
  // Build VBScript arguments
  const vbsArgs = [`"${outputPath}"`]
  for (let i = 0; i < commits.length; i++) {
    vbsArgs.push(`"${docxFiles[i]}"`)
    if (i > 0) {
      // Use commit label as author name (commit hash or 'local')
      vbsArgs.push(`"${commitLabels[i]}"`)
    }
  }
  
  const vbsPath = path.join(__dirname, 'merge-multi-version.vbs')
  const vbsSimplePath = path.join(__dirname, 'merge-multi-version-simple.vbs')
  
  // Check if we should use simple mode (can be set via environment variable)
  const useSimpleMode = process.env.SIMPLE_MODE === '1'
  const vbsToUse = useSimpleMode ? vbsSimplePath : vbsPath
  
  if (useSimpleMode) {
    console.log('  Using simple mode (accepts changes between comparisons)')
  }
  
  try {
    console.log(`  Output: ${outputPath}`)
    console.log(`  Versions: ${commits.length}`)
    console.log('  (This may take several minutes...)')
    
    const result = execSync(`cscript //nologo "${vbsToUse}" ${vbsArgs.join(' ')}`, {
      encoding: 'utf8',
      timeout: 600000 // 10 minutes
    })
    
    console.log('\nVBScript output:')
    console.log(result)
    
    if (result.includes('Success')) {
      console.log(`\n✓ DOCX DIFF generated successfully!`)
      console.log(`  File: file:///${outputPath.replace(/\\/g, '/')}`)
      
      console.log('\nGenerated temporary DOCX files (kept for future runs):')
      for (let i = 0; i < docxFiles.length; i++) {
        console.log(`  v${i + 1}: file:///${docxFiles[i].replace(/\\/g, '/')}`)
      }
      
      // Offer to open the file
      console.log('\nTo open in Word:')
      console.log(`  start "" "${outputPath}"`)
    } else {
      console.error('\n✗ VBScript did not report success')
      process.exit(1)
    }
  } catch (e) {
    console.error('\n✗ VBScript execution failed:')
    console.error(e.message)
    if (e.stdout) console.error('Output:', e.stdout)
    if (e.stderr) console.error('Error:', e.stderr)
    
    console.error('\nGenerated DOCX files (NOT cleaned up for inspection):')
    for (let i = 0; i < docxFiles.length; i++) {
      console.error(`  v${i + 1}: ${docxFiles[i]}`)
    }
    console.error('\nYou can open these files in Word to inspect them manually.')
    
    process.exit(1)
  }
}).catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
