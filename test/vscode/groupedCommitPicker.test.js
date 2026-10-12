const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync } = require('child_process')
const Module = require('module')

let passed = 0
let failed = 0
const asyncTests = []

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

/** Queues an async test to run sequentially after all sync tests (see runAsyncTests). */
function testAsync(name, fn) {
  asyncTests.push({ name, fn })
}

async function runAsyncTests() {
  for (const { name, fn } of asyncTests) {
    try {
      await fn()
      console.log(`  ✓ ${name}`)
      passed++
    } catch (e) {
      console.log(`  ✗ ${name}`)
      console.log(`    ${e.message}`)
      failed++
    }
  }
}

// ── Mock vscode module ──────────────────────────────────────────────────────────
// QuickPickItemKind is touched by the branch-grouping helpers; createQuickPick is a
// minimal fake that lets tests simulate typed text + a stale "active" item (mirrors
// VS Code's real alwaysShow behaviour, where pinned items stay highlighted while the
// user types something that doesn't match anything in the list), and multi-step flows
// (step 1 -> step 2) by returning a fresh QuickPick on each call while still exposing
// the most recent one via `.lastReturned`.

const vscodeMock = {
  QuickPickItemKind: { Separator: -1 },
  window: {
    createQuickPick: () => {
      const qp = {
        items: [],
        value: '',
        placeholder: '',
        matchOnDescription: false,
        activeItems: [],
        _acceptHandlers: [],
        _hideHandlers: [],
        onDidAccept(fn) { qp._acceptHandlers.push(fn) },
        onDidHide(fn) { qp._hideHandlers.push(fn) },
        dispose() {},
        show() {},
        // Test-only helpers to drive the picker as a user would:
        _accept() { qp._acceptHandlers.forEach(fn => fn()) },
        _hide() { qp._hideHandlers.forEach(fn => fn()) }
      }
      vscodeMock.window.createQuickPick.lastReturned = qp
      vscodeMock.window.createQuickPick.allReturned.push(qp)
      return qp
    }
  }
}
vscodeMock.window.createQuickPick.allReturned = []
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode'
  return origResolve.call(this, request, ...args)
}
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeMock }

const {
  getCurrentBranch,
  getCurrentBranchInfo,
  listOtherBranches,
  getAllBranchesInfo,
  findParentBranch,
  getBranchLog,
  buildBranchStepItems,
  isLikelyProtectedBranch,
  matchesTyped,
  pickCommit
} = require('../../src/vscode/helpers')

// ── Test repo helpers ───────────────────────────────────────────────────────────

function run(cwd, cmd) {
  execSync(cmd, { cwd, encoding: 'utf8' })
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specpress-branch-test-'))
  run(dir, 'git init -q -b main')
  run(dir, 'git config user.email "t@t.com"')
  run(dir, 'git config user.name "t"')
  run(dir, 'git config commit.gpgsign false')
  return dir
}

function commit(dir, content, message) {
  fs.writeFileSync(path.join(dir, 'f.txt'), content)
  run(dir, 'git add .')
  run(dir, `git commit -q -m "${message}"`)
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── Tests: branch + parent detection ────────────────────────────────────────────

console.log('Branch detection helpers')

test('getCurrentBranch returns the active branch name (reads .git/HEAD directly)', () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1')
    assert.strictEqual(getCurrentBranch(repo), 'main')
  } finally { cleanup(repo) }
})

test('getCurrentBranch returns null on detached HEAD', () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1')
    commit(repo, 'b', 'c2')
    const hash = execSync('git rev-parse HEAD~1', { cwd: repo, encoding: 'utf8' }).trim()
    run(repo, `git checkout -q ${hash}`)
    assert.strictEqual(getCurrentBranch(repo), null)
  } finally { cleanup(repo) }
})

test('getAllBranchesInfo returns name, hash, and date for every local branch', () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1')
    run(repo, 'git checkout -q -b feature')
    commit(repo, 'b', 'c2')
    const branches = getAllBranchesInfo(repo)
    const names = branches.map(b => b.name).sort()
    assert.deepStrictEqual(names, ['feature', 'main'])
    branches.forEach(b => {
      assert.match(b.hash, /^[0-9a-f]{40}$/)
      assert.ok(b.date > 0)
    })
  } finally { cleanup(repo) }
})

