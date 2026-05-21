/**
 * Shared markdown editor toolbar HTML and JavaScript
 * Used by JsonTable editor and comment detail view
 */

/**
 * Get the toolbar HTML for markdown editing
 * @returns {string} HTML string for the toolbar
 */
function getToolbarHtml() {
  return `
    <div class="edit-toolbar">
      <button class="toolbar-btn" data-action="bold" title="Bold (Ctrl+B)">B</button>
      <button class="toolbar-btn" data-action="italic" title="Italic (Ctrl+I)">I</button>
      <button class="toolbar-btn" data-action="code" title="Inline code">Code</button>
      <button class="toolbar-btn" data-action="linebreak" title="Line break">\\n</button>
    </div>
  `
}

/**
 * Get the CSS for the toolbar
 * @returns {string} CSS string for the toolbar
 */
function getToolbarCss() {
  return `
    .edit-toolbar {
      display: flex;
      gap: 2px;
      margin-bottom: 4px;
    }
    .edit-toolbar .toolbar-btn {
      padding: 2px 6px;
      font-size: 11px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-secondaryBackground, #333);
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 2px;
      font-weight: bold;
    }
    .edit-toolbar .toolbar-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, #444);
    }
  `
}

/**
 * Get the JavaScript for the toolbar functionality
 * @param {string} textareaId - ID of the textarea element
 * @returns {string} JavaScript code as a string
 */
function getToolbarScript(textareaId) {
  const BT = String.fromCharCode(96) // backtick
  return `
    const BT = String.fromCharCode(96);
    
    function insertAround(textarea, before, after) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = textarea.value;
      const selected = text.substring(start, end);
      textarea.value = text.substring(0, start) + before + selected + after + text.substring(end);
      textarea.selectionStart = start + before.length;
      textarea.selectionEnd = start + before.length + selected.length;
      textarea.focus();
    }
    
    // Attach toolbar button handlers
    document.querySelectorAll('.toolbar-btn').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const textarea = document.getElementById('${textareaId}');
        if (!textarea) return;
        
        const action = btn.dataset.action;
        switch(action) {
          case 'bold':
            insertAround(textarea, '**', '**');
            break;
          case 'italic':
            insertAround(textarea, '*', '*');
            break;
          case 'code':
            insertAround(textarea, BT, BT);
            break;
          case 'linebreak':
            insertAround(textarea, '\\\\n', '');
            break;
        }
      });
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      const textarea = document.getElementById('${textareaId}');
      if (!textarea || document.activeElement !== textarea) return;
      
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        insertAround(textarea, '**', '**');
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
        e.preventDefault();
        insertAround(textarea, '*', '*');
      }
    });
  `
}

module.exports = {
  getToolbarHtml,
  getToolbarCss,
  getToolbarScript
}
