/**
 * Shared comment status styling.
 * Uses colored ▊ (U+258A) bars to indicate comment state consistently
 * across inline decorations, hover, tree view, and detail view.
 */

const MARKER = '\u258A'

const STATUS = {
  unresolved: { marker: MARKER, color: '#FFA500', label: 'Open', codicon: 'comment' },
  resolved: { marker: MARKER, color: '#2dcd32', label: 'Resolved', codicon: 'chat-sparkle' },
  moved: { marker: MARKER, color: '#ff1100', label: 'Moved', codicon: 'chat-sparkle-warning' }
}

/**
 * Determine the status key for a comment.
 * @param {object} comment
 * @param {object} [opts] - { hasMoved }
 */
function getStatus(comment, opts = {}) {
  if (opts.hasMoved) return 'moved'
  return comment.resolved ? 'resolved' : 'unresolved'
}

/**
 * Returns an HTML span with the colored bar for use in webviews.
 */
function statusHtml(statusKey) {
  const s = STATUS[statusKey]
  return `<span style="color: ${s.color}; font-weight: bold;">${s.marker}</span>`
}

/**
 * Returns a codicon string for hover tooltips (monochrome).
 */
function statusHoverIcon(statusKey) {
  return `$(${STATUS[statusKey].codicon})`
}

/**
 * Returns plain text prefix for tree view labels.
 */
function statusPrefix(statusKey) {
  return STATUS[statusKey].marker
}

module.exports = { STATUS, MARKER, getStatus, statusHtml, statusHoverIcon, statusPrefix }
