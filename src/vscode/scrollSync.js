const vscode = acquireVsCodeApi();
let scrollingCount = 0;  // counter instead of boolean to avoid stuck-scroll from re-entrant events
let scrollRafPending = false;
let lastScrollTop = 0;
let updateCount = 0;
let loadingPrevious = false;
// Suppresses edge-triggered lazy-loading (loadPrevious/loadNext) until the preview has
// been positioned at its intended target after a (re)load. This prevents the load-time
// scroll event at position 0 from cascading loadPrevious calls and scrolling the preview
// many pages upward before the opened file is positioned. Resets to false on every
// reload because this whole script re-executes when webview.html is reassigned.
let initialPositioned = false;
// Set once we have asked the extension to load more following files because the target
// could not reach the top for lack of content below. Resets on reload (script re-runs).
let fillBelowRequested = false;

/**
 * Returns annotated elements for a given file (or all if sourceFile is null), in DOM order.
 */
function getAnnotatedElements(sourceFile) {
  const all = Array.from(document.querySelectorAll('[data-source-line]'));
  if (!sourceFile) return all;
  return all.filter(el => el.getAttribute('data-source-file') === sourceFile);
}

/**
 * Interpolates a pixel scroll-Y for a fractional line number using the two
 * annotated elements that bracket it. Returns null if no elements found.
 */
function lineToScrollY(fractionalLine, sourceFile) {
  const els = getAnnotatedElements(sourceFile);
  if (!els.length) return null;

  let before = null, after = null;
  for (const el of els) {
    const line = parseInt(el.getAttribute('data-source-line'));
    if (line <= fractionalLine) before = el;
    else { after = el; break; }
  }

  if (!before) return els[0].getBoundingClientRect().top + window.scrollY;

  const beforeLine = parseInt(before.getAttribute('data-source-line'));
  const afterLine = after ? parseInt(after.getAttribute('data-source-line')) : beforeLine + 1;
  const fraction = afterLine === beforeLine ? 0 : (fractionalLine - beforeLine) / (afterLine - beforeLine);
  const beforeY = before.getBoundingClientRect().top + window.scrollY;
  const afterY = after ? (after.getBoundingClientRect().top + window.scrollY) : beforeY + before.offsetHeight;
  return beforeY + fraction * (afterY - beforeY);
}

/** Scrolls the webview so that fractionalLine is at the top of the viewport. */
function scrollToLine(fractionalLine, sourceFile) {
  const y = lineToScrollY(fractionalLine, sourceFile);
  if (y !== null) {
    window.scrollTo(0, y);
    if (isClampedBelow(y)) requestFillBelow();
  }
}

/**
 * True when the page cannot scroll far enough to place pixel offset `y` at the top of
 * the viewport, i.e. there is less than one viewport of content below `y`.
 */
function isClampedBelow(y) {
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  return y > maxScroll + 2;
}

/**
 * Asks the extension to render more following files so a short target can reach the top.
 * Guarded to fire once per render (the flag resets when the webview reloads).
 */
function requestFillBelow() {
  if (fillBelowRequested) return;
  fillBelowRequested = true;
  vscode.postMessage({ type: 'ensureContentBelow' });
}

/**
 * Scrolls `el` to the top of the viewport and keeps it there while content below
 * finishes loading.
 *
 * A short section positioned at webviewReady can clamp partway down the page because
 * the subsequent files below it are still growing (their images / async layout haven't
 * settled yet), and the one-shot scroll is never re-applied once they expand. This
 * re-applies the scroll on each image load and via a few timed retries, so the target
 * ends up at the top using the real subsequent content — no blank spacer needed.
 *
 * Each re-apply is guarded: if the current scroll no longer matches the last value we
 * set, the user has scrolled manually and we stop, so we never fight the user.
 */
