# Commenting Documents

## Overview

The SpecPress commenting system enables collaborative review of specification documents directly within VS Code. Comments are stored as individual JSON files alongside your specification, making them git-friendly and easy to merge.

**Key Features:**
- **Precise positioning** - Comments attached to specific line and column positions
- **Threaded conversations** - Unlimited nested replies
- **Resolve workflow** - Mark comments as resolved when addressed
- **Position tracking** - Automatic detection when comments move due to text edits
- **Multi-author support** - Collision warnings when editing others' comments
- **Rich filtering** - Search by text, author, or resolution status
- **Live preview** - See comment context in hover tooltips and detail view

## Quick Start

### Adding a Comment

1. **Position your cursor** where you want to comment
2. **Right-click** and select `SpecPress: Add Comment`
3. **Enter your comment text** in the input box
4. **Press Enter** to save

The comment appears in the Comments tree view and is marked in the editor with a colored indicator.

### Viewing Comments

**Tree View** (left sidebar):
- Shows all comments grouped by file
- Click any comment to see full details
- Icons indicate status:
  - ❗ Red: Unresolved
  - ✓ Yellow: Resolved but has unresolved replies
  - ✅ Green: Fully resolved

**Editor Indicators**:
- **Gutter icons** - Orange speech bubble (unresolved) or green checkmark (resolved) in the left margin
- **Column markers** - Vertical bar at the exact cursor position where comment was created
- **Hover tooltips** - Rich preview showing all comments when hovering over gutter icon
- **Overview ruler** - Colored markers in the scrollbar for quick navigation to comments

**Interacting with Editor Indicators:**
- Click the **gutter icon** to jump to the comment in the tree view
- **Hover** over the gutter icon to see a quick preview without opening the detail pane

### Replying to Comments

1. **Click a comment** in the tree view to open details
2. **Click the Reply button** in the detail pane
3. **Enter your reply** and press Enter
4. Replies are nested and indented for clarity

### Resolving Comments

1. **Click a comment** in the tree view
2. **Click the ✅ Resolve button** in the detail pane
3. If the comment has unresolved replies, you'll be prompted to confirm

Resolved comments turn green in the tree view but remain visible until deleted.

## Comment Positioning

### How Positions Are Tracked

When you add a comment, SpecPress captures:
- **Line number** - The line where the cursor was positioned
- **Column number** - The exact character position within the line
- **Context snippet** - Up to 20 characters BEFORE the cursor position

This snippet allows SpecPress to detect when the commented text has moved due to edits. By capturing text before the cursor, comments remain anchored even when you make changes at or after the cursor position.

**Example:**
```
Original text at line 10, column 25:
"This is a test example for commenting"
                         ↑ cursor here

Snippet captured: "a test example for c"
                  (20 chars before cursor)
```

### Line Tolerance

Comments remain visible even if lines shift slightly due to edits elsewhere in the document. The gutter icons, column markers, and overview ruler update automatically as you edit, maintaining visual continuity. When the snippet can't be found at the original position, SpecPress searches ±10 lines to locate it.

### Position Validation

SpecPress automatically validates comment positions when you open a file. If the original text has moved, you'll see:

- **Orange highlight** on the comment in the editor
- **Warning icon** (⚠️) in the gutter
- **Hover tooltip** showing:
  - Warning that position may have changed
  - Suggested new location (if found)
  - Original comment details

### Updating Comment Positions

**Automatic Update (on save):**

SpecPress automatically updates comment positions when you save a file:
- Searches for the snippet within ±10 lines of the original position
- Updates the position if found unambiguously (only one match)
- Skips update if snippet appears multiple times or not found
- Works silently in the background - no user action needed

**Manual Update (Set Anchor Position):**

Use this when:
- Auto-update couldn't find the snippet (large refactor, text changed significantly)
- Snippet appears multiple times (ambiguous match)
- You want to explicitly reposition a comment

Steps:
1. **Position your cursor** where the comment should now point
2. **Click the comment** in the tree view to open details
3. **Click 📍 Set Anchor Position** button
4. The comment position updates to your current cursor location

