const vscode = require('vscode')
const path = require('path')
const fs = require('fs')
const MarkdownIt = require('markdown-it')
const texmath = require('markdown-it-texmath')
const katex = require('katex')
const { buildSpanMap, normalizeJsonTable } = require('specpress/lib/common/buildSpanMap')
const { preprocessLatex } = require('specpress/lib/common/latexHelpers')

/**
 * Custom editor provider for JsonTable files.
 *
 * Renders a WYSIWYG table view in a webview. Cells display rendered markdown
 * by default. Double-clicking a cell opens an inline editor for the raw
 * markdown content. Supports row/column management, cell merging, and
 * a rich text toolbar.
 */
class JsonTableEditorProvider {
  static viewType = 'specpress.jsonTableEditor'

  constructor(context) {
    this.context = context
    this.md = new MarkdownIt({ html: true })
    const katexEngine = {
      renderToString: (latex, opts) => katex.renderToString(preprocessLatex(latex, opts && opts.displayMode), opts)
    }
    this.md.use(texmath, { engine: katexEngine, delimiters: 'dollars' })
  }

  async resolveCustomTextEditor(document, webviewPanel) {
    webviewPanel.webview.options = { enableScripts: true }

    const updateWebview = () => {
      try {
        const data = JSON.parse(document.getText())
        webviewPanel.webview.html = this.getHtml(data)
      } catch (e) {
        webviewPanel.webview.html = this.getErrorHtml(e.message)
      }
    }

    // Rebuild on document changes, but not while a cell is being edited
    let isEditing = false
    const changeSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString() && !isEditing) {
        updateWebview()
      }
    })
    webviewPanel.onDidDispose(() => changeSubscription.dispose())

    webviewPanel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'editStart') { isEditing = true; return }
      if (msg.type === 'editEnd') { isEditing = false }
      await this.handleMessage(document, msg)
      if (!isEditing) updateWebview()
    })
    updateWebview()
  }

  // ── Message handling ────────────────────────────────────────────

  async handleMessage(document, msg) {
    const handlers = {
      updateCell: () => this.editData(document, data => {
        if (msg.value === '' || msg.value === undefined) delete data.rows[msg.row][msg.key]
        else data.rows[msg.row][msg.key] = msg.value
      }),
      addRow: () => this.editData(document, data => {
        data.rows.splice(msg.after !== undefined ? msg.after + 1 : data.rows.length, 0, {})
      }),
      deleteRow: () => this.editData(document, data => {
        data.rows.splice(msg.row, 1)
      }),
      moveRow: () => this.editData(document, data => {
        const [row] = data.rows.splice(msg.from, 1)
        data.rows.splice(msg.to, 0, row)
      }),
      addColumn: () => this.promptAddColumn(document, msg.after),
      deleteColumn: () => this.editData(document, data => {
        data.columns = data.columns.filter(c => c.key !== msg.key)
        if (data.rows) data.rows.forEach(row => { delete row[msg.key] })
      }),
      moveColumn: () => this.editData(document, data => {
        const [col] = data.columns.splice(msg.from, 1)
        data.columns.splice(msg.to, 0, col)
      }),
      mergeCells: () => this.editData(document, data => {
        data.rows[msg.row][msg.key] = msg.direction === 'above' ? '^' : '<'
      }),
      unmergeCells: () => this.editData(document, data => {
        delete data.rows[msg.row][msg.key]
      }),
      updateColumnAlign: () => this.editData(document, data => {
        const col = data.columns.find(c => c.key === msg.key)
        if (col) col.align = msg.align
      }),
      updateColumn: () => this.editData(document, data => {
        const col = data.columns.find(c => c.key === msg.oldKey)
        if (!col) return
        // Update key in all rows if key changed
        if (msg.newKey && msg.newKey !== msg.oldKey) {
          if (data.rows) {
            data.rows.forEach(row => {
              if (msg.oldKey in row) {
                row[msg.newKey] = row[msg.oldKey]
                delete row[msg.oldKey]
              }
            })
          }
          col.key = msg.newKey
        }
        if (msg.name !== undefined) col.name = msg.name
        if (msg.mergeOnAbsence !== undefined) {
          if (msg.mergeOnAbsence === 'no') delete col.mergeOnAbsence
          else col.mergeOnAbsence = msg.mergeOnAbsence
        }
      }),
    }
    if (handlers[msg.type]) await handlers[msg.type]()
  }

  // ── Data editing helpers ────────────────────────────────────────

  async editData(document, mutator) {
    try {
      const data = JSON.parse(document.getText())
      if (!data.rows) data.rows = []
      if (!data.columns) data.columns = []
      mutator(data)
      const edit = new vscode.WorkspaceEdit()
      edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0),
        JSON.stringify(data, null, 4) + '\n')
      await vscode.workspace.applyEdit(edit)
      await document.save()
    } catch (e) { /* ignore */ }
  }

  async promptAddColumn(document, afterIndex) {
    const key = await vscode.window.showInputBox({ prompt: 'Column key (used in row objects)' })
    if (!key) return
    const name = await vscode.window.showInputBox({ prompt: 'Column header name', value: key })
    if (name === undefined) return
    await this.editData(document, data => {
      const idx = afterIndex !== undefined ? afterIndex + 1 : data.columns.length
      data.columns.splice(idx, 0, { key, name: name || key })
    })
  }

  // ── Rendering ───────────────────────────────────────────────────

  renderCell(value) {
    if (value === null || value === undefined) return '<span class="empty">(empty)</span>'
    const str = String(value)
    if (str === '') return '&nbsp;'
    if (str === '^') return '<span class="merge-marker">↑ merge above</span>'
    if (str === '<') return '<span class="merge-marker">← merge left</span>'
    return this.md.renderInline(str.replace(/\n/g, '<br>'))
  }

  escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  getHtml(data) {
    const columns = data.columns || []
    const rows = data.rows || []
    const katexCss = fs.readFileSync(require.resolve('katex/dist/katex.min.css'), 'utf8')
    const specCss = fs.readFileSync(require.resolve('specpress/lib/css/3gpp.css'), 'utf8')

    const headerCells = columns.map((col, c) => {
      const moa = col.mergeOnAbsence || 'no'
      return `<th data-col="${c}" data-key="${this.escapeAttr(col.key || '')}" data-name="${this.escapeAttr(col.name || '')}" data-moa="${moa}" draggable="true">
        <div class="col-header">
          <span class="col-name">${this.escapeAttr(col.name || col.key || '')}</span>
          <span class="col-key">${this.escapeAttr(col.key || '')}</span>
          <div class="col-actions">
            <select class="align-select" data-key="${col.key}" title="Alignment">
              <option value="left"${col.align === 'left' || !col.align ? ' selected' : ''}>Left</option>
              <option value="center"${col.align === 'center' ? ' selected' : ''}>Center</option>
              <option value="right"${col.align === 'right' ? ' selected' : ''}>Right</option>
            </select>
            <select class="moa-select" data-key="${col.key}" title="Merge on absence">
              <option value="no"${moa === 'no' ? ' selected' : ''}>No merge</option>
              <option value="above"${moa === 'above' ? ' selected' : ''}>Merge \u2191</option>
              <option value="left"${moa === 'left' ? ' selected' : ''}>Merge \u2190</option>
            </select>
            <button class="icon-btn delete-col-btn" data-key="${col.key}" title="Delete column">×</button>
          </div>
        </div>
      </th>`
    }).join('')

    // Normalize and build span map for merged cell rendering
    const normalized = normalizeJsonTable({ columns, rows })
    const normRows = normalized.rows || []
    const colCount = columns.length
    const spanMap = normRows.length > 0 ? buildSpanMap(normRows, normRows.length, colCount) : []

    const bodyRows = rows.map((row, r) => {
      const cells = columns.map((col, c) => {
        const span = spanMap[r] ? spanMap[r][c] : null
        if (span && span.skip) return '' // skip cells consumed by a span
        const val = row[col.key]
        const raw = val !== undefined ? String(val) : ''
        const rendered = this.renderCell(val)
        const absent = val === undefined ? ' absent' : ''
        const align = col.align || 'left'
        const rowspanAttr = span && span.rowspan > 1 ? ` rowspan="${span.rowspan}"` : ''
        const colspanAttr = span && span.colspan > 1 ? ` colspan="${span.colspan}"` : ''
        return `<td class="cell${absent}" style="text-align:${align}"${rowspanAttr}${colspanAttr} data-row="${r}" data-col="${c}" data-key="${col.key}" data-raw="${this.escapeAttr(raw)}" data-absent="${val === undefined}">${rendered}</td>`
      }).join('')
      return `<tr data-row="${r}" draggable="true">${cells}<td class="row-actions">
        <button class="icon-btn delete-row-btn" data-row="${r}" title="Delete row">×</button>
      </td></tr>`
    }).join('')

    return `<!DOCTYPE html>
<html><head>
<style>${katexCss}</style>
<style>${specCss}</style>
<style>
  /* Editor overrides on top of 3gpp.css */
  * { box-sizing: border-box; }
  body { padding: 8px; margin: 0; background: #fff; user-select: none; max-width: none; }
  table { width: 100%; }
  th { background: #f0f0f0; cursor: grab; color: #000; }
  td { color: #000; }
  th.drag-over { border-left: 3px solid var(--vscode-focusBorder, #0078d4); }
  tr.drag-over td { border-top: 3px solid var(--vscode-focusBorder, #0078d4); }
  .col-header { display: flex; flex-direction: column; gap: 2px; }
  .col-name { font-weight: bold; }
  .col-key { font-size: 10px; color: var(--vscode-descriptionForeground, #888); font-style: italic; }
  .col-actions { display: flex; gap: 4px; align-items: center; margin-top: 2px; }
  .align-select, .moa-select { font-size: 10px; padding: 1px 2px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border, #444); border-radius: 2px; }
  .col-edit-input { width: 100%; padding: 3px 4px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-focusBorder, #0078d4); border-radius: 2px; margin-top: 2px; }
  .cell { cursor: pointer; min-height: 1.4em; position: relative; }
  .cell:hover { background: #ffffdd; }
  .cell.editing { padding: 2px; }
  .cell.absent { color: #aaa; font-style: italic; }
  .cell.merged { background: #f0f0f0; opacity: 0.7; }
  .edit-container { display: flex; flex-direction: column; gap: 4px; }
  .edit-toolbar { display: flex; gap: 2px; }
  .edit-toolbar button { padding: 2px 6px; font-size: 11px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-secondaryBackground, #333); border: 1px solid var(--vscode-panel-border, #444); border-radius: 2px; font-weight: bold; }
  .edit-toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, #444); }
  .cell textarea { width: 100%; min-height: 50px; border: 1px solid var(--vscode-focusBorder, #0078d4); padding: 4px; font-family: var(--vscode-editor-font-family, 'Courier New', monospace); font-size: var(--vscode-editor-font-size, 12px); resize: vertical; color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
  .empty { color: var(--vscode-disabledForeground, #888); font-style: italic; }
  .merge-marker { color: var(--vscode-textLink-foreground, #3794ff); font-style: italic; font-size: 11px; }
  .toolbar { margin-bottom: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
  .toolbar button { padding: 4px 10px; cursor: pointer; font-size: 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 2px; }
  .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
  .icon-btn { background: none !important; border: none !important; color: var(--vscode-errorForeground, #c00) !important; cursor: pointer; font-size: 16px; padding: 0 4px; }
  .icon-btn:hover { opacity: 0.7; }
  .row-actions { border: none; width: 28px; padding: 2px; text-align: center; }
  .context-menu { position: fixed; background: var(--vscode-menu-background, #252526); border: 1px solid var(--vscode-menu-border, #444); border-radius: 4px; padding: 4px 0; z-index: 1000; min-width: 160px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
  .context-menu div { padding: 4px 16px; cursor: pointer; font-size: 12px; color: var(--vscode-menu-foreground, #ccc); }
  .context-menu div:hover { background: var(--vscode-menu-selectionBackground, #094771); color: var(--vscode-menu-selectionForeground, #fff); }
  .context-menu .separator { border-top: 1px solid var(--vscode-menu-separatorBackground, #444); margin: 4px 0; padding: 0; cursor: default; }
  .context-menu .separator:hover { background: none; }
  em { font-style: italic; }
  strong { font-weight: bold; }
  code { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); padding: 1px 4px; border-radius: 2px; font-family: var(--vscode-editor-font-family, 'Courier New', monospace); font-size: 12px; }
  tr[draggable] { cursor: grab; }
</style>
</head><body>
  <div class="toolbar">
    <button id="addRow">+ Row</button>
    <button id="addCol">+ Column</button>
  </div>
  <table>
    <thead><tr>${headerCells}<th class="row-actions"></th></tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
  <div id="contextMenu" class="context-menu" style="display:none;"></div>
<script>
const vscode = acquireVsCodeApi();
const menu = document.getElementById('contextMenu');

const BT = String.fromCharCode(96);

// ── Cell editing (delegated) ──────────────────────────────────
document.querySelector('table').addEventListener('dblclick', (e) => {
  const td = e.target.closest('.cell');
  if (td) startEdit(td);
});

function startEdit(td) {
  if (td.classList.contains('editing')) return;
  const row = parseInt(td.dataset.row);
  const key = td.dataset.key;
  const raw = td.dataset.absent === 'true' ? '' : td.dataset.raw;
  td.classList.add('editing');
  vscode.postMessage({ type: 'editStart' });
  const originalHtml = td.innerHTML;
  td.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'edit-container';

  const toolbar = document.createElement('div');
  toolbar.className = 'edit-toolbar';
  [['B', '**', '**'], ['I', '*', '*'], ['Code', BT, BT], ['\\n', '\\n', '']].forEach(([label, before, after]) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.title = label === 'B' ? 'Bold' : label === 'I' ? 'Italic' : label === 'Code' ? 'Inline code' : 'Line break';
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      insertAround(textarea, before, after);
    });
    toolbar.appendChild(btn);
  });

  const commitBtn = document.createElement('button');
  commitBtn.textContent = '\u2713 Save';
  commitBtn.title = 'Save (Ctrl+Enter)';
  commitBtn.style.marginLeft = '8px';
  commitBtn.style.color = 'var(--vscode-terminal-ansiGreen, #0a0)';
  commitBtn.addEventListener('mousedown', (e) => { e.preventDefault(); doCommit(); });
  toolbar.appendChild(commitBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '\u2717 Cancel';
  cancelBtn.title = 'Cancel';
  cancelBtn.style.color = 'var(--vscode-errorForeground, #c00)';
  cancelBtn.addEventListener('mousedown', (e) => { e.preventDefault(); doCancel(); });
  toolbar.appendChild(cancelBtn);

  container.appendChild(toolbar);

  const textarea = document.createElement('textarea');
  textarea.value = raw;
  container.appendChild(textarea);
  td.appendChild(container);
  textarea.focus();

  function doCommit() {
    if (!td.classList.contains('editing')) return;
    const newValue = textarea.value;
    td.classList.remove('editing');
    // Update DOM directly
    td.dataset.raw = newValue;
    td.dataset.absent = 'false';
    td.className = 'cell';
    td.innerHTML = renderCellInline(newValue);
    // Save to file and signal edit end
    vscode.postMessage({ type: 'editEnd' });
    vscode.postMessage({ type: 'updateCell', row, key, value: newValue });
  }
  function doCancel() {
    if (!td.classList.contains('editing')) return;
    td.classList.remove('editing');
    td.innerHTML = originalHtml;
    vscode.postMessage({ type: 'editEnd' });
  }
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); doCommit(); }
  });
}

function renderCellInline(str) {
  if (str === '') return '&nbsp;';
  if (str === '^') return '<span class="merge-marker">\u2191 merge above</span>';
  if (str === '<') return '<span class="merge-marker">\u2190 merge left</span>';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
    .replace(/\\\\n/g, '<br>')
    .replace(/\\n/g, '<br>');
}

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

// ── Toolbar ───────────────────────────────────────────────────
document.getElementById('addRow').addEventListener('click', () => {
  vscode.postMessage({ type: 'addRow' });
});
document.getElementById('addCol').addEventListener('click', () => {
  vscode.postMessage({ type: 'addColumn' });
});

// Delete buttons + alignment (delegated)
document.querySelector('table').addEventListener('click', (e) => {
  const rowBtn = e.target.closest('.delete-row-btn');
  if (rowBtn) return vscode.postMessage({ type: 'deleteRow', row: parseInt(rowBtn.dataset.row) });
  const colBtn = e.target.closest('.delete-col-btn');
  if (colBtn) return vscode.postMessage({ type: 'deleteColumn', key: colBtn.dataset.key });
});
document.querySelector('table').addEventListener('change', (e) => {
  const sel = e.target.closest('.align-select');
  if (sel) vscode.postMessage({ type: 'updateColumnAlign', key: sel.dataset.key, align: sel.value });
  const moa = e.target.closest('.moa-select');
  if (moa) vscode.postMessage({ type: 'updateColumn', oldKey: moa.dataset.key, mergeOnAbsence: moa.value });
});

// Double-click column header to edit name/key
document.querySelector('thead').addEventListener('dblclick', (e) => {
  const th = e.target.closest('th[data-key]');
  if (!th || e.target.closest('select') || e.target.closest('button')) return;
  const oldKey = th.dataset.key;
  const oldName = th.dataset.name;
  vscode.postMessage({ type: 'editStart' });
  th.innerHTML = '';
  const form = document.createElement('div');
  form.className = 'edit-container';
  form.innerHTML = '<label style="font-size:10px">Name:</label>' +
    '<input type="text" class="col-edit-input" value="' + oldName.replace(/"/g,'&quot;') + '" placeholder="Column name">' +
    '<label style="font-size:10px;margin-top:4px">Key:</label>' +
    '<input type="text" class="col-edit-input" value="' + oldKey.replace(/"/g,'&quot;') + '" placeholder="Column key">';
  const toolbar = document.createElement('div');
  toolbar.className = 'edit-toolbar';
  const saveBtn = document.createElement('button');
  saveBtn.textContent = '\u2713 Save';
  saveBtn.style.color = 'var(--vscode-terminal-ansiGreen, #0a0)';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '\u2717 Cancel';
  cancelBtn.style.color = 'var(--vscode-errorForeground, #c00)';
  toolbar.appendChild(saveBtn);
  toolbar.appendChild(cancelBtn);
  form.appendChild(toolbar);
  th.appendChild(form);
  const inputs = form.querySelectorAll('input');
  inputs[0].focus();
  saveBtn.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    vscode.postMessage({ type: 'editEnd' });
    vscode.postMessage({ type: 'updateColumn', oldKey, name: inputs[0].value, newKey: inputs[1].value });
  });
  cancelBtn.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    vscode.postMessage({ type: 'editEnd' });
  });
});

// ── Context menu ──────────────────────────────────────────────
document.addEventListener('contextmenu', (e) => {
  const td = e.target.closest('.cell');
  const th = e.target.closest('th[data-col]');
  const tr = e.target.closest('tr[data-row]');
  if (!td && !th && !tr) { hideMenu(); return; }
  e.preventDefault();

  const items = [];
  if (td) {
    const row = parseInt(td.dataset.row);
    const key = td.dataset.key;
    const col = parseInt(td.dataset.col);
    const hasRowspan = td.hasAttribute('rowspan') && parseInt(td.getAttribute('rowspan')) > 1;
    const hasColspan = td.hasAttribute('colspan') && parseInt(td.getAttribute('colspan')) > 1;
    items.push({ label: 'Edit cell', action: () => startEdit(td) });
    items.push({ separator: true });
    // Merge: set the next row's/column's cell to ^ or <
    items.push({ label: 'Merge cell below (↓)', action: () => {
      const targetRow = row + (hasRowspan ? parseInt(td.getAttribute('rowspan')) : 1);
      vscode.postMessage({ type: 'mergeCells', row: targetRow, key, direction: 'above' });
    }});
    items.push({ label: 'Merge cell right (→)', action: () => {
      const cols = document.querySelectorAll('th[data-col]');
      const targetCol = col + (hasColspan ? parseInt(td.getAttribute('colspan')) : 1);
      if (targetCol < cols.length) {
        const targetKey = cols[targetCol].dataset.key;
        vscode.postMessage({ type: 'mergeCells', row, key: targetKey, direction: 'left' });
      }
    }});
    if (hasRowspan || hasColspan) {
      items.push({ label: 'Unmerge (remove last span)', action: () => {
        // Find the last ^ or < that points to this cell
        if (hasRowspan) {
          const lastRow = row + parseInt(td.getAttribute('rowspan')) - 1;
          vscode.postMessage({ type: 'unmergeCells', row: lastRow, key });
        } else {
          const cols = document.querySelectorAll('th[data-col]');
          const lastCol = col + parseInt(td.getAttribute('colspan')) - 1;
          if (lastCol < cols.length) vscode.postMessage({ type: 'unmergeCells', row, key: cols[lastCol].dataset.key });
        }
      }});
    }
    items.push({ separator: true });
    items.push({ label: 'Insert row above', action: () => vscode.postMessage({ type: 'addRow', after: row - 1 }) });
    items.push({ label: 'Insert row below', action: () => vscode.postMessage({ type: 'addRow', after: row }) });
    items.push({ label: 'Delete row', action: () => vscode.postMessage({ type: 'deleteRow', row }) });
    items.push({ separator: true });
    items.push({ label: 'Insert column after', action: () => vscode.postMessage({ type: 'addColumn', after: col }) });
    items.push({ label: 'Delete column', action: () => vscode.postMessage({ type: 'deleteColumn', key }) });
  } else if (tr) {
    const row = parseInt(tr.dataset.row);
    items.push({ label: 'Insert row above', action: () => vscode.postMessage({ type: 'addRow', after: row - 1 }) });
    items.push({ label: 'Insert row below', action: () => vscode.postMessage({ type: 'addRow', after: row }) });
    items.push({ label: 'Delete row', action: () => vscode.postMessage({ type: 'deleteRow', row }) });
  }
  showMenu(e.clientX, e.clientY, items);
});

function showMenu(x, y, items) {
  menu.innerHTML = '';
  items.forEach(item => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'separator';
      menu.appendChild(sep);
    } else {
      const div = document.createElement('div');
      div.textContent = item.label;
      div.addEventListener('click', () => { hideMenu(); item.action(); });
      menu.appendChild(div);
    }
  });
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.display = 'block';
}

function hideMenu() { menu.style.display = 'none'; }
document.addEventListener('click', hideMenu);

// ── Drag & drop rows ─────────────────────────────────────────
let dragRow = null;
document.querySelectorAll('tbody tr[draggable]').forEach(tr => {
  tr.addEventListener('dragstart', (e) => {
    dragRow = parseInt(tr.dataset.row);
    e.dataTransfer.effectAllowed = 'move';
    tr.style.opacity = '0.4';
  });
  tr.addEventListener('dragend', () => { tr.style.opacity = '1'; dragRow = null; clearDragStyles(); });
  tr.addEventListener('dragover', (e) => {
    e.preventDefault();
    clearDragStyles();
    tr.classList.add('drag-over');
  });
  tr.addEventListener('drop', (e) => {
    e.preventDefault();
    const to = parseInt(tr.dataset.row);
    if (dragRow !== null && dragRow !== to) {
      vscode.postMessage({ type: 'moveRow', from: dragRow, to });
    }
    clearDragStyles();
  });
});

// ── Drag & drop columns ──────────────────────────────────────
let dragCol = null;
document.querySelectorAll('th[draggable]').forEach(th => {
  th.addEventListener('dragstart', (e) => {
    dragCol = parseInt(th.dataset.col);
    e.dataTransfer.effectAllowed = 'move';
    th.style.opacity = '0.4';
  });
  th.addEventListener('dragend', () => { th.style.opacity = '1'; dragCol = null; clearDragStyles(); });
  th.addEventListener('dragover', (e) => {
    e.preventDefault();
    clearDragStyles();
    th.classList.add('drag-over');
  });
  th.addEventListener('drop', (e) => {
    e.preventDefault();
    const to = parseInt(th.dataset.col);
    if (dragCol !== null && dragCol !== to) {
      vscode.postMessage({ type: 'moveColumn', from: dragCol, to });
    }
    clearDragStyles();
  });
});

function clearDragStyles() {
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
}
</script>
</body></html>`
  }

  getErrorHtml(message) {
    return `<!DOCTYPE html>
<html><body style="font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background);">
  <h3 style="color: var(--vscode-errorForeground);">Invalid JsonTable</h3>
  <p>${message}</p>
  <p>Fix the JSON in the text editor and this view will update automatically.</p>
</body></html>`
  }

  /**
   * Opens a JSON file in the JsonTable editor after validating it has a columns array.
   *
   * @param {Object} vscode - The vscode module.
   * @param {Object} uri - File URI, or null to use the active editor.
   */
  static async openEditor(vscode, uri) {
    const fileUri = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri)
    if (!fileUri) {
      vscode.window.showErrorMessage('No JSON file selected.')
      return
    }
    try {
      const content = require('fs').readFileSync(fileUri.fsPath, 'utf8')
      const data = JSON.parse(content)
      if (!data.columns || !Array.isArray(data.columns)) {
        vscode.window.showWarningMessage('This file does not appear to be a JsonTable (no "columns" array found).')
        return
      }
      await vscode.commands.executeCommand('vscode.openWith', fileUri, JsonTableEditorProvider.viewType)
    } catch (e) {
      vscode.window.showErrorMessage(`Cannot open as JsonTable: ${e.message}`)
    }
  }

  /**
   * Creates a new JsonTable file from a [JsonTable](*.json) link in a markdown file
   * and opens it in the editor. If the file already exists, opens it directly.
   *
   * @param {Object} vscode - The vscode module.
   */
  static async openOrCreate(vscode) {
    const editor = vscode.window.activeTextEditor
    if (!editor || editor.document.languageId !== 'markdown') {
      vscode.window.showErrorMessage('Place the cursor on a [JsonTable](*.json) link in a markdown file.')
      return
    }
    const line = editor.document.lineAt(editor.selection.active.line).text
    const match = line.match(/\[JsonTable\]\(([^)]+\.json)\)/)
    if (!match) {
      vscode.window.showErrorMessage('No [JsonTable](*.json) link found on the current line.')
      return
    }
    const jsonRelPath = match[1]
    const mdDir = path.dirname(editor.document.uri.fsPath)
    const jsonPath = path.isAbsolute(jsonRelPath) ? jsonRelPath : path.join(mdDir, jsonRelPath)
    const jsonUri = vscode.Uri.file(jsonPath)

    if (!fs.existsSync(jsonPath)) {
      const dir = path.dirname(jsonPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const template = {
        columns: [
          { key: 'col1', name: 'Column 1' },
          { key: 'col2', name: 'Column 2' }
        ],
        rows: [
          { col1: '', col2: '' }
        ]
      }
      fs.writeFileSync(jsonPath, JSON.stringify(template, null, 4) + '\n')
      vscode.window.showInformationMessage(`Created new JsonTable: ${jsonRelPath}`)
    }

    await vscode.commands.executeCommand('vscode.openWith', jsonUri, JsonTableEditorProvider.viewType)
  }
}

module.exports = { JsonTableEditorProvider }
