const vscode = require('vscode')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const HtmlDiff = require('htmldiff-js')
const { Md2Html } = require('specpress/lib/md2html/md2html')
const { buildFrontPageHtml } = require('specpress/lib/md2html/frontPage')
const { collectFiles, concatenateFiles } = require('specpress/lib/common/specProcessor')
const { insertOmittedMarkers } = require('./helpers')
const { getFileFromCommit, collectFilesFromCommit } = require('specpress/lib/common/gitHelpers')

const logFile = path.join(os.tmpdir(), 'specpress-debug.log')
const log = (msg) => {
  const timestamp = new Date().toISOString()
  fs.appendFileSync(logFile, `${timestamp} ${msg}\n`)
}
log('=== SpecPress Debug Log Started ===')
console.log('SpecPress debug log:', logFile)

/** Scroll synchronization and double-click navigation script injected into the webview preview. */
const scrollSyncScript = `<script>
const vscode = acquireVsCodeApi();
let isScrolling = false;
let scrollTimeout = null;
let lastScrollTop = 0;
let updateCount = 0;
let loadingPrevious = false;

window.addEventListener('load', () => {
  updateCount++;
  // Wait for mermaid to finish rendering before measuring scroll
  if (typeof mermaid !== 'undefined') {
    mermaid.run().then(() => {
      const scrollY = window.pageYOffset || document.documentElement.scrollTop;
      const docHeight = document.documentElement.scrollHeight;
      console.log('[LOAD #' + updateCount + '] scrollY=' + scrollY + ', docHeight=' + docHeight);
      vscode.postMessage({ type: 'webviewReady' });
    }).catch(() => {
      const scrollY = window.pageYOffset || document.documentElement.scrollTop;
      const docHeight = document.documentElement.scrollHeight;
      console.log('[LOAD #' + updateCount + '] scrollY=' + scrollY + ', docHeight=' + docHeight);
      vscode.postMessage({ type: 'webviewReady' });
    });
  } else {
    const scrollY = window.pageYOffset || document.documentElement.scrollTop;
    const docHeight = document.documentElement.scrollHeight;
    console.log('[LOAD #' + updateCount + '] scrollY=' + scrollY + ', docHeight=' + docHeight);
    vscode.postMessage({ type: 'webviewReady' });
  }
});

window.addEventListener('scroll', () => {
  if (isScrolling) return;
  
  const scrollY = window.pageYOffset || document.documentElement.scrollTop;
  console.log('[SCROLL] scrollY=' + scrollY);

  if (scrollTimeout) clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    const currentScrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollingDown = currentScrollTop > lastScrollTop;
    lastScrollTop = currentScrollTop;

    const elements = document.querySelectorAll('[data-source-line]');
    let sourceLine = 0;
    let sourceFile = null;

    if (scrollingDown) {
      // Scrolling down: find last visible element
      const viewportBottom = window.innerHeight;
      for (let i = elements.length - 1; i >= 0; i--) {
        const el = elements[i];
        const rect = el.getBoundingClientRect();
        if (rect.top < viewportBottom) {
          sourceLine = parseInt(el.getAttribute('data-source-line'));
          sourceFile = el.getAttribute('data-source-file');
          break;
        }
      }
    } else {
      // Scrolling up: find first visible element
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.top >= 0) {
          sourceLine = parseInt(el.getAttribute('data-source-line'));
          sourceFile = el.getAttribute('data-source-file');
          break;
        }
      }
    }

    // Find current heading hierarchy
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    let currentHeadings = [];
    let lastHeadingTop = -Infinity;
    
    for (const h of headings) {
      const rect = h.getBoundingClientRect();
      if (rect.top <= 100) {
        const level = parseInt(h.tagName.substring(1));
        const text = h.textContent.trim();
        
        // If this heading is below the previous one, it's a continuation
        // Remove headings at this level and deeper to maintain proper hierarchy
        currentHeadings = currentHeadings.filter(item => item.level < level);
        currentHeadings.push({ level, text });
        lastHeadingTop = rect.top;
      } else {
        // Stop when we reach headings below viewport top
        break;
      }
    }
    
    // Build heading path, ensuring deepest level is always visible
    // Trim from left if too long (VS Code titles are left-aligned)
    let headingPath = '';
    if (currentHeadings.length > 0) {
      const fullPath = currentHeadings.map(h => h.text).join(' > ');
      
      // If longer than 60 chars, trim from left to keep deepest levels
      if (fullPath.length > 60 && currentHeadings.length > 1) {
        // Try progressively shorter paths starting from deeper levels
        for (let startIdx = 1; startIdx < currentHeadings.length; startIdx++) {
          const trimmedPath = currentHeadings.slice(startIdx).map(h => h.text).join(' > ');
          if (trimmedPath.length <= 54) { // Leave room for '... > ' prefix
            headingPath = '... > ' + trimmedPath;
            break;
          }
        }
        // If still too long, just show the deepest heading
        if (!headingPath) {
          const deepest = currentHeadings[currentHeadings.length - 1].text;
          headingPath = deepest.length > 60 ? '... > ' + deepest.substring(deepest.length - 54) : deepest;
        }
      } else {
        headingPath = fullPath;
      }
    }
    
    vscode.postMessage({ type: 'scroll', sourceLine, sourceFile, scrollingDown, headingPath });
    
    // Check if scrolled near edges to trigger loading more files
    const docHeight = document.documentElement.scrollHeight;
    const viewportHeight = window.innerHeight;
    const distanceFromTop = currentScrollTop;
    const distanceFromBottom = docHeight - currentScrollTop - viewportHeight;
    
    // Trigger load more when within 50% of viewport from edge
    // Load 2 files ahead when scrolling down for smoother experience
    if (distanceFromTop < viewportHeight * 0.5 && !loadingPrevious) {
      const scrollHeight = document.documentElement.scrollHeight;
      const currentScroll = window.pageYOffset || document.documentElement.scrollTop;
      loadingPrevious = true;
      vscode.postMessage({ type: 'loadPrevious', oldScrollHeight: scrollHeight, oldScrollTop: currentScroll });
    } else if (distanceFromBottom < viewportHeight * 0.5) {
      vscode.postMessage({ type: 'loadNext', count: 2 });
    }
  }, 50);
});

window.addEventListener('focus', () => {
  vscode.postMessage({ type: 'focus' });
});

window.addEventListener('dblclick', (e) => {
  let el = e.target;
  while (el && !el.getAttribute('data-source-line')) {
    el = el.parentElement;
  }
  if (!el) return;
  const sourceLine = parseInt(el.getAttribute('data-source-line'));
  const sourceFile = el.getAttribute('data-source-file') || null;
  vscode.postMessage({ type: 'openFile', sourceLine, sourceFile });
});

window.addEventListener('contextmenu', (e) => {
  let el = e.target;
  while (el && !el.getAttribute('data-source-line')) {
    el = el.parentElement;
  }
  if (!el) return;
  vscode.postMessage({
    type: 'contextTarget',
    sourceLine: parseInt(el.getAttribute('data-source-line')),
    sourceFile: el.getAttribute('data-source-file') || null
  });
});

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'updateFileContent') {
    // Update only the content for a specific file without reloading
    const filePath = message.filePath;
    const newHtml = message.html;
    
    console.log('[UPDATE] Received update for file:', filePath);
    
    // Save current scroll position
    const savedScroll = window.pageYOffset || document.documentElement.scrollTop;
    console.log('[UPDATE] Before update scrollY=' + savedScroll);
    
    // Find the div with data-file-section attribute by iterating (avoid querySelector escaping issues)
    const allSections = document.querySelectorAll('[data-file-section]');
    let fileSection = null;
    for (let i = 0; i < allSections.length; i++) {
      if (allSections[i].getAttribute('data-file-section') === filePath) {
        fileSection = allSections[i];
        break;
      }
    }
    
    if (!fileSection) {
      console.log('[UPDATE] Could not find file section for:', filePath);
      console.log('[UPDATE] Available sections:', allSections.length);
      if (allSections.length > 0) {
        console.log('[UPDATE] First section path:', allSections[0].getAttribute('data-file-section'));
      }
      return;
    }
    
    console.log('[UPDATE] Found file section');
    
    // Parse new HTML and extract content from wrapper div
    const temp = document.createElement('div');
    temp.innerHTML = newHtml;
    const newContent = temp.querySelector('[data-file-section]');
    
    if (newContent) {
      // Replace the content
      fileSection.innerHTML = newContent.innerHTML;
      console.log('[UPDATE] Replaced content');
      
      // Check if mermaid library is available
      console.log('[UPDATE] Mermaid available:', typeof mermaid !== 'undefined');
      console.log('[UPDATE] Window.mermaid available:', typeof window.mermaid !== 'undefined');
      
      // Wait for mermaid to re-render the new content, then restore scroll
      const mermaidLib = typeof mermaid !== 'undefined' ? mermaid : (typeof window.mermaid !== 'undefined' ? window.mermaid : null);
      
      if (mermaidLib) {
        // Find all mermaid blocks in the updated section
        const mermaidBlocks = fileSection.querySelectorAll('.mermaid');
        console.log('[UPDATE] Found ' + mermaidBlocks.length + ' mermaid blocks');
        
        if (mermaidBlocks.length > 0) {
          mermaidLib.run({ nodes: mermaidBlocks }).then(() => {
            window.scrollTo(0, savedScroll);
            const newScroll = window.pageYOffset || document.documentElement.scrollTop;
            console.log('[UPDATE] After mermaid scrollY=' + newScroll);
          }).catch((err) => {
            console.log('[UPDATE] Mermaid error:', err);
            window.scrollTo(0, savedScroll);
          });
        } else {
          window.scrollTo(0, savedScroll);
          console.log('[UPDATE] No mermaid blocks, restored scroll');
        }
      } else {
        window.scrollTo(0, savedScroll);
        console.log('[UPDATE] No mermaid library found');
      }
    } else {
      console.log('[UPDATE] Could not parse new content');
    }
  } else if (message.type === 'scrollTo') {
    isScrolling = true;
    // Find element matching both line and file
    let targetElement = null;
    if (message.sourceFile) {
      const elements = document.querySelectorAll('[data-source-line="' + message.sourceLine + '"]');
      for (const el of elements) {
        if (el.getAttribute('data-source-file') === message.sourceFile) {
          targetElement = el;
          break;
        }
      }
    } else {
      targetElement = document.querySelector('[data-source-line="' + message.sourceLine + '"]');
    }
    
    if (targetElement) {
      const block = message.scrollingDown ? 'end' : 'start';
      targetElement.scrollIntoView({ block, behavior: 'auto' });
    }
    setTimeout(() => isScrolling = false, 150);
  } else if (message.type === 'ensureVisible') {
    // Only scroll if the target line is not already visible
    let targetElement = null;
    if (message.sourceFile) {
      const elements = document.querySelectorAll('[data-source-line="' + message.sourceLine + '"]');
      for (const el of elements) {
        if (el.getAttribute('data-source-file') === message.sourceFile) {
          targetElement = el;
          break;
        }
      }
    } else {
      targetElement = document.querySelector('[data-source-line="' + message.sourceLine + '"]');
    }
    
    if (targetElement) {
      const rect = targetElement.getBoundingClientRect();
      // More lenient visibility check - only scroll if significantly out of view
      // Allow 20% margin at top and bottom
      const margin = window.innerHeight * 0.2;
      const isVisible = rect.top >= -margin && rect.bottom <= window.innerHeight + margin;
      if (!isVisible) {
        isScrolling = true;
        targetElement.scrollIntoView({ block: 'center', behavior: 'auto' });
        setTimeout(() => isScrolling = false, 150);
      }
    }

  } else if (message.type === 'scrollToFile') {
    const file = message.file;
    const line = message.line || 0;
    let best = null;
    let bestDist = Infinity;
    const candidates = [];
    document.querySelectorAll('[data-source-file]').forEach(el => {
      const elFile = el.getAttribute('data-source-file');
      candidates.push(elFile);
      if (elFile === file) {
        const elLine = parseInt(el.getAttribute('data-source-line')) || 0;
        const dist = Math.abs(elLine - line);
        if (dist < bestDist) { bestDist = dist; best = el; }
      }
    });
    console.log('scrollToFile:', file, 'line:', line, 'found:', !!best, 'candidates:', candidates.length);
    if (best) {
      isScrolling = true;
      best.scrollIntoView({ block: 'center', behavior: 'auto' });
      setTimeout(() => {
        isScrolling = false;
      }, 200);
    } else {
      console.log('No match found. Looking for:', file);
      console.log('Available files:', [...new Set(candidates)]);
    }
  } else if (message.type === 'restoreScrollAfterPrepend') {
    console.log('[PREPEND] Restoring scroll, oldHeight=' + message.oldScrollHeight + ', oldScrollTop=' + message.oldScrollTop);
    
    // Wait for mermaid to finish rendering before adjusting scroll
    const restoreScroll = () => {
      const newScrollHeight = document.documentElement.scrollHeight;
      const heightDiff = newScrollHeight - message.oldScrollHeight;
      console.log('[PREPEND] newHeight=' + newScrollHeight + ', heightDiff=' + heightDiff);
      
      if (heightDiff > 0) {
        // Set scroll to old position plus the height of prepended content
        const newScroll = message.oldScrollTop + heightDiff;
        console.log('[PREPEND] Setting scroll to ' + newScroll + ' (was at ' + message.oldScrollTop + ')');
        window.scrollTo(0, newScroll);
        // Re-enable loading after scroll is restored
        setTimeout(() => {
          loadingPrevious = false;
          console.log('[PREPEND] Re-enabled loadPrevious trigger');
        }, 200);
      } else {
        loadingPrevious = false;
      }
    };
    
    // Wait for mermaid if available
    const mermaidLib = typeof mermaid !== 'undefined' ? mermaid : (typeof window.mermaid !== 'undefined' ? window.mermaid : null);
    if (mermaidLib) {
      mermaidLib.run().then(restoreScroll).catch(restoreScroll);
    } else {
      // Small delay to let DOM settle
      setTimeout(restoreScroll, 50);
    }
  }
});
</script>`

