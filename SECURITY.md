# Security - File Access Controls

## Overview

SpecPress and SpecPressExt implement security measures to prevent unauthorized file access outside the specification root directory. This document describes the security model and validation mechanisms.

## Security Principle

**All file access must be restricted to the specification root directory and explicitly configured external locations.**

## Spec Root Boundary

### What is Spec Root?

The specification root (`specpress.specificationRootPath`) defines the trusted boundary for file operations. All relative paths in markdown files (images, JsonTable, etc.) are resolved relative to this root.

### Protected Operations

The following operations are restricted to spec root:

1. **Image loading** - Images referenced in markdown
2. **JsonTable files** - JSON files linked from markdown
3. **ASN.1 files** - ASN.1 modules included in spec
4. **Markdown files** - Specification content files

### Security Mechanism

- All relative paths are resolved using `path.join(specRoot, relativePath)`
- Absolute paths are rejected or validated
- Path traversal (`../`) is normalized and validated
- Files outside spec root are not accessible

## Comments Folder - Special Case

### Security Concern

Comments are stored **outside** the spec root by default (as a sibling folder). This is intentional but requires explicit configuration.

### Why Outside Spec Root?

1. **Separation of concerns** - Comments are metadata, not spec content
2. **Git workflow** - Easier to exclude from spec commits
3. **Multi-spec support** - One comment folder can serve multiple spec roots

### Security Measures

**1. Mandatory Configuration**

```json
{
  "specpress.commentFolder": "comments"
}
```

- No default value - feature fails if not configured
- Forces users to make conscious decision
- Configuration includes security warning

**2. Path Validation**

```javascript
// Validates path doesn't use tricks like /../../../etc/passwd
const normalized = path.normalize(commentFolder)
if (normalized !== commentFolder) {
  throw new Error('Path normalization detected security issue')
}
```

**3. Clear Documentation**

Configuration description includes:
- "Required for commenting feature"
- "Security note: Comments are stored outside spec root by default"
- Explanation of relative vs. absolute paths

### Configuration Options

**Relative Path (Recommended):**
```json
{
  "specpress.commentFolder": "comments"
}
```
- Creates `workspace/comments/` (sibling to `workspace/spec/`)
- User controls location via workspace structure

**Absolute Path (Use with Caution):**
```json
{
  "specpress.commentFolder": "/shared/project-comments"
}
```
- Allows shared comment storage
- User takes full responsibility for security

## CR Cover Page

### Security Model

CR cover page files are **inside** spec root:
- Located in `specRoot/assets/CRxxxx.json`
- No path traversal possible
- Strict filename pattern: `CR[x0-9]{4}.json`

### Security Measures

**1. Directory Restriction**

```javascript
const assetsDir = path.join(specRoot, 'assets')
// Only looks in specRoot/assets/, nowhere else
```

**2. Filename Pattern**

```javascript
/^CR[x0-9]{4}\.json$/i
// Strict pattern prevents arbitrary file access
```

**3. File Type Validation**

```javascript
if (!crFilePath.toLowerCase().endsWith('.json')) {
  return { errors: ['Invalid file type: must be a .json file'] }
}
```

**4. Path Normalization**

```javascript
const normalized = path.normalize(crFilePath)
if (normalized !== crFilePath) {
  return { errors: ['Invalid file path: path traversal detected'] }
}
```

## Front Page Data

### Security Model

Front page data file location is configured by user:
- `specpress.frontPageData` setting
- Can be inside or outside spec root
- User's responsibility to ensure safe location

### Recommendation

Place front page data inside spec root:
```json
{
  "specpress.frontPageData": "assets/frontpage.json"
}
```

## Image and JsonTable Files

### Security Model

All linked resources must be inside spec root:
- Images: `![alt](path/to/image.png)`
- JsonTable: `[JsonTable](path/to/table.json)`

### Security Measures

**1. Relative Path Resolution**

```javascript
const imagePath = path.join(specRoot, relativePath)
// Always resolved from spec root
```

**2. Existence Check**

```javascript
if (!fs.existsSync(imagePath)) {
  // File not found - no access attempt
}
```

**3. No Absolute Paths**

Absolute paths in markdown are rejected or ignored.

## Mermaid Diagram Cache

### Security Model

Mermaid SVG cache is stored outside spec root:
- Location: `cached/` folder (sibling to spec root)
- Contains only generated SVG files
- No user input in filenames (SHA-256 hashes)

### Security Measures

**1. Hash-Based Filenames**

```javascript
const hash = crypto.createHash('sha256').update(source).digest('hex')
const filename = `${hash}.svg`
// No user-controlled path components
```

**2. Automatic Cleanup**

Unused cache files are automatically deleted, preventing accumulation.

## Security Checklist

When adding new file access features:

- [ ] Is the file inside spec root?
- [ ] If outside, is it explicitly configured?
- [ ] Is path normalization validated?
- [ ] Are absolute paths handled safely?
- [ ] Is there a filename/extension whitelist?
- [ ] Is the security model documented?
- [ ] Are users warned about security implications?

## Threat Model

### Threats Mitigated

1. **Path Traversal** - `../../../etc/passwd` attacks prevented
2. **Arbitrary File Read** - Only spec root files accessible
3. **Symlink Attacks** - Path normalization catches symlink tricks
4. **File Type Confusion** - Extension validation prevents execution

### Threats NOT Mitigated

1. **Malicious Spec Content** - Users can include harmful markdown
2. **Resource Exhaustion** - Large files can consume memory
3. **Zip Bombs** - Compressed content not validated
4. **XSS in Preview** - Markdown can contain scripts (VS Code webview handles this)

### User Responsibility

Users are responsible for:
- Trusting the specification content they open
- Configuring safe paths for external folders (comments, etc.)
- Not opening specifications from untrusted sources
- Understanding security implications of absolute paths

## Reporting Security Issues

If you discover a security vulnerability:

1. **Do not** open a public GitHub issue
2. Email security concerns to: [security contact needed]
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

## Security Updates

Security fixes are released as patch versions and documented in CHANGELOG.md with a **Security** section.
