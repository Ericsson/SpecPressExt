# DOCX DIFF - Multi-Version Comparison

The DOCX DIFF feature generates tracked-changes comparisons between 2-5 versions of your specification, producing a Word document with all changes clearly attributed to each version transition.

It requires either Microsoft Word or LibreOffice to be installed locally.

## Features

- **Multi-version support** - Compare 2-5 versions (commits or local files) in a single operation
- **Author attribution** - Each version transition gets its own author name in tracked changes
- **Smart defaults** - Author names default to commit hash + first 40 characters of commit message
- **CR-based filenames** - Automatically generates filenames from CR metadata when available
- **Cross-platform** - Works with Microsoft Word (Windows) or LibreOffice (Windows, Linux, macOS)
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

### Baseline (Version 1)

- Select a commit (branch/tag/hash) or local files
- This is the starting point - no author name needed

### First Revision (Version 2)

- Select a commit or local files
- Enter author name for changes from v1 → v2
- **Smart default**: `{shortHash}_{first40charsOfMessage}`

### Additional Revisions (Version 3-5)

- **"None" option** appears at top of picker (selected by default)
- Press **Enter** to finish with current versions
- Or select another commit/local files and provide author name
- Continue up to 5 versions total

### Example: 3-Version Comparison

```text
v1: abc1234 (baseline)
v2: def5678 → author: "def5678_Fix_handover_procedure"
v3: local   → author: "LocalChanges"
```

Result: DOCX with two sets of tracked changes:

- "def5678_Fix_handover_procedure" (changes from v1 to v2)
- "LocalChanges" (changes from v2 to local files)

## Author Names

### Smart Defaults for Git Commits

Format: `{shortHash}_{first40charsOfCommitMessage}`

Example commit: `Fix handover procedure in section 5.2`
→ Default author: `abc1234_Fix_handover_procedure_in_section_5.2`

- Spaces replaced with underscores
- Special characters removed: `<>:"/\|?*`
- Truncated to 40 characters (plus hash)

### Defaults for Local Files

Default: `Author1`, `Author2`, etc.

You can edit any default before pressing Enter.

## Filename Generation

### With CR Metadata

If `spec/history/CRxxxx.json` exists:

Format: `YYYY-MM-DD_HH-MM-SS_{tdoc}_CR{number}[r{rev}]_{title}.docx`

Example:

```text
2024-03-15_14-30-45_R19-38.413_CR1234r2_Correction_to_handover.docx
```

- Timestamp is current time (not CR Date field)
- CR number padded to 4 digits: `CR0042`
- Revision suffix omitted when rev = 0
- Title sanitized and truncated to 50 characters

### Without CR Metadata

Format: `YYYY-MM-DD HH-MM-SS DIFF_{v1}_{v2}_{v3}.docx`

Example:

```text
2024-03-15 14-30-00 DIFF_abc1234_def5678_local.docx
```

## Debug Mode

For troubleshooting, you can enable debug mode in `src/vscode/compareDocx.js`:

```javascript
const DEBUG_MODE = true  // Set to false to clean up temp files
```

When enabled:

- Keeps individual DOCX files for each version in `%TEMP%`
- Keeps intermediate merge files: `specpress_merged_v*.docx`
- Writes detailed log to `%TEMP%\specpress_merge_debug.log`

## CLI and CI Usage

The DOCX DIFF functionality is also available from the command line for CI pipelines and automation. When using the CLI, the `--authors` parameter can be omitted to derive the author name automatically from the CR cover page data:

- If `CR` field is present → `CR0042` (zero-padded); if absent → `CRxxxx`
- If `Source to WG` has entries → append first entry (e.g. `CR0042_Ericsson`)
- Otherwise if `Source to TSG` has entries → append first entry (e.g. `CRxxxx_RAN3`)

For full CLI documentation, CI pipeline templates, and backend implementation details, see the [specpress DOCX DIFF documentation](https://github.com/Ericsson/specpress/blob/main/documentation/DOCX-DIFF-Headless.md).

## Troubleshooting

### No Merge Backend Available

Error: "No merge backend available. Install Microsoft Word (Windows) or LibreOffice."

Solution: Install Microsoft Word or LibreOffice Writer.

### Invalid Commit Reference

Error: "Invalid commit reference: xyz123"

Solution: Use `git log --oneline` to see available commits. You can use short hashes, full hashes, branch names, or tags.

### Wrong Authors in Tracked Changes

1. Enable debug mode in `compareDocx.js`
2. Run DOCX DIFF again
3. Check log file at `%TEMP%\specpress_merge_debug.log`
4. Open intermediate files `%TEMP%\specpress_merged_v*.docx` in Word
5. Identify which merge produced wrong authors

### Merge Timeout

Error: "Word comparison timed out after 5 minutes" or "LibreOffice comparison timed out after 5 minutes"

Solution: Large specifications may need more time. The timeout is 5 minutes by default.

### LibreOffice Process Not Terminating

On Windows, the extension uses `taskkill /F /T /PID` to kill the entire LibreOffice process tree. If you see orphaned `soffice.exe` processes, kill them manually via Task Manager.

## Limitations

1. **Git repository required** - Cannot compare versions without git
2. **Maximum 5 versions** - Enforced for safety and performance
3. **LibreOffice: 1 revision** - Currently supports single comparison per invocation
4. **SVG rendering in LibreOffice** - Some diagram types display incorrectly in LibreOffice but correctly in Word

## Related Documentation

- [specpress DOCX DIFF (CLI/CI)](https://github.com/Ericsson/specpress/blob/main/documentation/DOCX-DIFF-Headless.md) - Command-line usage, CI pipeline templates, and backend details
- [CR Cover Page](https://github.com/Ericsson/specpress/blob/main/documentation/CR-Cover-Page.md) - CR metadata format
- [specpress README](https://github.com/Ericsson/specpress) - Core conversion library