/**
 * Manages the webview preview panel, scroll synchronization, and live updates.
 */
class PreviewManager {
  /**
   * @param {import('./stateManager').StateManager} state
   * @param {import('./configLoader').ConfigLoader} config
   * @param {string} extensionDir - Absolute path to the extension root directory.
   */
  constructor(state, config, extensionDir) {
    this.state = state
    this.config = config
    this.extensionDir = extensionDir
  }

  /** Creates or re-creates the Md2Html handler with current settings. */
  initHandler() {
    this.state.handler = new Md2Html({
      css: this.config.loadCss(this.extensionDir),
      mermaidConfig: this.config.loadMermaidConfig(),
      frontPageHtml: buildFrontPageHtml(this.config.loadFrontPageData()),
      customRenderers: this.config.customRenderers,
      resolveImageUri: (absPath) => this.state.panel ? this.state.panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString() : absPath,
      extraHeadContent: scrollSyncScript
    })
  }

  /**
   * Collects files in the spec root and builds context around the current file.
   * @param {string} currentFilePath - Path to the currently open file.
   * @returns {{ files: string[], currentIndex: number }} All files and index of current file.
   */
  buildFileContext(currentFilePath) {
    const specRoot = this.config.getSpecRootForFile(currentFilePath)
    if (!specRoot) return { files: [currentFilePath], currentIndex: 0 }
    
    const allFiles = collectFiles([specRoot]).filter(f => f.endsWith('.md') || f.endsWith('.markdown') || f.endsWith('.asn'))
    const currentIndex = allFiles.findIndex(f => path.normalize(f) === path.normalize(currentFilePath))
    
    if (currentIndex === -1) return { files: [currentFilePath], currentIndex: 0 }
    return { files: allFiles, currentIndex }
  }

