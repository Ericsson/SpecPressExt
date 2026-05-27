# CR Cover Pages

## Overview

The CR (Change Request) cover page feature allows you to generate 3GPP-style Change Request documents with a standardized cover page. CR cover pages are defined in JSON files and can be used in both DOCX exports and HTML previews.

**Key Features:**
- **JSON-based** - CR data stored in simple JSON files
- **Validation** - Comprehensive validation with clear error messages
- **Interactive selection** - Choose between CR cover page, standard front page, or no front page
- **Draft and approved CRs** - Support for both draft (CRxxxx.json) and approved (CR####.json) CRs
- **Standalone export** - Export CR cover page as standalone DOCX
- **Preview integration** - See CR cover page in live preview

## Quick Start

### Creating a CR Cover Page

1. **Create a `history/` folder** in your specification root:
   ```
   spec/
     01 Scope/
     02 References/
     history/          ← Create this folder
   ```

2. **Create a draft CR file** named `CRxxxx.json`:
   ```json
   {
     "crNumber": 1234,
     "revNumber": 0,
     "title": "Add new feature X",
     "source": "Company A",
     "toTSG": "SA WG2",
     "tdocNumber": "S2-2401234",
     "specNumber": "23.501",
     "version": "18.5.0",
     "crType": "F",
     "category": "B",
     "workItemCodes": ["FS_NewFeature"],
     "affectedSpecs": ["23.501"],
     "affectedParts": [],
     "mirrorCR": false,
     "useForRelease": true
   }
   ```

3. **Export with CR cover page**:
   - Select your spec root folder
   - Right-click → `SpecPress: Export Selected to DOCX`
   - Choose "CR Cover Page (CRxxxx.json)" from the dialog
   - Save the DOCX file

### Exporting Standalone CR Cover Page

You can export just the CR cover page without any specification content:

1. **Navigate to** `spec/history/` folder
2. **Right-click** on a CR JSON file (e.g., `CR1234.json`)
3. **Select** `SpecPress: Export Selected to DOCX`
4. The extension exports only the CR cover page as a DOCX file

This is useful for:
- Creating CR templates
- Reviewing CR metadata before adding content
- Generating cover pages for manual assembly

## CR File Format

### File Naming Convention

**Draft CRs** (work in progress):
- Filename: `CRxxxx.json` (four x's, case insensitive)
- Location: `spec/history/CRxxxx.json`
- Used during development before CR number is assigned

**Approved CRs** (with assigned number):
- Filename: `CR####.json` (four digits, e.g., `CR1234.json`)
- Location: `spec/history/CR1234.json`
- Used after CR is approved and numbered

### Required Fields

All CR JSON files must include these fields:

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `crNumber` | number | 0-9999 | CR number (use 0 for draft) |
| `title` | string | - | Brief description of the change |
| `source` | string | - | Company or organization submitting the CR |
| `toTSG` | string | - | Target TSG working group (e.g., "SA WG2") |
| `tdocNumber` | string | - | TDoc number (e.g., "S2-2401234") |
| `specNumber` | string | - | Specification number (e.g., "23.501") |
| `version` | string | - | Specification version (e.g., "18.5.0") |
| `crType` | string | - | CR type: F (correction), A (mirror), B (addition), C (functional), D (editorial) |
| `category` | string | - | Category: A (essential), B (mirror), C (desirable), D (optional), F (correction) |

### Optional Fields

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `revNumber` | number | 0-99 | Revision number (0 or omit for "-") |
| `workItemCodes` | array | - | Array of work item codes (e.g., ["FS_NewFeature"]) |
| `affectedSpecs` | array | - | Array of affected specification numbers |
| `affectedParts` | array | - | Array of affected parts/sections |
| `mirrorCR` | boolean | - | True if this is a mirror CR |
| `useForRelease` | boolean | - | True if intended for next release |

### Example CR File

```json
{
  "crNumber": 1234,
  "revNumber": 1,
  "title": "Correction to procedure X in clause 5.2.3",
  "source": "Ericsson",
  "toTSG": "SA WG2",
  "tdocNumber": "S2-2401234",
  "specNumber": "23.501",
  "version": "18.5.0",
  "crType": "F",
  "category": "A",
  "workItemCodes": ["5G_eNA"],
  "affectedSpecs": ["23.501", "23.502"],
  "affectedParts": ["Clause 5.2.3", "Annex A"],
  "mirrorCR": false,
  "useForRelease": true
}
```

## Using CR Cover Pages

### DOCX Export with CR Cover Page

When exporting a specification root folder to DOCX, SpecPress automatically detects available front page options:

1. **Select spec root** folder in VS Code explorer
2. **Right-click** → `SpecPress: Export Selected to DOCX`
3. **Choose version** (local files or git commit)
4. **Select front page type** from the dialog:
   - **CR Cover Page (CRxxxx.json)** - Uses the detected CR file
   - **Standard Front Page** - Uses configured front page template
   - **No Front Page** - Exports without front page

If only one option is available (e.g., only CR cover page), it's used automatically.

### Preview with CR Cover Page

When previewing a specification root folder, SpecPress automatically includes the CR cover page if available:

1. **Select spec root** folder in VS Code explorer
2. **Right-click** → `SpecPress: Preview Selected`
3. **Press Enter** to preview local version
4. The preview shows the CR cover page followed by the specification content

### Validation

SpecPress validates CR data before using it. If validation fails:

**During Export:**
- Error dialog shows all validation errors
- "Open CR File" button opens the JSON file for editing
- Export is cancelled until errors are fixed

**During Preview:**
- Error notification shows validation errors
- "Open CR File" button opens the JSON file for editing
- Preview shows without CR cover page

### Common Validation Errors

**Missing required field:**
```
Missing required field: title
```
**Solution:** Add the missing field to your JSON file.

**Wrong type:**
```
crNumber: must be number
```
**Solution:** Change `"crNumber": "1234"` to `"crNumber": 1234` (remove quotes).

**Out of range:**
```
crNumber: must be <= 9999
```
**Solution:** Use a valid CR number between 0 and 9999.

**Invalid array:**
```
workItemCodes: must be array
```
**Solution:** Change `"workItemCodes": "FS_NewFeature"` to `"workItemCodes": ["FS_NewFeature"]`.

## Workflows

### Workflow 1: Creating a New CR

1. **Create** `spec/history/CRxxxx.json` with draft CR data
2. **Set** `crNumber` to 0 (draft)
3. **Fill in** all required fields
4. **Preview** the spec root to see the CR cover page
5. **Make changes** to specification content
6. **Export to DOCX** with CR cover page
7. **After approval**, rename to `CR####.json` with assigned number

### Workflow 2: Fixing Validation Errors

1. **Attempt export** or preview
2. **See error notification** with validation errors
3. **Click** "Open CR File" button
4. **Fix errors** in the JSON file
5. **Save** the file
6. **Retry** export or preview - now succeeds

### Workflow 3: Choosing Front Page Type

1. **Have both** CR cover page and standard front page configured
2. **Start export** of spec root
3. **See dialog** with three options:
   - CR Cover Page (CRxxxx.json)
   - Standard Front Page
   - No Front Page
4. **Select** the desired option
5. **Export proceeds** with chosen front page

### Workflow 4: Exporting from Git History

1. **Select spec root** folder
2. **Right-click** → `SpecPress: Export Selected to DOCX`
3. **Choose a git commit** from the history
4. **Select front page type** (CR, standard, or none)
5. **Export** - uses CR file from that commit

## Configuration

No configuration is required for CR cover pages. The feature works automatically when:
- A `history/` folder exists in your spec root
- A `CRxxxx.json` or `CR####.json` file exists in that folder
- The JSON file contains valid CR data

### Optional: Standard Front Page Fallback

If you want to offer both CR and standard front page options, configure the standard front page in `.vscode/settings.json`:

```json
{
  "specpress.specificationRootPath": "spec",
  "specpress.coverPageTemplate": "assets/frontpage.htm",
  "specpress.coverPageData": "assets/frontpage.json"
}
```

## CLI Usage

The specpress library provides CLI support for CR cover pages:

### Export with CR Cover Page

```bash
node node_modules/specpress/lib/cli/export-docx.js spec/ output.docx \
  --spec-root spec/ \
  --cr-cover-page-data spec/history/CRxxxx.json
```

### Export with Standard Front Page

```bash
node node_modules/specpress/lib/cli/export-docx.js spec/ output.docx \
  --spec-root spec/ \
  --front-page-data assets/frontpage.json
```

### Export without Front Page

```bash
node node_modules/specpress/lib/cli/export-docx.js spec/ output.docx \
  --spec-root spec/
```

## Programmatic API

### Loading and Validating CR Data

```javascript
const { loadCRCoverPageData } = require('specpress/lib/common/crCoverPageLoader')

const result = loadCRCoverPageData('/path/to/CRxxxx.json')

if (result.valid) {
  console.log('CR data is valid:', result.data)
} else {
  console.error('Validation errors:', result.errors)
}
```

### Detecting CR Files

```javascript
const { detectCRCoverPage, collectApprovedCRs } = require('specpress/lib/common/crCoverPageDetector')

// Find draft CR (CRxxxx.json)
const draftCR = detectCRCoverPage('/path/to/spec')
if (draftCR) {
  console.log('Found draft CR:', draftCR)
}

// Find all approved CRs (CR####.json)
const approvedCRs = collectApprovedCRs('/path/to/spec')
console.log('Approved CRs:', approvedCRs)
```

### Converting with CR Cover Page

```javascript
const { MarkdownToDocxConverter } = require('specpress/lib/md2docx/md2docx')
const { loadCRCoverPageData } = require('specpress/lib/common/crCoverPageLoader')

const result = loadCRCoverPageData('/path/to/CRxxxx.json')
if (!result.valid) {
  console.error('Validation errors:', result.errors)
  process.exit(1)
}

const converter = new MarkdownToDocxConverter(mermaidConfig, specRoot)
await converter.convert(mdPath, docxPath, baseDir, null, {
  crCoverPageData: result.data
})
```

## File Structure

```
workspace/
  spec/                          ← specificationRootPath
    01 Scope/
      00 Scope.md
    02 References/
      00 References.md
    history/                     ← CR files location
      CRxxxx.json                ← Draft CR (work in progress)
      CR1234.json                ← Approved CR #1234
      CR1235.json                ← Approved CR #1235
  assets/                        ← Optional: standard front page
    frontpage.htm
    frontpage.json
```

## Validation Schema

CR data is validated against a JSON schema located at:
```
specpress/lib/templates/crCoverPageSchema.json
```

The schema defines:
- Required and optional fields
- Field types (string, number, boolean, array)
- Value constraints (ranges, patterns)
- Array item types

You can use this schema in your editor for auto-completion and validation while editing CR JSON files.

## Troubleshooting

### CR Cover Page Not Detected

**Problem:** Export dialog doesn't show CR cover page option.

**Solutions:**
- Verify `history/` folder exists in spec root
- Check filename is exactly `CRxxxx.json` (four x's) or `CR####.json` (four digits)
- Ensure you're exporting from spec root, not a subfolder
- Check file permissions (file must be readable)

### Validation Errors

**Problem:** "CR cover page validation failed" error appears.

**Solutions:**
- Click "Open CR File" to see the JSON file
- Check all required fields are present
- Verify field types (numbers without quotes, arrays with brackets)
- Check value ranges (crNumber 0-9999, revNumber 0-99)
- Validate JSON syntax (use a JSON validator)

### Preview Shows Error

**Problem:** Preview shows validation error notification.

**Solutions:**
- Click "Open CR File" button
- Fix validation errors in the JSON file
- Save the file
- Preview updates automatically

### Wrong CR File Used

**Problem:** Export uses old CR file instead of current one.

**Solutions:**
- Only one draft CR (`CRxxxx.json`) is detected at a time
- Rename old draft CRs to approved format (`CR####.json`)
- Or move old drafts out of `history/` folder

## Best Practices

### For CR Authors

1. **Start with draft** - Use `CRxxxx.json` during development
2. **Validate early** - Preview frequently to catch validation errors
3. **Use meaningful titles** - Make CR purpose clear
4. **Fill all fields** - Include optional fields when relevant
5. **Rename after approval** - Change to `CR####.json` with assigned number

### For Teams

1. **One draft at a time** - Keep only one `CRxxxx.json` in `history/`
2. **Archive approved CRs** - Keep `CR####.json` files for history
3. **Commit CR files** - Include `history/` folder in git
4. **Review before export** - Preview to verify CR cover page looks correct
5. **Use consistent formatting** - Follow team conventions for field values

### For CI Pipelines

1. **Explicit parameters** - Always specify `--cr-cover-page-data` in CLI
2. **Validate before export** - Check validation result before proceeding
3. **Handle errors** - Exit with error code if validation fails
4. **Log validation errors** - Include error messages in build logs
5. **Test with sample data** - Verify CR export in CI tests

## Related Features

- **Standard Front Page** - Alternative front page using HTML template (see main README)
- **DOCX Export** - Export specifications to DOCX format (see main README)
- **Multi-File Preview** - Preview multiple files with CR cover page (see main README)

## Related Files

**specpress Library:**
- `lib/common/crCoverPageDetector.js` - File detection
- `lib/common/crCoverPageLoader.js` - Validation and loading
- `lib/md2html/crCoverPageRenderer.js` - HTML rendering
- `lib/md2docx/crCoverPageRenderer.js` - DOCX rendering
- `lib/templates/cr_cover_template.htm` - HTML template
- `lib/templates/crCoverPageSchema.json` - JSON schema

**SpecPressExt:**
- `src/vscode/exportDocx.js` - Interactive selection dialog
- `src/vscode/previewManager.js` - CR detection for preview

## Limitations

1. **Single draft CR** - Only one `CRxxxx.json` file detected at a time
2. **Filename strict** - Must be exactly `CRxxxx.json` or `CR####.json`
3. **Location fixed** - Must be in `history/` folder under spec root
4. **No nested folders** - CR files must be directly in `history/`, not subfolders
5. **JSON only** - No support for other formats (YAML, XML, etc.)

## Future Enhancements

Potential features under consideration:

- **Multiple draft CRs** - Support for multiple work-in-progress CRs
- **CR templates** - Pre-filled templates for common CR types
- **Auto-fill from TDoc** - Import CR data from TDoc number
- **Real-time validation** - Validate while editing JSON file
- **CR comparison** - Compare multiple CR versions
- **Batch export** - Export all approved CRs at once
