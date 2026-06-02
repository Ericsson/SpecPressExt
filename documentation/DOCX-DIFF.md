# DOCX DIFF - Multi-Version Comparison

The DOCX DIFF feature generates tracked-changes comparisons between 2-5 versions of your specification, producing a Word document with all changes clearly attributed to each version transition.

## Features

- **Multi-version support** - Compare 2-5 versions (commits or local files) in a single operation
- **Author attribution** - Each version transition gets its own author name in tracked changes
- **Smart defaults** - Author names default to commit hash + first 40 characters of commit message
- **CR-based filenames** - Automatically generates filenames from CR metadata when available
- **Headless processing** - Word runs invisibly in the background
- **Flexible selection** - Press Enter on "None" from the 3rd version onwards to finish early

## Basic Usage

1. **Select files/folders** in the VS Code Explorer
2. **Right-click** → "Compare as DOCX"
3. **Select versions** - Pick 2-5 commits or local files
4. **Enter author names** - For each version transition (smart defaults provided)
5. **Choose omitted markers** - Yes/No for excluded sections
6. **Save** - Choose location (filename auto-generated if CR exists)
7. **Open result** - Click "Open in Word" button in notification

## Version Selection

### Version 1 (Baseline)
- Select a commit (branch/tag/hash) or local files
- This is the starting point - no author name needed

### Version 2 (First revision)
- Select a commit or local files
- Enter author name for changes from v1 → v2
- **Smart default**: `{shortHash}_{first40charsOfMessage}`

### Version 3-5 (Optional)
- **"None" option** appears at top of picker (selected by default)
- Press **Enter** to finish with current versions
- Or select another commit/local files and provide author name
- Continue up to 5 versions total

### Example: 3-Version Comparison
```
v1: abc1234 (baseline)
v2: def5678 → author: "def5678_Fix_handover_procedure"
v3: local   → author: "LocalChanges"
```

Result: DOCX with two sets of tracked changes:
- "def5678_Fix_handover_procedure" (changes from v1 to v2)
- "LocalChanges" (changes from v2 to local files)

## Author Names

### Smart Defaults (Git Commits)
Format: `{shortHash}_{first40charsOfCommitMessage}`

Example commit: `Fix handover procedure in section 5.2`
→ Default author: `abc1234_Fix_handover_procedure_in_section_5.2`

- Spaces replaced with underscores
- Special characters removed: `<>:"/\|?*`
- Truncated to 40 characters (plus hash)

### Local Files
Default: `Author1`, `Author2`, etc.

You can edit any default before pressing Enter.

## Filename Generation

### With CR Metadata
If `spec/history/CRxxxx.json` exists:

Format: `YYYY-MM-DD_HH-MM-SS_{tdoc}_CR{number}[r{rev}]_{title}.docx`

Example:
```
2024-03-15_14-30-45_R19-38.413_CR1234r2_Correction_to_handover.docx
```

- Timestamp is current time (not CR Date field)
- CR number padded to 4 digits: `CR0042`
- Revision suffix omitted when rev = 0
- Title sanitized and truncated to 50 characters

### Without CR Metadata
Format: `YYYY-MM-DD HH-MM-SS DIFF_{v1}_{v2}_{v3}.docx`

Example:
```
2024-03-15 14-30-00 DIFF_abc1234_def5678_local.docx
```

## Technical Details

### How It Works
1. **Generate DOCX for each version** - Extracts files from git commits (or uses local files) and generates individual DOCX files
2. **Merge with tracked changes** - Uses Word's MergeDocuments API to combine versions, working backwards from last to first
3. **Preserve author attribution** - Sets both OriginalAuthor and RevisedAuthor parameters to maintain proper attribution across all versions
4. **Clean up** - Removes temporary files after successful generation

### VBScript Automation
The merge is performed by `scripts/merge-multi-version.vbs`:
- Runs Word headlessly (invisible, no dialogs)
- Merges backwards: v(N-1) + vN, then v(N-2) + result, etc.
- Sets both OriginalAuthor and RevisedAuthor for proper multi-author tracking
- Returns "Success" or error message for robust error handling

### Debug Mode
For troubleshooting, you can enable debug mode in `src/vscode/compareDocx.js`:

```javascript
const DEBUG_MODE = true  // Set to false to clean up temp files
```

When enabled:
- Keeps individual DOCX files for each version in `%TEMP%`
- Keeps intermediate merge files: `specpress_merged_v*.docx`
- Writes detailed log to `%TEMP%\specpress_merge_debug.log`

## Testing

### Automated Test Script
The `scripts/test-docx-diff.js` script automates testing without the VS Code UI:

```cmd
node scripts/test-docx-diff.js "C:\path\to\repo" commit1 commit2 [commit3] [commit4] [commit5|local]
```

**Features:**
- Validates commits and repository
- Auto-detects spec root directory
- Generates DOCX files for each version
- Calls VBScript to merge versions
- Reuses existing DOCX files (searches by pattern, ignoring timestamp)
- Outputs to `%TEMP%\specpress-test-output\`

**Examples:**
```cmd
node scripts/test-docx-diff.js "C:\repos\example-spec" abc1234 def5678 ghi9012
node scripts/test-docx-diff.js "C:\repos\example-spec" abc1234 def5678 local
node scripts/test-docx-diff.js "C:\repos\example-spec" abc1234 def5678 ghi9012 jkl3456 mno7890
```

## Troubleshooting

### No Word installed
Error: "Microsoft Word (winword.exe) is not installed or not accessible."

Solution: Install Microsoft Word. DOCX DIFF requires Word COM automation.

### Invalid commit reference
Error: "Invalid commit reference: xyz123"

Solution: Use `git log --oneline` to see available commits. You can use short hashes, full hashes, branch names, or tags.

### Wrong authors in tracked changes
1. Enable debug mode in `compareDocx.js`
2. Run DOCX DIFF again
3. Check log file at `%TEMP%\specpress_merge_debug.log`
4. Open intermediate files `%TEMP%\specpress_merged_v*.docx` in Word
5. Identify which merge produced wrong authors
6. Verify author names are passed correctly from JS to VBScript

### VBScript timeout
Error: "Word comparison timed out after 5 minutes"

Solution: Large specifications may need more time. Edit the timeout in `compareDocx.js`:
```javascript
setTimeout(() => {
  vbsProcess.kill()
  reject(new Error('Word comparison timed out after 5 minutes'))
}, 300000)  // Increase this value (in milliseconds)
```

## Limitations

1. **Requires Microsoft Word** - VBScript uses Word COM automation
2. **Windows only** - VBScript is Windows-specific
3. **Git repository required** - Cannot compare versions without git
4. **Maximum 5 versions** - Enforced for safety and performance
5. **Timing dependent** - Word automation may fail on very slow systems

## Performance

Approximate times for different version counts:

| Versions | Time Range |
|----------|------------|
| 2 | 5-10 seconds |
| 3 | 8-15 seconds |
| 4 | 12-20 seconds |
| 5 | 15-25 seconds |

Times vary based on:
- Specification size
- Number of images/diagrams
- System performance
- Word startup time

## Related Documentation

- [README.md](../README.md) - Main extension documentation
- [CR Cover Page](https://github.com/Ericsson/specpress/blob/main/documentation/CR-Cover-Page.md) - CR metadata format
- [specpress README](https://github.com/Ericsson/specpress) - Core conversion library