  /**
   * Renders a file to HTML, using cache for adjacent files.
   * @param {string} filePath - File to render.
   * @param {boolean} isCurrentFile - Whether this is the active editor file.
   * @returns {string} Rendered HTML body content.
   */
  renderFileToHtml(filePath, isCurrentFile) {
    const state = this.state
    
    if (!isCurrentFile && state.adjacentFileCache.has(filePath)) {
      return state.adjacentFileCache.get(filePath)
    }
    
    this.ensureHandler()
    const isAsn = filePath.endsWith('.asn')
    let content
    
    if (isCurrentFile && state.currentEditor && state.currentEditor.document.uri.fsPath === filePath) {
      content = state.currentEditor.document.getText()
    } else {
      content = fs.readFileSync(filePath, 'utf8')
    }
    
    // Convert ASN files to markdown with heading and comments
    if (isAsn) {
      const { asnToMarkdown } = require('specpress/lib/md2html/handlers/asnHandler')
      const specRoot = this.config.getSpecRootForFile(filePath)
      content = asnToMarkdown(content, specRoot, filePath)
    }
    
    // Add FILE comment to mark file boundaries
    const fileMarker = `<!-- FILE: ${filePath} -->\n`
    content = fileMarker + content
    
    const specRoot = this.config.getSpecRootForFile(filePath)
    const baseDir = path.dirname(filePath)
    let html = state.handler.renderBody(content, true, baseDir, filePath, specRoot, false)
    
    // Wrap the rendered HTML with a div that has a data attribute for easy identification
    html = `<div data-file-section="${filePath}">${html}</div>`
    
    // Cache adjacent files
    if (!isCurrentFile) {
      state.adjacentFileCache.set(filePath, html)
    }
    
    return html
  }

