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
      // console.log('[LOAD #' + updateCount + '] scrollY=' + scrollY + ', docHeight=' + docHeight);
      vscode.postMessage({ type: 'webviewReady' });
    }).catch(() => {
      const scrollY = window.pageYOffset || document.documentElement.scrollTop;
      const docHeight = document.documentElement.scrollHeight;
      // console.log('[LOAD #' + updateCount + '] scrollY=' + scrollY + ', docHeight=' + docHeight);
      vscode.postMessage({ type: 'webviewReady' });
    });
  } else {
    const scrollY = window.pageYOffset || document.documentElement.scrollTop;
    const docHeight = document.documentElement.scrollHeight;
    // console.log('[LOAD #' + updateCount + '] scrollY=' + scrollY + ', docHeight=' + docHeight);
    vscode.postMessage({ type: 'webviewReady' });
  }
});

window.addEventListener('scroll', () => {
  if (isScrolling) return;
  
  const scrollY = window.pageYOffset || document.documentElement.scrollTop;
  // console.log('[SCROLL] scrollY=' + scrollY);

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
  while (el && !el.getAttribute('data-source-file')) {
    el = el.parentElement;
  }
  if (!el) return;
  const sourceLine = parseInt(el.getAttribute('data-source-line')) || 0;
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