function scrollElementToTop(el) {
  let lastSet = -1;
  let cancelled = false;

  const apply = () => {
    if (cancelled || !el.isConnected) return;
    const cur = window.pageYOffset || document.documentElement.scrollTop;
    if (lastSet >= 0 && Math.abs(cur - lastSet) > 4) { cancelled = true; return; }
    const y = el.getBoundingClientRect().top + window.scrollY;
    scrollingCount++;
    window.scrollTo(0, y);
    lastSet = window.pageYOffset || document.documentElement.scrollTop;
    setTimeout(() => scrollingCount = Math.max(0, scrollingCount - 1), 30);
    // If the target can't reach the top for lack of content below, ask the extension
    // to load more following files (real content, not a blank spacer).
    if (isClampedBelow(y)) requestFillBelow();
  };

  apply();

  // Re-apply as images below the target finish loading (they grow the content and let
  // a short target reach the top).
  Array.from(document.images || []).forEach(img => {
    if (!img.complete) {
      img.addEventListener('load', apply, { once: true });
      img.addEventListener('error', apply, { once: true });
    }
  });
  // And a few timed retries for other late layout (fonts, reflow).
  setTimeout(apply, 150);
  setTimeout(apply, 400);
  setTimeout(apply, 800);
}

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

  // Fallback: if no positioning message (scrollToFile/scrollTo) arrives shortly after
  // load, enable edge lazy-loading anyway so scroll-driven prepend/append still works
  // for plain reloads that don't reposition (e.g. loadPrevious restore).
  setTimeout(() => { initialPositioned = true; }, 800);
});