  /**
   * Builds the full preview HTML with current file + adjacent files.
   * @returns {string} Complete HTML document.
   */
  buildContextPreview() {
    const state = this.state
    if (!state.currentEditor || state.contextFiles.length === 0) return ''
    
    const currentFilePath = state.currentEditor.document.uri.fsPath
    
    // Initialize context window if not set
    if (state.contextStartIdx === -1) {
      state.contextStartIdx = Math.max(0, state.currentFileIndex - 1)
      state.contextEndIdx = Math.min(state.contextFiles.length - 1, state.currentFileIndex + 1)
    }
    
    // Get files in context window
    const contextFiles = []
    for (let i = state.contextStartIdx; i <= state.contextEndIdx; i++) {
      contextFiles.push(state.contextFiles[i])
    }
    
    // Check if we're at the beginning of the spec (include cover page)
    const isAtSpecStart = state.contextStartIdx === 0
    
    // Use concatenateFiles to get proper auto-headings and section numbering
    const specRoot = this.config.getSpecRootForFile(currentFilePath)
    const readFile = (filePath) => {
      const isCurrentFile = filePath === currentFilePath
      if (isCurrentFile && state.currentEditor) {
        return state.currentEditor.document.getText()
      }
      return fs.readFileSync(filePath, 'utf8')
    }
    
    const concatenated = concatenateFiles(contextFiles, readFile, specRoot)
    
    this.ensureHandler()
    
    // Include cover page if at spec start
    if (isAtSpecStart) {
      state.handler.frontPageHtml = buildFrontPageHtml(this.config.loadFrontPageData())
    } else {
      state.handler.frontPageHtml = null
    }
    
    const baseDir = path.dirname(currentFilePath)
    let html = state.handler.renderMarkdown(concatenated, baseDir, null, specRoot, isAtSpecStart)
    
    html = this.applyDiff(html, concatenated, null, contextFiles, { 
      baseDir, 
      specRoot, 
      includeFrontPage: isAtSpecStart 
    })
    
    return html
  }

  /** Ensures the handler is initialized. */
  ensureHandler() {
    if (!this.state.handler) this.initHandler()
  }

  /**
   * Applies change tracking by diffing rendered HTML of baseline vs current.
   * Uses htmldiff-js for word-level HTML diffing that preserves all formatting.
   *
   * @param {string} currentHtml - Full rendered HTML of the current version.
   * @param {string} content - Current markdown content (for baseline rendering).
   * @param {string} filePath - Source file path (for single-file mode).
   * @param {string[]} [files] - All files (for multi-file mode).
   * @param {Object} renderOpts - { baseDir, specRoot, filePath, includeFrontPage } for rendering baseline.
   * @returns {string} HTML with tracked changes, or original HTML if tracking disabled.
   */
  applyDiff(currentHtml, content, filePath, files, renderOpts) {
    const state = this.state
    if (!state.changeTrackingCommit || !state.changeTrackingBaseline) return currentHtml

    const normPath = (p) => p.replace(/\\/g, '/').toLowerCase()

    // -- Step 1: Retrieve baseline content from the cached git commit --
    // For single-file mode, look up the file directly in the cache.
    // For multi-file mode, concatenate all baseline files (same as the current preview does).
    let baselineContent = ''
    if (filePath) {
      baselineContent = state.changeTrackingBaseline.get(filePath) || ''
      if (!baselineContent) {
        const target = normPath(filePath)
        for (const [key, val] of state.changeTrackingBaseline) {
          if (normPath(key) === target) { baselineContent = val; break }
        }
      }
    } else if (files) {
      const specRoot = renderOpts.specRoot || ''
      const getBaseline = (f) => {
        if (state.changeTrackingBaseline.has(f)) return state.changeTrackingBaseline.get(f)
        const target = normPath(f)
        for (const [key, val] of state.changeTrackingBaseline) {
          if (normPath(key) === target) return val
        }
        return ''
      }
      const baselineFiles = files.filter(f => getBaseline(f) !== '')
      baselineContent = concatenateFiles(baselineFiles, getBaseline, specRoot)
    }

    if (!baselineContent) return currentHtml

    // -- Step 2: Prepare baseline content for rendering --
    // Normalize line endings (git stores LF, local files may have CRLF).
    // Inline linked JsonTable files from the baseline cache, because the
    // renderer would otherwise try to read them from the local filesystem
    // (which has the current version, not the baseline version).
    baselineContent = baselineContent.replace(/\r\n/g, '\n')
    baselineContent = baselineContent.replace(/\[JsonTable\]\(([^)]+\.json)\)/g, (match, jsonRelPath) => {
      try {
        const beforeMatch = baselineContent.substring(0, baselineContent.indexOf(match))
        const fileComment = beforeMatch.match(/<!-- FILE: (.+?) -->/g)
        const lastFile = fileComment ? fileComment[fileComment.length - 1].match(/<!-- FILE: (.+?) -->/)[1] : (filePath || (files && files[0]) || '')
        const dir = path.dirname(lastFile)
        const jsonPath = path.isAbsolute(jsonRelPath) ? jsonRelPath : path.join(dir, jsonRelPath)

        let baselineJson = state.changeTrackingBaseline.get(jsonPath) || null
        if (!baselineJson) {
          const target = normPath(jsonPath)
          for (const [key, val] of state.changeTrackingBaseline) {
            if (normPath(key) === target) { baselineJson = val; break }
          }
        }
        if (baselineJson) {
          return '```jsonTable\n' + baselineJson + '\n```'
        }
      } catch (e) { /* fall through */ }
      return match
    })

    // -- Step 3: Render baseline markdown to HTML --
    // Uses forPreview=false (no data-source-line attributes) since this is
    // only used for diffing, not for scroll sync or navigation.
    this.ensureHandler()
    const includeFrontPage = !!renderOpts.includeFrontPage
    let savedFrontHtml = null
    if (includeFrontPage) {
      savedFrontHtml = state.handler.frontPageHtml
      const baselineFront = this._buildBaselineFrontPage(state, normPath)
      state.handler.frontPageHtml = baselineFront !== null ? baselineFront : savedFrontHtml
    }
    const baselineBody = state.handler.renderBody(
      baselineContent, false,
      renderOpts.baseDir || null,
      renderOpts.filePath || null,
      renderOpts.specRoot || null,
      includeFrontPage
    )
    if (savedFrontHtml !== null) state.handler.frontPageHtml = savedFrontHtml

    // -- Step 4: Replace images and mermaid blocks with stable placeholders --
    // htmldiff-js works on text tokens. Binary content (images) and complex
    // blocks (mermaid) would be broken apart by the diff algorithm. We replace
    // them with short placeholder strings before diffing, then restore them after.
    //
    // Placeholder IDs are derived from content hashes so that identical content
    // in baseline and current produces the same placeholder text -- making
    // htmldiff treat them as unchanged.
    const bodyMatch = currentHtml.match(/<body>([\s\S]*)<\/body>/)
    if (!bodyMatch) return currentHtml
    const currentBody = bodyMatch[1]

