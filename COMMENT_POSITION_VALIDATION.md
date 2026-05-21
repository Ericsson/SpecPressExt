# Comment Position Validation Feature

## Overview

Comments now track their exact position using a ±20 character snippet around the cursor that can span multiple lines. The system automatically detects when comments may have moved due to text edits and offers to update their positions.

## How It Works

### 1. Snippet Capture (±20 characters around cursor)

When adding a comment, the system captures 20 characters before and 20 characters after the cursor position. This snippet can span multiple lines.

**Example:**
```
Cursor at column 15 in line 5:
"This is a test|ing example"
         ↑ cursor here

Snippet captured: "This is a test|ing example"
(may include text from lines 4, 5, and 6 if cursor is near line boundaries)
```

**Implementation:** `addComment.js`
```javascript
const cursorOffset = document.offsetAt(editor.selection.active)
const startOffset = Math.max(0, cursorOffset - 20)
const endOffset = Math.min(document.getText().length, cursorOffset + 20)
const snippet = document.getText(new vscode.Range(startPos, endPos))
```

### 2. Position Validation

When displaying comments, the system validates each comment's position by:

1. **Exact Match** - Check if the snippet still exists at the original line/column
2. **Nearby Search** - If not found, search ±10 lines for the snippet
3. **Fuzzy Match** - Try normalized comparison (collapsed whitespace)

**Validation States:**
- ✅ `exact-match` - Comment is at correct position
- ⚠️ `moved` - Comment found at different position (with suggested location)
- ❌ `not-found` - Snippet not found nearby
- ❌ `line-out-of-range` - Line number exceeds document length
- ℹ️ `no-snippet` - Old comment without snippet (no validation possible)

**Implementation:** `commentPositionValidator.js`

### 3. Visual Indicators

Comments that may have moved are highlighted with:
- **Orange background** in the editor
- **Warning icon** in the gutter
- **Hover tooltip** showing:
  - ⚠️ WARNING: Comment position may have changed
  - Suggested new location (if found)
  - Original comment details

### 4. Position Update Command

**Command:** `SpecPress: Validate Comment Positions`

**Access:**
- Right-click in editor → SpecPress: Validate Comment Positions
- Command Palette (Ctrl+Shift+P)

**Workflow:**
1. Scans all comments in current file
2. Shows list of moved comments with suggested positions
3. User selects which comments to update
4. Updates comment JSON files with new positions and snippets
5. Refreshes decorations and tree view

## User Workflows

### Workflow 1: Addressing a Comment (Reconfirm Position)

**Common scenario:** You read a comment, make changes to address it, and want to update the comment's position.

1. Click on comment in tree view to see details
2. Read the comment and understand what needs to be changed
3. Make changes in the editor
4. Position cursor at the relevant location (where the comment should now point)
5. In detail pane, click **📍 Reconfirm Position** button
6. Comment position is updated to current cursor location
7. Click **✅ Resolve** or add a reply

**Why this is useful:**
- You've made changes, cursor is already at the right spot
- One click updates the comment's position
- No need to search for the comment's new location
- Works even if text has changed significantly

### Workflow 2: Detecting Moved Comments (Automatic Validation)

**Common scenario:** Someone else's comments have moved due to your edits (lines inserted/deleted).

1. Edit the file (insert/delete lines, refactor code)
2. Notice orange highlights on some comments
3. Hover over highlighted comment to see warning:
   - ⚠️ WARNING: Comment position may have changed
   - Suggested new location shown
4. Right-click → **SpecPress: Validate Comment Positions**
5. Review list of moved comments with suggested positions
6. Select which comments to update
7. System automatically updates positions

**Why this is useful:**
- Detects when OTHER people's comments have moved
- Suggests new positions automatically
- Batch update multiple comments at once
- Prevents comments from pointing to wrong code

## Use Cases