test('getCurrentBranchInfo resolves the current branch tip hash from a pre-fetched branch list', () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1')
    const expectedHash = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
    const allBranches = getAllBranchesInfo(repo)
    const info = getCurrentBranchInfo(repo, allBranches)
    assert.deepStrictEqual(info, { name: 'main', hash: expectedHash })
  } finally { cleanup(repo) }
})

test('listOtherBranches excludes the current branch', () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1')
    run(repo, 'git checkout -q -b feature')
    commit(repo, 'b', 'c2')
    const others = listOtherBranches(repo, 'feature')
    assert.deepStrictEqual(others, ['main'])
  } finally { cleanup(repo) }
})

test('findParentBranch identifies the branch sharing a merge-base with the current branch', () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1 on main')
    commit(repo, 'b', 'c2 on main')
    run(repo, 'git checkout -q -b feature')
    commit(repo, 'c', 'c3 on feature')
    const result = findParentBranch(repo, 'feature', ['main'])
    assert.ok(result)
    assert.strictEqual(result.branch, 'main')
    const mergeBaseSubject = execSync(`git log -1 --format=%s ${result.mergeBase}`, { cwd: repo, encoding: 'utf8' }).trim()
    assert.strictEqual(mergeBaseSubject, 'c2 on main')
  } finally { cleanup(repo) }
})

test('findParentBranch tries the next candidate when the first has unrelated history', () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1 on main')
    run(repo, 'git checkout -q -b feature')
    commit(repo, 'b', 'c2 on feature')

    // An orphan branch has no common history with "feature" — merge-base fails for it.
    run(repo, 'git checkout -q --orphan orphan-branch')
    run(repo, 'git rm -rf -q .')
    commit(repo, 'o', 'c1 on orphan')
    run(repo, 'git checkout -q feature')

    // "orphan-branch" is more recently committed than "main", but has no merge-base
    // with "feature", so findParentBranch must fall through to the next candidate.
    const result = findParentBranch(repo, 'feature', ['orphan-branch', 'main'])
    assert.ok(result)
    assert.strictEqual(result.branch, 'main')
  } finally { cleanup(repo) }
})

test('findParentBranch returns null when no candidate branches exist', () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1')
    assert.strictEqual(findParentBranch(repo, 'main', []), null)
  } finally { cleanup(repo) }
})

test('getBranchLog returns commits newest-first with ref decorations', () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1')
    commit(repo, 'b', 'c2')
    const log = getBranchLog(repo, 'main', 10)
    assert.deepStrictEqual(log.map(e => e.subject), ['c2', 'c1'])
    assert.ok(log[0].refNames.includes('main'), 'HEAD commit should be decorated with its branch')
  } finally { cleanup(repo) }
})

test('isLikelyProtectedBranch recognizes common mainline branch names', () => {
  assert.ok(isLikelyProtectedBranch('main'))
  assert.ok(isLikelyProtectedBranch('master'))
  assert.ok(isLikelyProtectedBranch('develop'))
  assert.ok(isLikelyProtectedBranch('release/1.0'))
  assert.ok(!isLikelyProtectedBranch('my-feature'))
})

// ── Tests: buildBranchStepItems (step 1) ────────────────────────────────────────

console.log('\nbuildBranchStepItems (step 1)')