    const placeholders = new Map()
    const hashContent = (data) => crypto.createHash('md5').update(data).digest('hex').substring(0, 12)

    /** Extracts mermaid source from a <pre> tag, stripping HTML attributes and normalizing line endings. */
    const mermaidSource = (preTag) => preTag.replace(/<pre[^>]*>/, '').replace(/<\/pre>/, '').trim().replace(/\r\n/g, '\n')

    const replaceBlocks = (html, version) => {
      // Mermaid: use source content hash as ID (ignores <pre> tag attributes
      // which differ between forPreview=true and forPreview=false rendering)
      html = html.replace(/<pre class="mermaid"[^>]*>[\s\S]*?<\/pre>/g, (match) => {
        const hash = hashContent(mermaidSource(match))
        const id = `MERMAID_${hash}`
        if (!placeholders.has(id)) placeholders.set(id, {})
        placeholders.get(id)[version] = match
        return ` ${id} `
      })
      // Images: use src as stable ID (both baseline and current now produce
      // the same webview URI for the same path). Content hashes detect binary
      // changes where the markdown reference is unchanged but the file differs.
      html = html.replace(/<img[^>]*>/g, (match) => {
        const src = (match.match(/src="([^"]+)"/) || [])[1] || ''
        const decodedSrc = decodeURIComponent(src)
        const filename = decodedSrc.split('/').pop().split('?')[0]
        const id = `IMG_${filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}`
        if (!placeholders.has(id)) placeholders.set(id, { filename })
        const entry = placeholders.get(id)
        entry[version] = match
        if (version === 'current') {
          // Hash the current file to detect binary changes
          try {
            const urlPath = decodedSrc.replace(/^https?:\/\/[^/]+\//, '')
            const imgPath = decodeURIComponent(urlPath)
            if (imgPath && fs.existsSync(imgPath)) {
              entry.currentHash = hashContent(fs.readFileSync(imgPath))
            }
          } catch (e) { /* no hash */ }
        } else {
          // Hash the baseline file from the git cache
          for (const [key, val] of state.changeTrackingBaseline) {
            if (normPath(key).endsWith('/' + normPath(filename))) {
              entry.baselineHash = hashContent(Buffer.isBuffer(val) ? val : Buffer.from(val))
              break
            }
          }
        }
        return ` ${id} `
      })
      return html
    }

    const processedBaseline = replaceBlocks(baselineBody, 'baseline')
    let processedCurrent = replaceBlocks(currentBody, 'current')
    // Strip data-source-line/file attributes so both sides have the same
    // structure for diffing (baseline is rendered without preview annotations).
    // Unwrap ASN.1 per-line <span data-source-line="N"> wrappers inside <pre class="asn">.
    // Preview renders each line as: <span data-source-line="N">CONTENT</span>\n
    // Baseline (forPreview=false) renders as: CONTENT\n
    // Must run before general attribute stripping to match the data-source-line attribute.
    processedCurrent = processedCurrent.replace(/(<pre class="asn"[^>]*><code>)([\s\S]*?)(<\/code><\/pre>)/g, (match, open, content, close) => {
      const fixed = content
        .replace(/<span data-source-line="[^"]*"(?:\s+data-source-file="[^"]*")?>/g, '')
        .replace(/<\/span>\n/g, '\n')
        .replace(/<\/span>$/, '')
      return open + fixed + close
    })
    // Strip remaining data-source-line/file attributes from non-ASN elements
    processedCurrent = processedCurrent.replace(/ data-source-line="[^"]*"/g, '')
    processedCurrent = processedCurrent.replace(/ data-source-file="[^"]*"/g, '')

    // -- Step 5: Run word-level HTML diff on the placeholder-substituted text --
    let diffedBody = HtmlDiff.default.execute(processedBaseline, processedCurrent)

    // -- Step 6: Restore placeholders with appropriate diff visualization --
    // Three cases for each placeholder:
    //   - Wrapped in <del>: element was removed -> show with "Deleted" label
    //   - Wrapped in <ins>: element was added -> show with "New" label
    //   - Unchanged text: element exists in both -> restore current version,
    //     but check content hashes to detect file-level changes (e.g. an image
    //     file was modified even though the markdown reference is the same)
    for (const [id, entry] of placeholders) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

      // Case 1: placeholder is inside a <del> tag -> element was removed
      const delRe = new RegExp(`<del[^>]*>[^<]*?${escaped}[^<]*?<\\/del>`, 'g')
      diffedBody = diffedBody.replace(delRe, () => {
        const html = entry.baseline || entry.current || ''
        const label = id.startsWith('MERMAID_') ? 'Deleted figure:' : 'Deleted image:'
        return `<div class="diff-del-block"><p class="diff-label">${label}</p>${html}</div>`
      })

      // Case 2: placeholder is inside an <ins> tag -> element was added
      const insRe = new RegExp(`<ins[^>]*>[^<]*?${escaped}[^<]*?<\\/ins>`, 'g')
      diffedBody = diffedBody.replace(insRe, () => {
        const html = entry.current || entry.baseline || ''
        const label = id.startsWith('MERMAID_') ? 'New figure:' : 'New image:'
        return `<div class="diff-ins-block"><p class="diff-label">${label}</p>${html}</div>`
      })