**Batch Validation:**

Use this to review multiple moved comments at once:

1. **Right-click** in the editor
2. **Select `SpecPress: Validate Comment Positions`**
3. **Review the list** of moved comments with suggested positions
4. **Select which comments to update** (or select all)
5. **Click OK** to update positions

SpecPress searches ±10 lines from the original position to find the snippet. If found, it suggests the new location.

### Position Validation States

- ✅ **Exact match** - Comment is at the correct position
- ⚠️ **Moved** - Comment found at a different position (update suggested)
- ❌ **Not found** - Snippet not found nearby (manual review needed)
- ❌ **Line out of range** - Line number exceeds document length
- ℹ️ **No snippet** - Comment without position tracking (e.g., at start of line)

**Note:** Comments placed at column 0 (start of line) have no snippet since there are no characters before the cursor. These comments are validated by line number only.

## Filtering Comments

The Comments tree view includes powerful filtering options:

### Filter Panel

Click the filter icon (🔍) in the tree view toolbar to open the filter panel.

**Filter Options:**
- **Search text** - Find comments containing specific words
- **Author** - Show only comments by a specific user
- **Unresolved only** - Hide resolved comments

**Active Filters:**
- Displayed as badges in the filter panel
- Click the ✕ on any badge to remove that filter
- Click "Clear All Filters" to reset

### Quick Filters

- **Show only unresolved** - Toggle button in tree view toolbar
- **Search** - Type in the search box at the top of the tree view

## Comment Details

### Detail View

When you click a comment in the tree view, the detail pane shows:

**Parent Comment:**
- Author and timestamp
- Full comment text (markdown rendered)
- Resolution status
- Action buttons (Edit, Reply, Resolve, Delete)

**Nested Replies:**
- Indented 20px per nesting level
- Each reply shows author, timestamp, and text
- Each reply has its own Edit/Reply/Resolve/Delete buttons

### Editing Comments

**Double-click** any comment or reply to edit it:

1. **Double-click** the comment text in the detail view
2. An **inline editor** appears with markdown toolbar
3. **Edit the text** using the toolbar buttons:
   - **B** - Bold
   - **I** - Italic
   - **`** - Inline code
   - **↵** - Line break
4. **Click Save** or press Ctrl+Enter to save
5. **Click Cancel** or press Escape to discard changes

**Multi-author Warning:**
If you edit another user's comment, you'll see a warning prompt. This helps prevent accidental overwrites.

### Markdown Support

Comments support basic markdown formatting:

- **Bold** - `**text**` or use toolbar button
- **Italic** - `*text*` or use toolbar button
- **Code** - `` `code` `` or use toolbar button
- **Line breaks** - Two spaces + Enter, or use toolbar button
- **Links** - `[text](url)`
- **Lists** - Start line with `-` or `1.`

## File Structure

Comments are stored in a `comments/` folder as a sibling to your specification root:

```
workspace/
  spec/                    ← specificationRootPath
    01 Scope/
      00 Scope.md
    02 References/
      00 References.md
  comments/                ← Comment storage
    user1_abc123.json      ← Parent comment
    user2_def456.json      ← Reply to abc123
    user1_ghi789.json      ← Another parent comment
