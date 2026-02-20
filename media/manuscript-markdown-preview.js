// Manuscript Markdown Preview — Comment Tooltip Script
// Injected via markdown.previewScripts to show comment tooltips on hover

(function () {
  'use strict';

  // Create the tooltip element
  const tooltip = document.createElement('div');
  tooltip.className = 'manuscript-markdown-tooltip';
  tooltip.style.cssText = [
    'display: none',
    'position: fixed',
    'z-index: 10000',
    'max-width: 400px',
    'padding: 6px 10px',
    'border-radius: 4px',
    'font-size: 13px',
    'line-height: 1.4',
    'white-space: pre-wrap',
    'word-wrap: break-word',
    'pointer-events: none',
    'background: var(--vscode-editorHoverWidget-background, #2d2d30)',
    'color: var(--vscode-editorHoverWidget-foreground, #cccccc)',
    'border: 1px solid var(--vscode-editorHoverWidget-border, #454545)',
    'box-shadow: 0 2px 8px rgba(0,0,0,0.2)',
  ].join(';');
  if (document.body) {
    document.body.appendChild(tooltip);
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      document.body.appendChild(tooltip);
    });
  }

  /** Collect data-comment values from the element and all ancestors (innermost first) */
  function collectComments(el) {
    var comments = [];
    var node = el;
    while (node && node !== document.body) {
      var comment = node.getAttribute && node.getAttribute('data-comment');
      if (comment) {
        comments.push(comment);
      }
      node = node.parentElement;
    }
    return comments;
  }

  // Use event delegation on the document for efficiency
  document.addEventListener('mouseover', function (e) {
    // Walk up from target to find the nearest element with data-comment
    var target = e.target;
    while (target && target !== document.body) {
      if (target.getAttribute && target.getAttribute('data-comment')) {
        break;
      }
      target = target.parentElement;
    }
    if (!target || target === document.body) return;

    var comments = collectComments(target);
    if (comments.length === 0) return;

    tooltip.textContent = comments.join('\n\u2500\u2500\u2500\n');
    tooltip.style.display = 'block';

    // Position near the element
    var rect = target.getBoundingClientRect();
    var tooltipRect = tooltip.getBoundingClientRect();
    var left = rect.left;
    var top = rect.bottom + 4;

    // Keep within viewport
    if (left + tooltipRect.width > window.innerWidth) {
      left = window.innerWidth - tooltipRect.width - 8;
    }
    if (left < 4) left = 4;
    if (top + tooltipRect.height > window.innerHeight) {
      top = rect.top - tooltipRect.height - 4;
    }

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  });

  document.addEventListener('mouseout', function (e) {
    // Hide tooltip when leaving a data-comment element
    var related = e.relatedTarget;
    // Check if we're still within a data-comment element
    while (related && related !== document.body) {
      if (related.getAttribute && related.getAttribute('data-comment')) {
        return; // Still inside a commented element
      }
      related = related.parentElement;
    }
    tooltip.style.display = 'none';
  });
})();