      // Case 3: placeholder text unchanged in diff output -> element exists in both.
      // For images, compare file content hashes to detect binary changes.
      // For mermaid, compare source code to detect diagram changes.
      const plainRe = new RegExp(` ${escaped} `, 'g')
      diffedBody = diffedBody.replace(plainRe, () => {
        if (id.startsWith('IMG_') && entry.baselineHash && entry.currentHash && entry.baselineHash !== entry.currentHash) {
          const currentImg = entry.current || ''
          let oldImg = ''
          const targetName = normPath(entry.filename || '')
          for (const [key, val] of state.changeTrackingBaseline) {
            if (Buffer.isBuffer(val) && normPath(key).endsWith('/' + targetName)) {
              const ext = key.split('.').pop().toLowerCase()
              const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
              const b64 = val.toString('base64')
              const alt = (currentImg.match(/alt="([^"]*)"/) || [])[1] || ''
              oldImg = `<img src="data:${mime};base64,${b64}" alt="${alt}">`
              break
            }
          }
          if (!oldImg) oldImg = currentImg
          return `<div class="diff-del-block"><p class="diff-label">Old image:</p>${oldImg}</div><div class="diff-ins-block"><p class="diff-label">New image:</p>${currentImg}</div>`
        }
        if (id.startsWith('MERMAID_') && entry.baseline && entry.current && mermaidSource(entry.baseline) !== mermaidSource(entry.current)) {
          return `<div class="diff-del-block"><p class="diff-label">Deleted figure:</p>${entry.baseline}</div><div class="diff-ins-block"><p class="diff-label">New figure:</p>${entry.current}</div>`
        }
        return entry.current || entry.baseline || ` ${id} `
      })
    }

    return currentHtml.replace(bodyMatch[0], '<body>' + diffedBody + '</body>')
  }

  /**
   * Builds front page HTML from the baseline cache's front page data JSON.
   * @returns {string|null} Rendered front page HTML, or null if not available.
   */
  _buildBaselineFrontPage(state, normPath) {
    const dataFile = this.config.frontPageData
    if (!dataFile) return null

    const targetName = normPath(path.basename(dataFile))
    let baselineDataJson = null
    for (const [key, val] of state.changeTrackingBaseline) {
      if (typeof val === 'string' && normPath(key).endsWith('/' + targetName)) {
        baselineDataJson = val
        break
      }
    }
    if (!baselineDataJson) return null

    try {
      return buildFrontPageHtml(JSON.parse(baselineDataJson))
    } catch (e) {
      return null
    }
  }

  /**
   * Registers the webview message handler on the panel.
   * Handles scroll sync, double-click file opening, restore button, and scroll restore.
   */
  registerMessageHandler() {
    const state = this.state
    state.panel.webview.onDidReceiveMessage(message => {
      if (message.type === 'webviewReady') {
        if (state.isMultiFilePreview && state.restoreScrollTarget) {
          state.panel.webview.postMessage({ type: 'scrollToFile', file: state.restoreScrollTarget.file, line: state.restoreScrollTarget.line })
          state.restoreScrollTarget = null
        }
        // Don't scroll to current file if we're suppressing it (e.g., during loadPrevious)
        // The suppressScrollToFile flag is checked in setupPreview's setTimeout
      } else if (message.type === 'scroll') {
        // Update panel title with current heading path
        if (state.panel && message.headingPath) {
          const prefix = state.changeTrackingCommit ? 'Preview (changes): ' : 'Preview: '
          state.panel.title = prefix + message.headingPath
        }
        
        // Sync preview scroll to editor
        if (state.currentEditor && !state.isMultiFilePreview && !state.isEditorScrolling && !state.lastFocusedIsEditor) {
          // Only sync scroll if the source line belongs to the current editor file
          const currentFile = state.currentEditor.document.uri.fsPath
          const normalizeFile = (f) => f ? path.normalize(f).toLowerCase() : null
          
          if (message.sourceFile && normalizeFile(message.sourceFile) !== normalizeFile(currentFile)) {
            // Scroll event is from an adjacent file section - ignore for editor sync
            return
          }
          
          state.isPreviewScrolling = true
          const revealType = message.scrollingDown ? vscode.TextEditorRevealType.AtBottom : vscode.TextEditorRevealType.AtTop
          const range = new vscode.Range(message.sourceLine, 0, message.sourceLine, 0)
          state.currentEditor.revealRange(range, revealType)
          setTimeout(() => state.isPreviewScrolling = false, 150)
        }
      } else if (message.type === 'loadPrevious') {
        // User scrolled near top - expand context window upward if possible
        if (state.contextStartIdx > 0) {
          const oldScrollHeight = message.oldScrollHeight || 0
          const oldScrollTop = message.oldScrollTop || 0
          
          log(`[LOAD_PREV] Expanding context upward, oldScrollHeight=${oldScrollHeight}, oldScrollTop=${oldScrollTop}`)
          
          state.contextStartIdx = Math.max(0, state.contextStartIdx - 1)
          const html = this.buildContextPreview()
          
          // Disable the automatic scrollToFile that happens on webviewReady
          state.suppressScrollToFile = true
          
          state.panel.webview.html = html
          
          // Restore scroll position by adjusting for the height difference
          setTimeout(() => {
            if (state.panel && oldScrollHeight > 0) {
              state.panel.webview.postMessage({ 
                type: 'restoreScrollAfterPrepend',
                oldScrollHeight,
                oldScrollTop
              })
              log(`[LOAD_PREV] Sent restoreScrollAfterPrepend`)
            }
            state.suppressScrollToFile = false
          }, 100)
        }
      } else if (message.type === 'loadNext') {
        // User scrolled near bottom - expand context window downward
        // Load 2 files at once for smoother scrolling
        const count = message.count || 1
        const newEndIdx = Math.min(state.contextFiles.length - 1, state.contextEndIdx + count)
        if (newEndIdx > state.contextEndIdx) {
          state.contextEndIdx = newEndIdx
          const html = this.buildContextPreview()
          state.panel.webview.html = html
        }
      } else if (message.type === 'openFile') {
        const filePath = message.sourceFile || (state.currentEditor && state.currentEditor.document.uri.fsPath)
        if (!filePath) return
        const line = message.sourceLine || 0
        vscode.workspace.openTextDocument(vscode.Uri.file(filePath)).then(doc => {
          vscode.window.showTextDocument(doc, vscode.ViewColumn.One).then(editor => {
            const pos = new vscode.Position(line, 0)
            editor.selection = new vscode.Selection(pos, pos)
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
          })
        })
      } else if (message.type === 'contextTarget') {
        state.lastContextTarget = { file: message.sourceFile, line: message.sourceLine }
      } else if (message.type === 'focus') {
        state.lastFocusedIsEditor = false
        if (!state.isMultiFilePreview) {
          const ed = state.currentEditor || vscode.window.activeTextEditor
          if (ed) vscode.window.showTextDocument(ed.document, ed.viewColumn, false)
        }
      }
    })
  }

  /**
   * Sets up or updates the preview panel for a given editor.
   * @param {vscode.TextEditor} editor - The editor whose document to preview.
   */
  setupPreview(editor) {
    if (!editor) return
    const isMarkdown = editor.document.languageId === 'markdown'
    const isAsn = editor.document.fileName.endsWith('.asn')
    if (!isMarkdown && !isAsn) return
    if (!this.config.isInsideSpecRoot(editor.document.uri.fsPath)) return

    const state = this.state
    const filePath = editor.document.uri.fsPath
    
    // Build file context (current + neighbors)
    const { files, currentIndex } = this.buildFileContext(filePath)
    state.contextFiles = files
    state.currentFileIndex = currentIndex
    
    // Reset or initialize context window (load 2 files before/after for smoother scrolling)
    state.contextStartIdx = Math.max(0, currentIndex - 2)
    state.contextEndIdx = Math.min(files.length - 1, currentIndex + 2)
    
    state.disposeListeners()
    state.currentEditor = editor
    state.isMultiFilePreview = false
    state.lastVisibleRange = editor.visibleRanges[0] || null
    state.lastFocusedIsEditor = false
    vscode.commands.executeCommand('setContext', 'specpress.isMultiFilePreview', false)

    const isNewPanel = !state.panel

    if (!state.panel) {
      const resourceRoot = this.config.findSpecRootFor(editor.document.uri.fsPath)
        || this.config.wsRoot
        || path.dirname(editor.document.uri.fsPath)
      state.panel = vscode.window.createWebviewPanel('specpressPreview', 'Preview',
        vscode.ViewColumn.Beside, { 
          enableScripts: true, 
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(resourceRoot)] 
        })
      state.panel.onDidDispose(() => state.onPanelDisposed())
      this.registerMessageHandler()
    }

    // Render context preview (current + adjacent files)
    const html = this.buildContextPreview()
    state.panel.webview.html = html
    // Initial title will be updated by scroll event once webview loads
    const prefix = state.changeTrackingCommit ? 'Preview (changes)' : 'Preview'
    state.panel.title = prefix

    // Scroll to current file and current line, then enable navigation
    setTimeout(() => {
      if (state.panel && state.currentEditor && !state.suppressScrollToFile) {
        const cursorLine = state.currentEditor.selection.active.line
        state.panel.webview.postMessage({ 
          type: 'scrollToFile', 
          file: state.currentEditor.document.uri.fsPath, 
          line: cursorLine 
        })
      }
    }, 100)

    if (isNewPanel) {
      setTimeout(() => {
        vscode.window.showTextDocument(editor.document, editor.viewColumn, false)
      }, 100)
    }

    let updateTimeout = null
    state.updatePreview = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document === state.currentEditor.document && state.panel) {
        // Debounce: only update preview 500ms after you stop typing
        if (updateTimeout) clearTimeout(updateTimeout)
        updateTimeout = setTimeout(() => {
          if (!state.panel || !state.currentEditor) return
          
          log(`[UPDATE] Rebuilding context preview`)
          
          // Rebuild full context preview (includes auto-headings)
          const html = this.buildContextPreview()
          state.panel.webview.html = html
        }, 500)
      }
    })

    state.fileSaveListener = vscode.workspace.onDidSaveTextDocument(doc => {
      if (!state.panel || state.isMultiFilePreview) return
      if (!state.currentEditor) return
      
      const savedPath = doc.uri.fsPath
      
      // Check if saved file is in context (adjacent file or JSON)
      if (state.contextFiles.includes(savedPath) || doc.fileName.endsWith('.json')) {
        // Invalidate cache and rebuild
        state.adjacentFileCache.delete(savedPath)
        const html = this.buildContextPreview()
        state.panel.webview.html = html
      }
    })

    state.scrollSync = vscode.window.onDidChangeTextEditorVisibleRanges(e => {
      if (state.panel && !state.isMultiFilePreview && !state.isPreviewScrolling
        && state.currentEditor && e.textEditor.document === state.currentEditor.document) {
        state.isEditorScrolling = true
        
        const visibleRange = e.visibleRanges[0]
        const prevRange = state.lastVisibleRange
        state.lastVisibleRange = visibleRange
        
        let sourceLine, scrollingDown
        if (prevRange && visibleRange && visibleRange.start.line > prevRange.start.line) {
          // Scrolling down: sync to last visible line (end.line is exclusive, so subtract 1)
          sourceLine = Math.max(0, visibleRange.end.line - 1)
          scrollingDown = true
        } else if (visibleRange) {
          // Scrolling up or first scroll: sync to first visible line
          sourceLine = visibleRange.start.line
          scrollingDown = false
        } else {
          return
        }
        
        // Send both line and file to ensure we scroll to the right element
        const currentFile = state.currentEditor.document.uri.fsPath
        state.panel.webview.postMessage({ 
          type: 'scrollTo', 
          sourceLine, 
          sourceFile: currentFile,
          scrollingDown 
        })
        setTimeout(() => state.isEditorScrolling = false, 150)
      }
    })

    const editorFocusListener = vscode.window.onDidChangeActiveTextEditor(ed => {
      if (ed && state.currentEditor && ed.document === state.currentEditor.document) {
        state.currentEditor = ed
        state.lastFocusedIsEditor = true
      } else if (ed && state.panel && !state.isMultiFilePreview) {
        // User switched to a different file - rebuild context if it's a spec file
        const isMarkdown = ed.document.languageId === 'markdown'
        const isAsn = ed.document.fileName.endsWith('.asn')
        if ((isMarkdown || isAsn) && this.config.isInsideSpecRoot(ed.document.uri.fsPath)) {
          // Reset context window for the new file
          state.contextStartIdx = -1
          state.contextEndIdx = -1
          this.setupPreview(ed)
        }
      }
    })

    state.panel.onDidDispose(() => {
      state.onPanelDisposed()
      editorFocusListener.dispose()
    })
  }

  /**
   * Builds and displays a multi-file preview.
   *
   * @param {vscode.Uri[]} uris - Selected file/folder URIs.
   * @param {{ repoRoot: string, commit: string, shortHash: string }|null} commitRef - Git commit reference, or null for local files.
   */
  async previewMultiple(uris, commitRef) {
    const state = this.state
    const config = this.config

    state.disposeListeners()
    state.isMultiFilePreview = true
    vscode.commands.executeCommand('setContext', 'specpress.isMultiFilePreview', true)
    state.currentEditor = null
    state.lastMultiFileUris = uris
    state.isSpecRootPreview = config.isSpecRootSelection(uris)
    // Reset context window state when switching to multi-file mode
    state.contextStartIdx = -1
    state.contextEndIdx = -1
    state.contextFiles = []
    state.currentFileIndex = -1
    state.adjacentFileCache.clear()

    const buildPreview = () => {
      const files = commitRef
        ? collectFilesFromCommit(commitRef.repoRoot, uris.map(u => u.fsPath), commitRef.commit)
        : collectFiles(uris.map(u => u.fsPath))

      const filePaths = files.filter(f => f.endsWith('.md') || f.endsWith('.markdown'))

      // Build image cache from git commit if viewing a commit
      let imageCache = null
      if (commitRef) {
        const { extractFilesFromCommit } = require('./helpers')
        const specRoots = files.length > 0 ? [config.getSpecRootForFile(files[0])] : []
        imageCache = extractFilesFromCommit(commitRef.repoRoot, commitRef.commit, specRoots)
      }

      this.ensureHandler()
      
      // Override image resolver for git commits
      if (commitRef && imageCache) {
        const normPath = (p) => p.replace(/\\/g, '/').toLowerCase()
        state.handler.resolveImageUri = (absPath) => {
          // Try to find image in git cache
          let imgData = imageCache.get(absPath)
          if (!imgData) {
            const target = normPath(absPath)
            for (const [key, val] of imageCache) {
              if (normPath(key) === target) {
                imgData = val
                break
              }
            }
          }
          if (imgData && Buffer.isBuffer(imgData)) {
            const ext = absPath.split('.').pop().toLowerCase()
            const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
            return `data:${mime};base64,${imgData.toString('base64')}`
          }
          // Fallback to local file
          return state.panel ? state.panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString() : absPath
        }
      } else {
        // Reset to default resolver for local files
        state.handler.resolveImageUri = (absPath) => state.panel ? state.panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString() : absPath
      }
      
      if (state.isSpecRootPreview) state.handler.frontPageHtml = buildFrontPageHtml(this.config.loadFrontPageData())

      const specRoot = files.length > 0 ? config.getSpecRootForFile(files[0]) : ''
      const readFile = commitRef ? (f) => getFileFromCommit(commitRef.repoRoot, f, commitRef.commit) : undefined
      let processedContent = concatenateFiles(files, readFile, specRoot)
      if (specRoot && !state.isSpecRootPreview) {
        const allFiles = collectFiles([specRoot])
        if (files.length < allFiles.length) {
          processedContent = insertOmittedMarkers(processedContent, files, allFiles)
        }
      }

      state.multiFileContent = processedContent
      state.multiFilePaths = filePaths
      state.multiFileAllFiles = files
      state.multiFileBaseDir = files.length > 0 ? path.dirname(files[0]) : (config.wsRoot || '')

      const baseDir = config.wsRoot || state.multiFileBaseDir

      if (!state.panel) {
        const resourceRoot = (files.length > 0 ? config.findSpecRootFor(files[0]) : '')
          || config.wsRoot
          || baseDir
        state.panel = vscode.window.createWebviewPanel('specpressPreview', 'Multiple Files Preview',
          vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [vscode.Uri.file(resourceRoot)] })
        state.panel.onDidDispose(() => state.onPanelDisposed())
        this.registerMessageHandler()
      }

      state.panel.title = commitRef ? `Preview (${commitRef.shortHash})` : (state.changeTrackingCommit ? 'Preview (changes)' : 'Multiple Files Preview')
      let html = state.handler.renderMarkdown(processedContent, baseDir, null, specRoot, state.isSpecRootPreview)
      // Only apply diff if change tracking is enabled AND we're viewing local files (not a git commit)
      if (!commitRef) {
        html = this.applyDiff(html, processedContent, null, files, { baseDir, specRoot, includeFrontPage: state.isSpecRootPreview })
      }
      state.panel.webview.html = html
    }

    const title = commitRef ? `Loading preview from ${commitRef.shortHash}...` : 'Loading preview...'
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      async () => buildPreview()
    )

    // Re-render multi-file preview when spec files are saved
    if (!commitRef) {
      state.fileSaveListener = vscode.workspace.onDidSaveTextDocument(doc => {
        if (!state.panel || !state.isMultiFilePreview) return
        const ext = path.extname(doc.fileName).toLowerCase()
        const isSpecFile = ['.md', '.markdown', '.asn', '.json'].includes(ext)
        if (!isSpecFile) return
        if (!config.isInsideSpecRoot(doc.uri.fsPath)) return

        // For MD/ASN changes, re-collect and re-concatenate files
        if (ext !== '.json') {
          buildPreview()
        } else {
          // For JSON changes, just re-render (JsonTable content read at render time)
          this.ensureHandler()
          state.handler.frontPageHtml = buildFrontPageHtml(this.config.loadFrontPageData())
          const specRoot = state.multiFileAllFiles && state.multiFileAllFiles.length > 0
            ? this.config.getSpecRootForFile(state.multiFileAllFiles[0]) : ''
          const baseDir = this.config.wsRoot || state.multiFileBaseDir
          const content = state.multiFileContent
          if (!content) return
          let html = state.handler.renderMarkdown(content, baseDir, null, specRoot, state.isSpecRootPreview)
          html = this.applyDiff(html, content, null, state.multiFileAllFiles, { baseDir, specRoot, includeFrontPage: state.isSpecRootPreview })
          state.panel.webview.html = html
        }
      })
    }
  }
}

module.exports = { PreviewManager, scrollSyncScript }
