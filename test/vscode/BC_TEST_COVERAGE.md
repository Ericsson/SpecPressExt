# Band Combination Test Coverage

## Summary

This document tracks test coverage for the Band Combination side pane functionality.

## Current Test Coverage

### Unit Tests

#### `bcTreeProvider.test.js` ✅
Tests for `BcTreeProvider` class:
- ✅ Constructor initialization with default values
- ✅ Band number extraction from BC-ID strings
- ✅ Carrier count heuristic calculation
- ✅ Directory scanning for BC files (CA, DC, band files)
- ✅ Type filter application (CA/DC/Bands toggle)
- ✅ BC-ID exact match filtering
- ✅ Band number filtering ("at least" mode)
- ✅ Band number filtering ("only" mode - exact match)
- ✅ Unique band list extraction
- ✅ Configuration hint display when not configured
- ✅ Empty state display when no files found
- ✅ Tree item creation for BC files
- ✅ Filtered file list retrieval
- ✅ Dispose cleanup of config change listener

**Coverage: ~80%** - Core tree provider logic covered

### Missing Test Coverage

#### `bcFilterViewProvider.js` ⚠️
**Status: No tests**

Should test:
- [ ] Webview HTML generation
- [ ] Filter state synchronization with tree provider
- [ ] Type filter toggle functionality
- [ ] Band number autocomplete/chip UI
- [ ] Carrier count mode switching
- [ ] Property toggle filters (FR1, FR2, NR, SUL, Intra)
- [ ] Git status filter
- [ ] Message passing between webview and extension

**Priority: Medium** - Complex UI logic, but mostly view layer

#### `bcValidationViewProvider.js` ⚠️
**Status: No tests**

Should test:
- [ ] Validation scope selection
- [ ] Validation type checkbox handling
- [ ] Log file timestamp parsing
- [ ] Recent log file discovery and sorting
- [ ] Log list update after validation
- [ ] Message passing for validation/refresh/open log
- [ ] Webview ready notification handling

**Priority: Medium** - Important validation logic, but UI-heavy

#### `bcPreviewManager.js` ⚠️
**Status: No tests**

Should test:
- [ ] Single-BC preview opening
- [ ] Multi-BC preview (concatenated view)
- [ ] JSON editor opening in left pane
- [ ] HTML webview creation in right pane
- [ ] Live update debouncing (500ms)
- [ ] validator BC.toHTML() integration
- [ ] Note description loading from schema
- [ ] Reference link click handling
- [ ] Webview disposal and cleanup

**Priority: High** - Core preview functionality, complex logic

#### `bcCommands.js` ⚠️
**Status: No tests**

Should test:
- [ ] `bcRefresh` - tree provider refresh trigger
- [ ] `openBcPreview` - auto preview toggle handling
- [ ] `configureBcFolder` - settings.json opening
- [ ] `bcNormalize` - validator normalization
- [ ] `bcPreviewFiltered` - multi-preview with limit
- [ ] `bcExportGitDiff` - git repo detection, commit picker, diff generation
- [ ] `bcTogglePreview` - state toggle and context update

**Priority: High** - Core command logic with git integration

#### `bcInitializer.js` ⚠️
**Status: No tests**

Should test:
- [ ] Provider and manager initialization
- [ ] View registration (tree, filter, validation)
- [ ] Command registration (7 commands)
- [ ] Auto preview state initialization
- [ ] Tree view reference assignment
- [ ] Disposal subscription registration

**Priority: Low** - Mostly glue code, integration tested in extension tests

### Integration Tests

#### Missing Integration Tests ⚠️

Should add:
- [ ] End-to-end BC pane activation
- [ ] BC file loading and tree population
- [ ] Filter application and tree update
- [ ] Preview opening from tree click
- [ ] Validation run with log file creation
- [ ] Multi-BC preview generation
- [ ] BC normalization roundtrip
- [ ] Git diff export workflow

**Priority: High** - Critical workflows should have integration tests

## Test Execution

Run BC tree provider tests:
```bash
npm test
# Tests are included in the standard test suite
```

Or run individually:
```bash
node test/vscode/bcTreeProvider.test.js
```

## Recommendations

### Priority 1 (High) - Essential Coverage
1. **bcPreviewManager.js** - Core preview and rendering logic
2. **bcCommands.js** - Command handlers with external dependencies (git, validator)
3. **Integration tests** - End-to-end workflows (open preview, run validation, export diff)

### Priority 2 (Medium) - Important Coverage
4. **bcValidationViewProvider.js** - Validation logic and log management
5. **bcFilterViewProvider.js** - Complex filter UI state management

### Priority 3 (Low) - Nice to Have
6. **bcInitializer.js** - Initialization glue code

## Testing Strategy

### Unit Test Approach
- Mock vscode API using the same pattern as `stateAndConfig.test.js`
- Mock file system operations with temp directories
- Mock validator imports (or test against real validator in co-develop mode)
- Test error handling paths
- Test edge cases (empty folders, invalid JSON, missing files)

### Integration Test Approach
- Use VS Code Extension Test Runner
- Load actual BC JSON files from test fixtures
- Test full command execution paths
- Verify webview content generation
- Test git integration with test repos

### Mocking Strategy
For external dependencies:
- **validator**: Can use real imports in co-develop mode, or mock BC_ID/BC classes
- **git commands**: Mock `execSync` to return test data
- **webviews**: Verify HTML generation and message handlers
- **file system**: Use temp directories for safe testing

## Test Maintenance

- Update tests when adding new filters or commands
- Maintain test fixtures for BC JSON files
- Document test data requirements
- Keep mocks synchronized with real implementations
- Run tests in CI pipeline on PR

## Future Improvements

- Add performance tests for large BC file sets (1000+ files)
- Add UI automation tests for webview interactions
- Add regression tests for BC-ID parsing edge cases
- Add schema validation tests
- Add accessibility tests for webview UIs
