# SpecPress Comment Feature

## Overview

The comment feature allows users to add, view, edit, and resolve comments on specification files (Markdown and ASN.1). Comments are stored as individual JSON files in a `comments/` folder (sibling to the spec root), making them easy to track in git and merge.

## Configuration

Add to your workspace settings (`.vscode/settings.json`):

```json
{
  "specpress.userId": "alice",
  "specpress.userName": "Alice Smith",
  "specpress.commentFolder": "comments"
}
```

- `userId`: Unique identifier (no spaces, lowercase recommended)
- `userName`: Display name shown in comments
- `commentFolder`: Folder name for comment storage (default: "comments")

## Usage

### Adding a Comment

1. Open a markdown or ASN.1 file in the editor
2. Place cursor on the line you want to comment on
3. Right-click and select **SpecPress: Add Comment**
4. Enter your comment text in the input box

### Viewing Comments

Comments are indicated by:
- **Gutter icons**: Orange speech bubble (unresolved) or green checkmark (resolved)
- **CodeLens**: Clickable text above commented lines showing comment count
- **Hover**: Rich tooltip showing all comments when hovering over the gutter icon
- **Overview ruler**: Colored markers in the scrollbar

### Interacting with Comments

Click the CodeLens indicator or gutter icon to open the action menu:

- **Reply**: Add a reply to the comment
- **Edit**: Modify your own comment text
- **Resolve**: Mark comment as resolved (changes icon to green checkmark)
- **Unresolve**: Reopen a resolved comment
- **Delete**: Remove your own comment
- **Open JSON**: View the raw comment file

## Comment File Structure

Comments are stored in `comments/` folder as `{userId}_{randomId}.json`:

```
repo/
  spec/                    ← specificationRootPath
    01 Scope/
      00 Scope.md
  comments/                ← sibling to spec root
    alice_a3f9d2.json
    alice_b7e1c4.json
    bob_9f2e3a.json
```

Each JSON file contains:

```json
{
  "commentId": "alice_a3f9d2.json",
  "authorId": "alice",
  "authorName": "Alice Smith",
  "fileUri": "01 Scope/00 Scope.md",
  "lineNumber": 42,
  "lineSnippet": "## x.x Scope",
  "commentText": "Should we expand this section?",
  "replyTo": null,
  "createdAt": "2026-05-15T14:30:00.000Z",
  "updatedAt": "2026-05-15T14:30:00.000Z",
  "resolved": false,
  "createdInCommit": "a1b2c3d4",
  "resolvedInCommit": null
}
```

## Features

- **Visual indicators**: Gutter icons, CodeLens, hover tooltips, overview ruler
- **Real-time updates**: Decorations refresh when switching files or saving
- **Git integration**: Tracks commit hashes when comments are created/resolved
- **Reply threads**: Comments can reply to other comments
- **Ownership**: Only edit/delete your own comments
- **Resolved state**: Mark comments as resolved without deleting them
- **Line tolerance**: Comments remain visible even if lines shift slightly

## Implementation Details

- **Separate storage**: Comments live outside spec tree in `comments/` folder
- **File-per-comment**: Easy to track in git, minimal merge conflicts
- **No database**: Pure file-based for simplicity
- **Isolated module**: Comment system is independent from preview/export functionality