test('pins HEAD and BRANCH POINT, then lists branches with current/parent/protected tags', () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1 on main')
    commit(repo, 'b', 'c2 on main')
    run(repo, 'git checkout -q -b feature')
    commit(repo, 'c', 'c3 on feature')
    commit(repo, 'd', 'c4 on feature')

    const { items, current, parent } = buildBranchStepItems(repo)
    assert.strictEqual(current.name, 'feature')
    assert.strictEqual(parent.branch, 'main')

    const headItem = items.find(i => i.label.includes('HEAD of current branch'))
    assert.ok(headItem, 'HEAD pin should be present')
    assert.ok(headItem.label.includes('(feature)'))
    assert.strictEqual(headItem.commitRef, current.hash)

    const branchPointItem = items.find(i => i.label.includes('BRANCH POINT'))
    assert.ok(branchPointItem, 'BRANCH POINT pin should be present')
    assert.ok(branchPointItem.label.includes("'main'"))
    assert.strictEqual(branchPointItem.commitRef, parent.mergeBase)

    const separators = items.filter(i => i.kind === vscodeMock.QuickPickItemKind.Separator)
    assert.strictEqual(separators.length, 1)
    assert.strictEqual(separators[0].label, 'Branches')

    const branchItems = items.filter(i => i.branchRef)
    const featureItem = branchItems.find(i => i.branchRef === 'feature')
    const mainItem = branchItems.find(i => i.branchRef === 'main')
    assert.ok(featureItem.description.includes('current'))
    assert.ok(mainItem.description.includes('BRANCH POINT parent'))
    assert.ok(mainItem.description.includes('protected'))
  } finally { cleanup(repo) }
})

test('falls back to a flat commit list when there are no branches at all (detached HEAD, no local branches)', () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1')
    const hash = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
    run(repo, `git checkout -q ${hash}`)
    run(repo, 'git branch -D main')

    const { items, current, parent } = buildBranchStepItems(repo)
    assert.strictEqual(current, null)
    assert.strictEqual(parent, null)
    assert.strictEqual(items.filter(i => i.kind === vscodeMock.QuickPickItemKind.Separator).length, 0)
    assert.ok(items.some(i => i.description && i.description.includes('c1')))
  } finally { cleanup(repo) }
})

test('works on a single-branch repo (no parent branch to detect)', () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'only commit')
    const { items, current, parent } = buildBranchStepItems(repo)
    assert.strictEqual(current.name, 'main')
    assert.strictEqual(parent, null)
    assert.ok(!items.some(i => i.label && i.label.includes('BRANCH POINT')))
    assert.ok(items.some(i => i.label && i.label.includes('HEAD of current branch (main)')))
  } finally { cleanup(repo) }
})

// ── Tests: matchesTyped ─────────────────────────────────────────────────────────

console.log('\nmatchesTyped')

test('matchesTyped is true when typed text appears in the label', () => {
  assert.strictEqual(matchesTyped({ label: '$(git-commit) abc1234', description: 'fix bug' }, 'abc1234'), true)
})

test('matchesTyped is true when typed text appears in the description', () => {
  assert.strictEqual(matchesTyped({ label: '$(git-commit) abc1234', description: 'fix bug' }, 'fix bug'), true)
})

test('matchesTyped is case-insensitive', () => {
  assert.strictEqual(matchesTyped({ label: 'ABC1234', description: '' }, 'abc1234'), true)
})

test('matchesTyped is false when typed text matches neither label nor description', () => {
  assert.strictEqual(matchesTyped({ label: '$(file-directory) Local files (current workspace)', description: '' }, 'f3a9c21e8b7d'), false)
})

// ── Tests: pickCommit — step 1 (pasted hash, pinned items, cancellation) ────────

console.log('\npickCommit — step 1')

testAsync('pasted hash is used even though the pinned "Local files" item is still active', async () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1')
    const hash = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()

    vscodeMock.window.createQuickPick.allReturned = []
    const promise = pickCommit(repo, 'Select version', { localFilesOption: true, noneOption: true })
    // Simulate: picker just opened, "None"/"Local files" are alwaysShow so VS Code
    // leaves one of them as the default active item; the user pastes an unrelated
    // commit hash into the box without touching the arrow keys.
    const qp = vscodeMock.window.createQuickPick.lastReturned
    assert.ok(qp, 'test mock should have captured the created QuickPick')
    qp.activeItems = [qp.items.find(i => i.commitRef === '')] // "Local files" still active
    qp.value = hash
    qp._accept()

    const result = await promise
    assert.strictEqual(result, hash, 'typed/pasted hash should win over the stale active item')
  } finally { cleanup(repo) }
})

