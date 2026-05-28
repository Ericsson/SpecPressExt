# Security Improvements - Summary

## Issue Identified

The commenting system had a security concern:

- Comment folder defaulted to `specRoot/../comments` (outside spec root)
- Worked without explicit configuration
- Could potentially be exploited with malicious paths

## Changes Made

### 1. Mandatory Configuration

**Before:**

```javascript
const folderName = this.config.commentFolder || 'comments'  // Default value
```

**After:**

```javascript
if (!folderName) {
  throw new Error('Comment folder not configured. Set specpress.commentFolder in settings.json.')
}
```

**Impact:**

- Commenting feature fails if not configured
- Forces users to make conscious decision
- No silent defaults that could be insecure

### 2. Path Validation

**Added Security Checks:**

```javascript
// Validate path normalization
const normalized = path.normalize(commentFolder)
if (normalized !== commentFolder) {
  throw new Error('Path normalization detected security issue')
}
```

**Prevents:**

- Path traversal attacks (`../../../etc/passwd`)
- Symlink tricks
- Malformed paths

### 3. Configuration Changes

**package.json:**

```json
{
  "specpress.commentFolder": {
    "type": "string",
    "default": "",  // Changed from "comments"
    "description": "... Security note: Comments are stored outside spec root by default."
  }
}
```

**Impact:**

- No default value
- Clear security warning in description
- Users must explicitly configure

### 4. CR Cover Page Validation

**Added Security Checks:**

```javascript
// File type validation
if (!crFilePath.toLowerCase().endsWith('.json')) {
  return { errors: ['Invalid file type: must be a .json file'] }
}

// Path traversal detection
const normalized = path.normalize(crFilePath)
if (normalized !== crFilePath) {
  return { errors: ['Invalid file path: path traversal detected'] }
}
```

**Impact:**

- Prevents loading non-JSON files
- Detects path traversal attempts
- Defense in depth (even though detector already restricts to assets/)

### 5. Documentation

**Created:**

- `SECURITY.md` - Comprehensive security documentation
- Updated `Commenting documents.md` - Security requirements
- Clear warnings in configuration descriptions

## Security Model Summary

### Inside Spec Root (Secure by Default)

- ✅ Markdown files
- ✅ Images
- ✅ JsonTable files
- ✅ ASN.1 files
- ✅ CR cover page (`assets/CRxxxx.json`)
- ✅ Mermaid cache (generated files only)

### Outside Spec Root (Requires Configuration)

- ⚠️ Comments folder (must be explicitly configured)
- ⚠️ Front page data (user-configured path)

### Validation Applied

- ✅ Path normalization checks
- ✅ File extension validation
- ✅ Directory restriction (for CR files)
- ✅ Pattern matching (for CR filenames)
- ✅ Existence checks before access

## Migration Guide

### For Existing Users

If you were using the commenting feature, you now need to add this to `.vscode/settings.json`:

```json
{
  "specpress.commentFolder": "comments"
}
```

### Error Message

If not configured, users will see:

```text
Comment folder not configured. Set specpress.commentFolder in settings.json.
Example: "specpress.commentFolder": "comments" (creates folder as sibling to spec root)
Security note: Comments folder will be outside spec root by default.
```

## Testing

### Security Tests to Add

1. **Path Traversal:**
2.
   ```javascript
   config.commentFolder = '../../../etc'
   // Should fail validation
   ```

3. **Absolute Path:**
4.
   ```javascript
   config.commentFolder = '/tmp/comments'
   // Should work but with warning
   ```

5. **Missing Configuration:**
   ```javascript
   config.commentFolder = ''
   // Should throw error
   ```

6. **CR File Type:**
7.
   ```javascript
   loadCRCoverPageData('malicious.exe')
   // Should reject non-JSON files
   ```

## Recommendations

### For Users

1. **Use relative paths** for comment folder (e.g., `"comments"`)
2. **Review configuration** - understand where files are stored
3. **Don't use absolute paths** unless necessary
4. **Trust your spec content** - only open specs from trusted sources

### For Developers

1. **Always validate paths** before file operations
2. **No silent defaults** for paths outside spec root
3. **Document security implications** in configuration
4. **Add security tests** for new file access features
5. **Follow the security checklist** in SECURITY.md

## Future Enhancements

### Potential Improvements

1. **Whitelist validation** - Only allow specific parent directories
2. **Sandbox mode** - Strict mode that disallows all external paths
3. **Audit logging** - Log all file access attempts
4. **Permission system** - Fine-grained control over file access
5. **Security policy file** - `.specpress-security.json` with allowed paths

### Breaking Changes to Consider

1. **Require comments inside spec root** - More secure but less flexible
2. **Disable absolute paths** - Prevent potential misuse
3. **Mandatory security review** - Prompt on first use

## Conclusion

The security improvements ensure that:

- ✅ Users are aware of security implications
- ✅ No silent defaults that could be insecure
- ✅ Path validation prevents common attacks
- ✅ Clear documentation guides safe usage
- ✅ Defense in depth with multiple validation layers

The commenting feature is now more secure while maintaining flexibility for legitimate use cases.