```

### Comment File Format

Each comment is stored as a JSON file with the following structure:

```json
{
  "commentId": "user1_abc123.json",
  "filePath": "spec/01 Scope/00 Scope.md",
  "lineNumber": 10,
  "columnNumber": 15,
  "lineSnippet": "a test example for c",
  "commentText": "Please clarify this section",
  "author": "user1",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "resolved": false,
  "resolvedBy": null,
  "resolvedInCommit": null,
  "parentCommentId": null
}
```

**Key Fields:**
- `commentId` - Unique identifier (filename)
- `filePath` - Relative path from spec root
- `lineNumber` - Line position (0-based)
- `columnNumber` - Column position (0-based)
- `lineSnippet` - Up to 20 chars before cursor for position tracking
- `parentCommentId` - For replies, the parent comment's ID
- `resolvedBy` - User ID who resolved the comment
- `resolvedInCommit` - Git commit hash when comment was resolved (if available)

**Git Integration:**

SpecPress automatically tracks git commit hashes when available:
- Comments capture the current commit hash when created
- Resolution captures the commit hash when marked as resolved
- This helps track which version of the spec a comment refers to

## Common Workflows

### Workflow 1: Reviewing a Document

1. **Open the document** in VS Code
2. **Open the Comments view** (left sidebar)
3. **Click each comment** to see details
4. **Add replies** with questions or feedback
5. **Resolve comments** as issues are addressed

### Workflow 2: Addressing Review Comments

1. **Filter to unresolved comments** in your file
2. **Click a comment** to see what needs to be changed
3. **Make the necessary edits** in the document
4. **Add a reply** explaining what you changed
5. **Click ✅ Resolve** to mark as addressed

**Note:** If your edits move the comment location, SpecPress will automatically update the position when you save the file (if the snippet is found within ±10 lines). For larger moves or ambiguous cases, use the "Set Anchor Position" button to manually update the comment location.

### Workflow 3: Handling Moved Comments

**Automatic Update (on save):**
- SpecPress automatically updates comment positions when you save a file
- Works when the snippet is found unambiguously within ±10 lines
- No action needed for simple edits (insert/delete lines)

**Manual Update (for complex cases):**
1. **Edit the document** (large refactors, ambiguous moves)
2. **Notice orange highlights** on some comments that couldn't auto-update
3. **Click the comment** in the tree view to open details
4. **Position your cursor** where the comment should now point
5. **Click 📍 Set Anchor Position** to update the comment location

**Alternative: Batch validation** (for reviewing multiple moved comments):
1. **Right-click** in the editor → `SpecPress: Validate Comment Positions`
2. **Review suggested positions** for moved comments
3. **Select comments to update** (or select all)
4. **Click OK** to batch update positions

### Workflow 4: Collaborative Review

1. **Author A** adds comments throughout the document
2. **Author B** pulls the changes (git pull)
3. **Author B** sees comments in the tree view
4. **Author B** adds replies to each comment
5. **Author A** pulls replies and addresses them
6. **Both authors** resolve comments as issues are fixed

## Configuration

The commenting system requires two settings to be configured in your workspace settings (`.vscode/settings.json`):

```json
{
  "specpress.specificationRootPath": "spec",
  "specpress.commentFolder": "comments"
}
```

### Required Settings

**specpress.specificationRootPath**
- Defines where your specification files are located
- Comments are associated with files in this directory

**specpress.commentFolder** (Required for security)
- Defines where comment files are stored
- **Must be explicitly configured** - no default value
- Relative paths are resolved from the parent of spec root
  - Example: `"comments"` creates `workspace/comments/` (sibling to `workspace/spec/`)
- Absolute paths are allowed but use with caution
- **Security note:** Comments are stored outside spec root by default

### Optional Settings

**specpress.userId** and **specpress.userName**
- Your identifier and display name for comments
- Required when creating comments
- Example:
  ```json
  {
    "specpress.userId": "jsmith",
    "specpress.userName": "John Smith"
  }
  ```

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Add comment | Right-click → SpecPress: Add Comment |
| Validate positions | Right-click → SpecPress: Validate Comment Positions |
| Save edit | Ctrl+Enter (in editor) |
| Cancel edit | Escape (in editor) |

## Troubleshooting

### Comments Not Appearing

**Problem:** Added a comment but it doesn't show in the tree view.

**Solutions:**
- Verify `specpress.specificationRootPath` is configured
- Check that the file is inside the spec root
- Refresh the tree view (click refresh icon)
- Check the `comments/` folder exists and contains JSON files

### Orange Highlights After Editing

**Problem:** Some comments show orange highlights after editing.

**Explanation:**
- SpecPress automatically updates comment positions on save when possible
- Orange highlights appear when auto-update couldn't find the snippet:
  - Snippet appears multiple times (ambiguous)
  - Snippet not found within ±10 lines
  - Text changed significantly

**Solutions:**
- **For individual comments:** Click the comment, position cursor, click 📍 Set Anchor Position
- **For multiple comments:** Run `SpecPress: Validate Comment Positions` to review and batch update
- **If text is unchanged:** The snippet may be at column 0 (no snippet captured) - these are validated by line number only

### Position Validation Not Finding Comments

**Problem:** Validation says "not found" but the text is still there.

**Solutions:**
- The text may have changed significantly (fuzzy match failed)
- The snippet may have moved more than 10 lines from the original position
- Manually update the position:
  1. Position cursor at the correct location
  2. Click the comment in tree view
  3. Click 📍 Set Anchor Position
- For comments at column 0 (start of line), there's no snippet to search for

### Can't Edit Another User's Comment

**Problem:** Warning appears when trying to edit someone else's comment.

**Solutions:**
- This is intentional to prevent accidental overwrites
- Click "Yes" in the warning dialog to proceed
- Or add a reply instead of editing the original comment

### Comments Disappeared After Git Pull

**Problem:** Comments missing after pulling changes.

**Solutions:**
- Check if the `comments/` folder was committed to git
- Verify the JSON files are present in the `comments/` folder
- Refresh the tree view
- Check git status for uncommitted changes

## Best Practices

### For Authors

1. **Commit comments with code** - Include the `comments/` folder in git
2. **Use descriptive text** - Make comments clear and actionable
3. **Reply to feedback** - Explain what you changed when resolving
4. **Let auto-update work** - Comment positions update automatically on save in most cases
5. **Manual updates when needed** - Use Set Anchor Position for large refactors or ambiguous cases
6. **Resolve when done** - Mark comments resolved to track progress

### For Reviewers

1. **Be specific** - Point to exact locations with comments
2. **Use replies** - Keep conversations threaded
3. **Check resolved comments** - Verify fixes before closing
4. **Trust auto-update** - Positions update automatically when you pull changes
5. **Manual review for orange highlights** - Use Set Anchor Position or batch validation for comments that couldn't auto-update
6. **Filter effectively** - Use filters to focus on relevant comments

### For Teams

1. **Establish conventions** - Agree on when to resolve vs. delete
2. **Trust auto-update** - Most position updates happen automatically on save
3. **Review cycles** - Use unresolved filter to track open items
4. **Git workflow** - Commit comments in separate commits for clarity
5. **Archive resolved** - Periodically delete old resolved comments
6. **Manual validation for major refactors** - Run batch validation after large structural changes

## Limitations

1. **Search radius** - Auto-update and validation only search ±10 lines from original location
2. **Snippet at column 0** - Comments at the start of a line have no snippet (no chars before cursor)
3. **Ambiguous matches** - If snippet appears multiple times, auto-update skips and requires manual update
4. **Large refactors** - Heavy text changes may require manual position updates via Set Anchor Position
5. **Whitespace sensitivity** - Fuzzy matching may miss some formatting changes
6. **Binary files** - Commenting only works on text files (markdown, ASN.1, etc.)

## Related Features

- **Change Tracking Preview** - See tracked changes in live preview (see main README)
- **DOCX DIFF** - Generate tracked-changes comparison documents (see main README)
- **Multi-File Preview** - Preview multiple files with comments visible (see main README)

## Related Files

**Extension Code:**
- `src/vscode/commenting/commentManager.js` - Core comment operations
- `src/vscode/commenting/commentTreeProvider.js` - Tree view
- `src/vscode/commenting/commentDetailViewProvider.js` - Detail pane
- `src/vscode/commenting/commentPositionValidator.js` - Position validation logic

**Storage:**
- `comments/*.json` - Individual comment files (sibling to spec root)

## Future Enhancements

Potential features under consideration:

- **Mention system** - @username notifications
- **Comment search** - Full-text search across all comments
- **Export comments** - Generate report of all comments
- **Comment statistics** - Dashboard with metrics
- **Batch operations** - Resolve all, delete all resolved
- **Comment templates** - Pre-defined comment types