testAsync('pressing Enter on the pinned HEAD item selects the current branch tip', async () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1')
    const expectedHash = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()

    vscodeMock.window.createQuickPick.allReturned = []
    const promise = pickCommit(repo, 'Select version', { localFilesOption: true })
    const qp = vscodeMock.window.createQuickPick.lastReturned
    const headItem = qp.items.find(i => i.label.includes('HEAD of current branch'))
    assert.ok(headItem, 'HEAD pin should be present for a repo with a branch')
    qp.activeItems = [headItem]
    qp.value = ''
    qp._accept()

    const result = await promise
    assert.strictEqual(result, expectedHash)
  } finally { cleanup(repo) }
})

testAsync('cancelling step 1 (hide without accept) resolves to null', async () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1')
    vscodeMock.window.createQuickPick.allReturned = []
    const promise = pickCommit(repo, 'Select version', { localFilesOption: true })
    const qp = vscodeMock.window.createQuickPick.lastReturned
    qp._hide()
    const result = await promise
    assert.strictEqual(result, null)
  } finally { cleanup(repo) }
})

// ── Tests: pickCommit — step 2 (drilling into a branch) ─────────────────────────

console.log('\npickCommit — step 2 (branch drill-down)')

testAsync('picking a branch item opens a second picker scoped to that branch, and selecting a commit returns its hash', async () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1 on main')
    commit(repo, 'b', 'c2 on main')
    const expectedHash = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()

    vscodeMock.window.createQuickPick.allReturned = []
    const promise = pickCommit(repo, 'Select version', { localFilesOption: true })

    // Step 1: pick the "main" branch item (not one of the pinned HEAD/BRANCH POINT items).
    const qp1 = vscodeMock.window.createQuickPick.lastReturned
    const branchItem = qp1.items.find(i => i.branchRef === 'main')
    assert.ok(branchItem, 'branch item for "main" should be present')
    qp1.activeItems = [branchItem]
    qp1.value = ''
    qp1._accept()

    // Allow the microtask queue to advance so step 2's picker gets created.
    await new Promise(r => setImmediate(r))

    // Step 2: a new QuickPick should have been created, scoped to commits on "main".
    const qp2 = vscodeMock.window.createQuickPick.lastReturned
    assert.notStrictEqual(qp2, qp1, 'step 2 should use a fresh QuickPick instance')
    assert.ok(qp2.items.length >= 2, 'step 2 should list commits from the chosen branch')
    const latestItem = qp2.items.find(i => i.commitRef === expectedHash)
    assert.ok(latestItem, 'the branch tip commit should be in the step-2 list')
    qp2.activeItems = [latestItem]
    qp2.value = ''
    qp2._accept()

    const result = await promise
    assert.strictEqual(result, expectedHash)
  } finally { cleanup(repo) }
})

testAsync('cancelling step 2 returns to step 1 instead of cancelling the whole picker', async () => {
  const repo = makeRepo()
  try {
    commit(repo, 'a', 'c1 on main')
    commit(repo, 'b', 'c2 on main')
    const expectedHash = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()

    vscodeMock.window.createQuickPick.allReturned = []
    const promise = pickCommit(repo, 'Select version', { localFilesOption: true })

    const qp1 = vscodeMock.window.createQuickPick.lastReturned
    const branchItem = qp1.items.find(i => i.branchRef === 'main')
    qp1.activeItems = [branchItem]
    qp1.value = ''
    qp1._accept()
    await new Promise(r => setImmediate(r))

    // Cancel step 2 (e.g. pressing Escape).
    const qp2 = vscodeMock.window.createQuickPick.lastReturned
    qp2._hide()
    await new Promise(r => setImmediate(r))

    // We should be back at a (new) step-1 picker, not resolved yet.
    const qp3 = vscodeMock.window.createQuickPick.lastReturned
    assert.notStrictEqual(qp3, qp2, 'returning from step 2 should re-show step 1')
    const headItem = qp3.items.find(i => i.label.includes('HEAD of current branch'))
    qp3.activeItems = [headItem]
    qp3.value = ''
    qp3._accept()

    const result = await promise
    assert.strictEqual(result, expectedHash)
  } finally { cleanup(repo) }
})

runAsyncTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
})