### Case 1: Line Inserted Above Comment
```
Original:
Line 10: // Some code
Line 11: function test() {  ← Comment here
Line 12:   return true

After inserting line:
Line 10: // Some code
Line 11: // New comment added
Line 12: function test() {  ← Comment should be here now
Line 13:   return true
```

**Result:** System finds snippet at line 12 and suggests update

### Case 2: Text Edited Around Comment
```
Original:
"This is a test|ing example"  ← Comment at |

After edit:
"This is a testing example"  ← Comment still valid (fuzzy match)
```

**Result:** Fuzzy match succeeds, no warning

### Case 3: Text Deleted
```
Original:
"This is a test|ing example"  ← Comment at |

After deletion:
"This is example"  ← Original text gone
```

**Result:** Snippet not found, shows warning

## Configuration

No configuration needed - feature is always active.

## Performance

- **Validation:** O(n) where n = number of comments in file
- **Search:** O(m × k) where m = search radius (±10 lines), k = line length
- **Caching:** Validation results are not cached (always fresh)
- **Impact:** Minimal - only validates when decorations are updated

## Limitations

1. **Search Radius:** Only searches ±10 lines from original position
2. **Whitespace Sensitivity:** Fuzzy match collapses whitespace but may miss some edits
3. **Large Edits:** If text is heavily refactored, snippet may not be found
4. **Old Comments:** Comments created before this feature have no snippet (no validation)

## Future Enhancements

1. **Auto-update:** Automatically update positions without user confirmation
2. **Configurable search radius:** Allow users to set search range
3. **Better fuzzy matching:** Use Levenshtein distance or similar algorithm
4. **Batch validation:** Validate all comments in workspace
5. **Git integration:** Track comment positions across commits
6. **Snippet regeneration:** Update snippets when comments are validated

## Technical Details

### Files Modified
- `addComment.js` - Capture ±20 char snippet around cursor
- `commentDecorations.js` - Validate positions and show warnings
- `commentPositionValidator.js` - NEW - Validation logic
- `validateCommentPositions.js` - NEW - Update command
- `extension.js` - Register command
- `package.json` - Add command and menu items

### Data Structure
```json
{
  "commentId": "user_abc123.json",
  "lineNumber": 10,
  "columnNumber": 15,
  "lineSnippet": "This is a test|ing example",
  "commentText": "Fix this typo",
  ...
}
```

### Validation Algorithm
```
1. Get snippet from comment JSON
2. Calculate position at original line/column
3. Extract ±20 chars at that position
4. Compare with stored snippet
   - If exact match → valid
   - If no match → search nearby
5. Search ±10 lines:
   - Try each column position
   - Extract ±20 chars
   - Compare exact and fuzzy
   - If found → return new position
6. If not found → mark as invalid
```

## Testing

### Manual Testing Scenarios

1. **Add comment** → Verify snippet captured correctly
2. **Insert line above** → Verify warning appears
3. **Run validate command** → Verify suggested position correct
4. **Update position** → Verify comment moves to new location
5. **Edit text around comment** → Verify fuzzy match works
6. **Delete commented text** → Verify "not found" warning

### Automated Tests (TODO)

```javascript
// Test snippet capture
test('captures ±20 chars around cursor', ...)

// Test validation
test('detects exact match', ...)
test('detects moved comment', ...)
test('detects deleted text', ...)

// Test search
test('finds snippet in nearby lines', ...)
test('fuzzy matches with whitespace changes', ...)

// Test update
test('updates comment position', ...)
test('updates snippet after move', ...)
```

## User Documentation

### Adding Comments
When you add a comment, SpecPress captures the surrounding text to track the comment's position. This allows the system to detect if the code changes and the comment needs to be moved.

### Moved Comment Warnings
If you see an orange highlight on a comment, it means the original text may have changed. Hover over the comment to see:
- Where the comment was originally placed
- Where the text might be now

### Updating Comment Positions
1. Right-click in the editor
2. Select "SpecPress: Validate Comment Positions"
3. Review the list of moved comments
4. Select which ones to update
5. Click OK

The comments will be moved to their new positions automatically.