window.addEventListener('scroll', () => {
  if (scrollingCount > 0) return;

  if (scrollRafPending) return;
  scrollRafPending = true;
  requestAnimationFrame(() => {
    scrollRafPending = false;
    if (scrollingCount > 0) return;

    const currentScrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollingDown = currentScrollTop > lastScrollTop;
    lastScrollTop = currentScrollTop;

    // Find the element at/just above the viewport top and interpolate a fractional
    // line number so the editor tracks the exact scroll position.
    // Both sourceLine and sourceFile are anchored to the same file (the midpoint file)
    // so the line sent to the editor always belongs to the file that's active.
    const elements = Array.from(document.querySelectorAll('[data-source-line]'));
    let sourceLine = 0;
    let sourceFile = null;
    let midLine = 0;

    // Determine the active file from the viewport midpoint: the file owning the
    // last annotated element whose top is at or above the midpoint.
    const midY = window.innerHeight / 5;
    let midAbove = null, midBelow = null;
    for (const el of elements) {
      const top = el.getBoundingClientRect().top;
      if (top <= midY) midAbove = el;
      else { midBelow = el; break; }
    }
    sourceFile = midAbove
      ? midAbove.getAttribute('data-source-file')
      : (elements.length ? elements[0].getAttribute('data-source-file') : null);

    // Interpolate midLine (line at the viewport midpoint, within sourceFile)
    if (midAbove && midBelow && midAbove.getAttribute('data-source-file') === midBelow.getAttribute('data-source-file')) {
      const maLine = parseInt(midAbove.getAttribute('data-source-line'));
      const mbLine = parseInt(midBelow.getAttribute('data-source-line'));
      const maY = midAbove.getBoundingClientRect().top;
      const mbY = midBelow.getBoundingClientRect().top;
      const span = mbY - maY;
      midLine = maLine + (span > 0 ? Math.min(1, Math.max(0, (midY - maY) / span)) : 0) * (mbLine - maLine);
    } else {
      midLine = midAbove ? parseInt(midAbove.getAttribute('data-source-line')) : 0;
    }

    // Interpolate sourceLine (line at the viewport top, within sourceFile only)
    // Restrict to elements of sourceFile so a file boundary at the top doesn't
    // bleed a line number from the wrong file into the editor reveal.
    if (sourceFile) {
      const fileEls = elements.filter(el => el.getAttribute('data-source-file') === sourceFile);
      let topAbove = null, topBelow = null;
      for (const el of fileEls) {
        const top = el.getBoundingClientRect().top;
        if (top <= 0) topAbove = el;
        else { topBelow = el; break; }
      }
      const topAnchor = topAbove || topBelow;
      if (topAnchor) {
        if (topAbove && topBelow) {
          const aLine = parseInt(topAbove.getAttribute('data-source-line'));
          const bLine = parseInt(topBelow.getAttribute('data-source-line'));
          const aY = topAbove.getBoundingClientRect().top;
          const bY = topBelow.getBoundingClientRect().top;
          const span = bY - aY;
          sourceLine = aLine + (span > 0 ? Math.min(1, Math.max(0, -aY / span)) : 0) * (bLine - aLine);
        } else {
          sourceLine = parseInt(topAnchor.getAttribute('data-source-line'));
        }
      }
    }

    // Find current heading hierarchy
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    let currentHeadings = [];

    for (const h of headings) {
      const rect = h.getBoundingClientRect();
      if (rect.top <= 100) {
        const level = parseInt(h.tagName.substring(1));
        const text = h.textContent.trim();
        currentHeadings = currentHeadings.filter(item => item.level < level);
        currentHeadings.push({ level, text });
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

    // Suppress ALL scroll processing until the preview has been positioned at its target.
    // This stops the transient scrolls produced by a reload (reset-to-0 on load, and the
    // prepend restore-scroll) from reaching the extension, where they would reset the
    // cross-file debounce (making the editor switch feel delayed) or schedule a switch to
    // the wrong file, and from cascading edge-loads.
    if (initialPositioned) {
      vscode.postMessage({ type: 'scroll', sourceLine, sourceFile, midLine, scrollingDown, headingPath });

      const docHeight = document.documentElement.scrollHeight;
      const viewportHeight = window.innerHeight;
      const distanceFromTop = currentScrollTop;
      const distanceFromBottom = docHeight - currentScrollTop - viewportHeight;

      if (distanceFromTop < viewportHeight * 0.5 && !loadingPrevious) {
        loadingPrevious = true;
        vscode.postMessage({ type: 'loadPrevious', oldScrollHeight: docHeight, oldScrollTop: currentScrollTop, sourceFile, sourceLine });
      } else if (distanceFromBottom < viewportHeight * 0.5) {
        vscode.postMessage({ type: 'loadNext', count: 2, sourceFile, sourceLine });
      }
    }
  });
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
    scrollingCount++;
    initialPositioned = true;
    scrollToLine(message.sourceLine, message.sourceFile);
    setTimeout(() => scrollingCount--, 100);
  } else if (message.type === 'ensureVisible') {
    initialPositioned = true;
    const targetY = lineToScrollY(message.sourceLine, message.sourceFile);
    if (targetY !== null) {
      const margin = window.innerHeight * 0.2;
      const relY = targetY - window.scrollY;
      if (relY < -margin || relY > window.innerHeight + margin) {
        scrollingCount++;
        window.scrollTo(0, targetY - window.innerHeight * 0.3);
        setTimeout(() => scrollingCount--, 100);
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
      // Position the target at the TOP of the viewport (not centered) and keep it there
      // while the subsequent files below finish loading, so a short section isn't left
      // partway down the page.
      scrollElementToTop(best);
      initialPositioned = true;
    } else {
      console.log('No match found. Looking for:', file);
      console.log('Available files:', [...new Set(candidates)]);
      // Nothing to position against; allow edge-loading to proceed.
      initialPositioned = true;
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
        // Guard with scrollingCount so this programmatic scroll isn't treated as a user
        // scroll (which would post a scroll message and reset the cross-file debounce).
        scrollingCount++;
        window.scrollTo(0, newScroll);
        setTimeout(() => { scrollingCount = Math.max(0, scrollingCount - 1); }, 50);
        // Re-enable edge-loading only AFTER the restore scroll settled, and re-enable
        // loadPrevious so continued upward scrolling still works.
        setTimeout(() => {
          initialPositioned = true;
          loadingPrevious = false;
          console.log('[PREPEND] Re-enabled loadPrevious trigger');
        }, 200);
      } else {
        initialPositioned = true;
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
