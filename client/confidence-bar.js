/**
 * DOE Confidence Bar — Shared BuildOS Component (Vanilla JS)
 * Extracted from Spark reference implementation.
 *
 * Renders confidence visualizations as HTML strings for use in
 * template literals across all vanilla-HTML trade packages.
 */

/**
 * Render a score-mode confidence bar.
 * @param {{ label?: string, confidence: number }} opts
 *   confidence is 0–1 (fractional)
 * @returns {string} HTML string
 */
export function renderConfidenceBar({ label, confidence }) {
  const pct = Math.round((confidence ?? 0) * 100);
  const tier = pct >= 70 ? 'high' : pct >= 40 ? 'medium' : 'low';

  return `
    <div class="confidence-bar-wrapper">
      ${label ? `<span class="confidence-bar-label">${esc(label)}</span>` : ''}
      <div class="confidence-bar-track">
        <div class="confidence-bar-fill confidence-bar-fill--${tier}" style="width: ${pct}%"></div>
      </div>
      <span class="confidence-bar-pct confidence-bar-pct--${tier}">${pct}%</span>
    </div>`;
}

/**
 * Render a range-mode confidence bar (low/best/high envelope).
 * @param {{ label?: string, low: number, best: number, high: number, unit?: string, confidence?: number }} opts
 * @returns {string} HTML string
 */
export function renderConfidenceRange({ label, low, best, high, unit = '', confidence }) {
  const padding = (high - low) * 0.15 || 1;
  const min = low - padding;
  const max = high + padding;
  const span = max - min || 1;

  const lowPct = ((low - min) / span) * 100;
  const bestPct = ((best - min) / span) * 100;
  const highPct = ((high - min) / span) * 100;

  const pct = confidence != null ? Math.round(confidence * 100) : null;
  const tier = pct != null ? (pct >= 70 ? 'high' : pct >= 40 ? 'medium' : 'low') : 'medium';

  const fmt = (v) => typeof v === 'number' ? v.toLocaleString() : v;

  return `
    <div class="confidence-range-wrapper">
      ${label ? `
        <div class="confidence-range-header">
          <span class="confidence-range-label">${esc(label)}</span>
          ${pct != null ? `<span class="confidence-bar-pct confidence-bar-pct--${tier}">${pct}% conf</span>` : ''}
        </div>
      ` : ''}
      <div class="confidence-range-track">
        <div class="confidence-range-band confidence-range-band--${tier}" style="left: ${lowPct}%; width: ${highPct - lowPct}%"></div>
        <div class="confidence-range-marker confidence-range-marker--best" style="left: ${bestPct}%"></div>
        <div class="confidence-range-marker confidence-range-marker--bound" style="left: ${lowPct}%"></div>
        <div class="confidence-range-marker confidence-range-marker--bound" style="left: ${highPct}%"></div>
      </div>
      <div class="confidence-range-values">
        <span class="confidence-range-val confidence-range-val--low">${fmt(low)}${unit ? ` ${unit}` : ''}</span>
        <span class="confidence-range-val confidence-range-val--best"><strong>${fmt(best)}</strong>${unit ? ` ${unit}` : ''}</span>
        <span class="confidence-range-val confidence-range-val--high">${fmt(high)}${unit ? ` ${unit}` : ''}</span>
      </div>
    </div>`;
}

/**
 * Render a confidence badge (inline pill).
 * @param {number} confidence — 0–1 fractional
 * @returns {string} HTML string
 */
export function renderConfidenceBadge(confidence) {
  const pct = Math.round((confidence ?? 0) * 100);
  const tier = pct >= 70 ? 'high' : pct >= 40 ? 'medium' : 'low';
  return `<span class="confidence-badge confidence-badge-${tier}">${pct}%</span>`;
}

/**
 * Render a full DOE Confidence Analysis section.
 * @param {{ overallConfidence?: number, items?: Array<{ name: string, confidence: number }> }} opts
 * @returns {string} HTML string — empty string if no data
 */
export function renderDoeSection({ overallConfidence, items }) {
  if (overallConfidence == null && (!items || items.length === 0)) return '';

  let html = `<div class="doe-confidence-section">
    <h4>🎯 DOE Confidence Analysis</h4>`;

  if (overallConfidence != null) {
    html += `<div class="doe-overall-bar">${renderConfidenceBar({ label: 'Overall', confidence: overallConfidence })}</div>`;
  }

  if (items && items.length > 0) {
    html += `<div class="doe-material-bars">`;
    for (const item of items) {
      const label = item.name?.length > 20 ? item.name.slice(0, 18) + '…' : item.name;
      html += renderConfidenceBar({ label, confidence: item.confidence });
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

/** Simple HTML-escape helper */
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
