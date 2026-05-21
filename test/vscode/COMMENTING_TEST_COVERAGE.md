# SpecPress Commenting System - Test Coverage

## Test Suite: `test/vscode/commenting.test.js`

### Current Test Coverage (22 tests, all passing)

#### 1. Basic Operations (11 tests)
- ✅ Generates unique comment IDs with author prefix
- ✅ Normalizes file URIs to forward slashes
- ✅ Creates comment with all required fields
- ✅ Creates reply with replyTo field set
- ✅ Throws error when userId or userName not configured
- ✅ Updates comment text and timestamp
- ✅ Resolves comment with resolvedBy and resolvedInCommit
- ✅ Unresolves comment and clears resolvedBy
- ✅ Finds comments for specific file
- ✅ getAllComments returns all comments
- ✅ getAllComments returns empty array for non-existent folder

#### 2. Cache Performance (7 tests)
**Tests the performance improvements we implemented to fix slow response times**
- ✅ Caches getAllComments results (verifies same reference returned)
- ✅ invalidateCache clears cache for specific spec root
- ✅ Cache invalidated after createComment
- ✅ Cache invalidated after updateComment
- ✅ Cache invalidated after resolveComment
- ✅ Cache expires after timeout (5 minutes)
- ✅ clearCache clears all caches

**What these tests verify:**
- Cache prevents redundant file I/O operations
- Cache is properly invalidated on all write operations
- Cache timeout works as safety fallback
- Multiple spec roots can be cached independently

#### 3. Nested Replies (1 test)
- ✅ Creates nested reply chain (reply to reply)

#### 4. Error Handling (3 tests)
- ✅ updateComment throws for non-existent comment
- ✅ resolveComment throws for non-existent comment
- ✅ Skips invalid JSON files in getAllComments

---

## Issues Discovered During Development & How Tests Address Them

### Issue 1: Slow Response Times (10+ seconds)
**Root Cause:** O(n²) file operations - every comment in tree view triggered full directory scan
**Fix:** Implemented 5-minute cache with immediate invalidation on writes
**Tests:**
- "caches getAllComments results" - verifies caching works
- "cache invalidated after createComment/updateComment/resolveComment" - verifies cache stays fresh
- "cache expires after timeout" - verifies safety fallback

### Issue 2: Editor Not Closing (Cancel/Save buttons unresponsive)
**Root Cause:** Full HTML refresh blocked UI, lost DOM state
**Fix:** Webview-side DOM restoration, removed blocking updateView() calls
**Tests:** Not directly tested (requires webview integration testing)
**Manual Testing Required:** Double-click edit, cancel, save operations

### Issue 3: Lost HTML/DOM Context
**Root Cause:** Full page reload destroyed edit state
**Fix:** Store rendered HTML in data attributes, restore instantly on cancel
**Tests:** Not directly tested (requires webview testing)
**Manual Testing Required:** Edit comment, cancel, verify content restored

---

## Recommended Additional Tests

### High Priority

#### CommentTreeProvider Tests
```javascript
// Test tree structure and filtering
- builds correct tree hierarchy (files → comments → replies)
- filters by text search
- filters by author
- filters unresolved only (keeps resolved parents with unresolved children)
- counts replies correctly
- detects unresolved replies correctly
- sorts comments by line then column
- sorts replies by timestamp
```

#### CommentDetailViewProvider Tests
```javascript
// Test HTML generation and rendering
- renders parent comment with location info
- renders nested replies with correct indentation (20px per level)
- escapes HTML in comment text
- escapes attributes correctly (newlines, quotes)
- builds reply tree recursively
- shows correct status icons (red/yellow/green)
- includes all buttons (Resolve/Unresolve, Reply, JSON, Delete)
- hides Delete button when comment has replies
```

#### Cache Invalidation Integration Tests
```javascript
// Test FileSystemWatcher integration
- cache invalidated when external file created
- cache invalidated when external file modified
- cache invalidated when external file deleted
- cache invalidated when JSON file saved in editor
```

### Medium Priority

#### Collision Warning Tests
```javascript
// Test multi-author scenarios
- warns when editing another author's comment
- warns when resolving another author's comment
- warns when unresolving another author's comment
- allows operation after confirmation
- cancels operation when user declines
```

#### Smart Resolve Tests
```javascript
// Test resolve with unresolved replies
- detects unresolved replies when resolving parent
- offers to resolve user's own replies
- does not offer to resolve other users' replies
- resolves only selected replies when user chooses "Yes"
- resolves only parent when user chooses "No"
```

#### Nested Reply Tree Tests
```javascript
// Test complex reply structures
- handles 3+ levels of nesting
- correctly identifies all descendants
- counts total replies recursively
- detects unresolved replies at any depth
```

### Low Priority (Integration/E2E)

#### Webview Interaction Tests
```javascript
// Requires VS Code test environment
- double-click starts edit mode
- cancel button restores original content
- save button updates comment
- toolbar buttons insert markdown
- resolve button updates status
- reply button opens input dialog
```

#### Decoration Tests
```javascript
// Test visual indicators in editor
- shows column markers at correct positions
- updates decorations when comments added
- updates decorations when comments resolved
- clears decorations when comments deleted
```

#### CodeLens Tests
```javascript
// Test inline comment indicators
- shows comment count on correct lines
- updates when comments added/removed
- clicking opens comment in sidebar
```

#### Hover Provider Tests
```javascript
// Test hover tooltips
- shows nearest parent comment at cursor
- includes nested replies
- shows correct status icons
- includes "Show Comment" link
```

---

## Performance Benchmarks (Manual Testing)

### Before Cache Implementation
- Tree view with 20 comments: ~400+ file reads
- Detail view render: 3-5 full directory scans
- Edit save operation: 10+ seconds

### After Cache Implementation
- Tree view with 20 comments: 1 file read (cached)
- Detail view render: 0 file reads (cached)
- Edit save operation: <100ms

---

## Test Execution

Run all tests:
```bash
npm test
```

Run only commenting tests:
```bash
node test/vscode/commenting.test.js
```

Run quick tests (skip slow tests):
```bash
npm run test:quick
```

---

## Notes for Future Test Development

1. **Webview Testing:** VS Code webview testing requires the full extension host environment. Consider using `@vscode/test-electron` for integration tests.

2. **FileSystemWatcher Testing:** Requires actual file system operations and VS Code workspace. Best tested in integration test suite.

3. **Mock Strategy:** Current tests use minimal mocks (vscode module only). This keeps tests fast and focused on business logic.

4. **Temp Directory Cleanup:** All tests create isolated temp directories and clean up after themselves to prevent test pollution.

5. **Cache Timeout Override:** Tests override `_cacheTimeout` to 50ms for fast cache expiration testing without waiting 5 minutes.

6. **Git Operations:** Tests that call `getCurrentCommitHash()` will see "fatal: not a git repository" warnings. This is expected and handled gracefully by the code.
