/**
 * @module brick-exchange/hub-and-mcp
 * @description Self-contained Reuse & Grants Web Console, HTTP Exchange Hub Server,
 * and 4-boolean annotated Stdio MCP server (`INV-LEGO-35`, `INV-STACK-03`).
 *
 * Extends multi-team validated code-sharing concepts from `0xANUSHKA/common-ground-8090`
 * (EVOLVE 8090 Hackathon, MIT License, Copyright (c) 2026 Anushka Jogalekar and
 * Common Ground contributors) onto `@krusch/toolkit` canonical HTTP, Webhook, and MCP bricks.
 */

import { createApiServer, okEnvelope, errorEnvelope } from '../http.js';
import {
    defineMcpTool,
    createMcpServer,
    okMcpResult,
    errorMcpResult,
} from '../mcp-server.js';
import { verifyBearerToken } from '../webhooks.js';
import { runBrickVerificationGates } from './sandbox.js';
import {
    sealVerifiedBrick,
    verifyBrickBundle,
    generateBrickSigningKeyPair,
} from './seal-and-policy.js';
import {
    tryBrickLocally,
    adoptBrickIntoRepo,
    auditRepoBrickLocks,
} from './store-and-matcher.js';
import {
    analyzeBrickBlastRadius,
    planAgentFanOut,
    verifyTwoHopBlastRadius,
} from './blast-radius.js';

const HUB_TOOL = 'brick-exchange.hub';

/**
 * Escape server-rendered text before interpolating into static HTML attributes or elements.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Sanitize an untrusted HTTP header or query identifier string.
 *
 * @param {unknown} rawValue
 * @returns {string}
 */
function cleanIdentifier(rawValue) {
    if (Array.isArray(rawValue)) {
        return cleanIdentifier(rawValue[0]);
    }
    if (typeof rawValue !== 'string') return '';
    let out = '';
    for (let i = 0; i < rawValue.length; i++) {
        const code = rawValue.charCodeAt(i);
        if (code > 31 && code !== 127) {
            out += rawValue[i];
        }
    }
    return out.trim();
}

/**
 * Normalize `authTokens` config (`Map`, `Array`, or plain `Record<token, memberId>`) into
 * deterministic `[expectedToken, mappedMemberId | null]` entries.
 *
 * @param {Map<string, string|boolean>|string[]|Record<string, string|boolean>|null} authTokens
 * @returns {Array<[string, string|null]>}
 */
function normalizeAuthTokens(authTokens) {
    if (!authTokens) return [];
    const entries = [];

    if (authTokens instanceof Map) {
        for (const [token, member] of authTokens.entries()) {
            const cleanTok = typeof token === 'string' ? token.trim() : '';
            if (!cleanTok) continue;
            const mapped =
                typeof member === 'string' && member.trim().length > 0 && member.trim() !== '*'
                    ? member.trim()
                    : null;
            entries.push([cleanTok, mapped]);
        }
        return entries;
    }

    if (Array.isArray(authTokens)) {
        for (const token of authTokens) {
            const cleanTok = typeof token === 'string' ? token.trim() : '';
            if (cleanTok) entries.push([cleanTok, null]);
        }
        return entries;
    }

    if (typeof authTokens === 'object') {
        for (const [token, member] of Object.entries(authTokens)) {
            const cleanTok = typeof token === 'string' ? token.trim() : '';
            if (!cleanTok) continue;
            const mapped =
                typeof member === 'string' && member.trim().length > 0 && member.trim() !== '*'
                    ? member.trim()
                    : null;
            entries.push([cleanTok, mapped]);
        }
    }

    return entries;
}

/**
 * Map a failed store/policy envelope to an appropriate HTTP status code (`403` vs `400`).
 *
 * @param {object} resEnvelope
 * @param {number} [fallbackStatus=400]
 * @returns {number}
 */
function statusForStoreError(resEnvelope, fallbackStatus = 400) {
    const code = String(resEnvelope?.error?.code || '');
    if (
        /(?:DENIED|FORBIDDEN|UNAUTHORIZED|NOT_AUTHORIZED|FEDERATION_DISABLED|MUTED|MODE_OFF|UNTRUSTED_SIGNING_KEY|REVOKED|EXPIRED)/i.test(
            code
        )
    ) {
        return 403;
    }
    return fallbackStatus;
}

/**
 * Render a self-contained single-page HTML5 Reuse & Grants Console with zero external CDN
 * assets and strict `textContent`-only DOM updates (zero XSS sinks).
 *
 * @param {object} [options={}]
 * @param {string} [options.title='Brick Exchange Console']
 * @returns {string}
 */
export function renderBrickExchangeConsoleHtml({ title = 'Brick Exchange Console' } = {}) {
    const safeTitle = escapeHtmlText(title || 'Brick Exchange Console');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
  :root {
    --bg: #0b1120;
    --panel: #111827;
    --panel-alt: #1e293b;
    --border: #334155;
    --text: #f8fafc;
    --muted: #94a3b8;
    --emerald: #10b981;
    --emerald-bg: rgba(16, 185, 129, 0.14);
    --amber: #f59e0b;
    --amber-bg: rgba(245, 158, 11, 0.15);
    --rose: #f43f5e;
    --rose-bg: rgba(244, 63, 94, 0.15);
    --sky: #38bdf8;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    line-height: 1.5;
  }
  .shell {
    max-width: 1320px;
    margin: 0 auto;
    padding: 24px 20px 56px;
  }
  .topbar {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    padding-bottom: 18px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 20px;
  }
  .brand h1 {
    margin: 0;
    font-size: 1.35rem;
    letter-spacing: -0.02em;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .brand p {
    margin: 4px 0 0;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  input, select, button {
    font-family: inherit;
    font-size: 0.85rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel);
    color: var(--text);
    padding: 7px 10px;
  }
  input:focus, select:focus, button:focus {
    outline: 2px solid var(--sky);
    outline-offset: 1px;
  }
  button {
    cursor: pointer;
    font-weight: 600;
    background: var(--panel-alt);
    transition: background 120ms ease, border-color 120ms ease;
  }
  button:hover {
    border-color: var(--sky);
  }
  .btn-emerald {
    background: var(--emerald-bg);
    color: var(--emerald);
    border-color: rgba(16, 185, 129, 0.45);
  }
  .btn-danger {
    background: var(--rose-bg);
    color: var(--rose);
    border-color: rgba(244, 63, 94, 0.45);
    padding: 4px 10px;
    font-size: 0.78rem;
  }
  .kpi-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 12px;
    margin-bottom: 22px;
  }
  .kpi-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
  }
  .kpi-label {
    font-size: 0.76rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .kpi-value {
    margin-top: 6px;
    font-size: 1.55rem;
    font-weight: 700;
    font-family: var(--mono);
  }
  .kpi-sub {
    margin-top: 4px;
    font-size: 0.78rem;
    color: var(--muted);
    font-family: var(--mono);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 0.74rem;
    font-weight: 600;
    font-family: var(--mono);
  }
  .badge-verified {
    background: var(--emerald-bg);
    color: var(--emerald);
    border: 1px solid rgba(16, 185, 129, 0.4);
  }
  .badge-amber {
    background: var(--amber-bg);
    color: var(--amber);
    border: 1px solid rgba(245, 158, 11, 0.4);
  }
  .badge-danger {
    background: var(--rose-bg);
    color: var(--rose);
    border: 1px solid rgba(244, 63, 94, 0.4);
  }
  .mono-tag {
    font-family: var(--mono);
    font-size: 0.77rem;
    background: #0f172a;
    border: 1px solid var(--border);
    padding: 2px 6px;
    border-radius: 4px;
    color: #cbd5e1;
  }
  .grid-main {
    display: grid;
    grid-template-columns: 1.65fr 1fr;
    gap: 18px;
  }
  @media (max-width: 980px) {
    .grid-main { grid-template-columns: 1fr; }
  }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 18px;
  }
  .panel-header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }
  .panel-header h2 {
    margin: 0;
    font-size: 1rem;
    letter-spacing: -0.01em;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.84rem;
  }
  th, td {
    text-align: left;
    padding: 10px 8px;
    border-bottom: 1px solid rgba(51, 65, 85, 0.65);
    vertical-align: top;
  }
  th {
    font-size: 0.74rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .empty-state {
    padding: 18px 12px;
    color: var(--muted);
    font-size: 0.85rem;
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: 6px;
  }
  .grant-form {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 14px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
  }
  .grant-form .full {
    grid-column: 1 / -1;
  }
  .grant-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: #0f172a;
    margin-bottom: 8px;
  }
  .status-banner {
    margin-bottom: 14px;
    padding: 9px 12px;
    border-radius: 6px;
    font-size: 0.83rem;
    border: 1px solid var(--border);
    background: var(--panel-alt);
    display: none;
  }
  .audit-box {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    background: #0f172a;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
  }
</style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <h1>
          <span>${safeTitle}</span>
          <span class="badge badge-verified">Ed25519 4-Gate Seal</span>
        </h1>
        <p>Zero-Ambient-I/O Verified Brick Exchange &middot; Pre-Discovery Scoped Grants &middot; Hash-Chained Audit Ledger</p>
      </div>
      <div class="controls">
        <select id="viewer-select" aria-label="Select Viewer Member">
          <option value="">Select member...</option>
        </select>
        <input id="viewer-input" type="text" placeholder="X-Brick-Viewer ID" aria-label="X-Brick-Viewer ID" />
        <input id="bearer-input" type="password" placeholder="Bearer token (optional)" aria-label="Bearer token" />
        <button id="refresh-btn" type="button" class="btn-emerald">Refresh Console</button>
      </div>
    </header>

    <div id="status-banner" class="status-banner" role="status"></div>

    <section class="kpi-strip" aria-label="Exchange Portfolio KPIs">
      <div class="kpi-card">
        <div class="kpi-label">Sealed Bricks</div>
        <div id="kpi-sealed" class="kpi-value">0</div>
        <div class="kpi-sub">4/4 Verification Gates</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Verified Reuses</div>
        <div id="kpi-reuses" class="kpi-value">0</div>
        <div class="kpi-sub">Local Sandbox Verified</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Engineering Hours Saved</div>
        <div id="kpi-hours" class="kpi-value">0h</div>
        <div class="kpi-sub">Attributed Adoptions</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Participating Orgs</div>
        <div id="kpi-orgs" class="kpi-value">0</div>
        <div id="kpi-members" class="kpi-sub">0 registered members</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Audit Chain Status</div>
        <div id="kpi-audit" class="kpi-value">CHECKING</div>
        <div id="kpi-audit-seq" class="kpi-sub">seq: 0</div>
      </div>
    </section>

    <div class="grid-main">
      <div>
        <section class="panel" aria-label="Visible Sealed Bricks">
          <div class="panel-header">
            <h2>Visible Sealed Bricks</h2>
            <div class="controls">
              <input id="brick-query" type="search" placeholder="Filter visible bricks..." aria-label="Filter visible bricks" />
              <button id="search-bricks-btn" type="button">Filter</button>
            </div>
          </div>
          <div id="bricks-container">
            <div class="empty-state">Enter or select an active X-Brick-Viewer ID to inspect authorized bricks.</div>
          </div>
        </section>

        <section class="panel" aria-label="Tamper-Evident Audit Ledger Tail">
          <div class="panel-header">
            <h2>Audit Ledger Tail</h2>
            <button id="verify-audit-btn" type="button" class="btn-emerald">Verify Chain Now</button>
          </div>
          <div class="audit-box">
            <div>
              <div class="kpi-label">Integrity Verdict</div>
              <div id="audit-verdict" class="mono-tag">PENDING</div>
            </div>
            <div>
              <div class="kpi-label">Verified Sequence</div>
              <div id="audit-seq" class="mono-tag">0</div>
            </div>
            <div>
              <div class="kpi-label">Head Hash Prefix</div>
              <div id="audit-head" class="mono-tag">-</div>
            </div>
            <div>
              <div class="kpi-label">Tail Hash Prefix</div>
              <div id="audit-tail" class="mono-tag">-</div>
            </div>
          </div>
        </section>
      </div>

      <div>
        <section class="panel" aria-label="Active Grants and Revocation">
          <div class="panel-header">
            <h2>Active Grants &amp; Revocation</h2>
            <span class="badge badge-amber">reshare: false</span>
          </div>
          <form id="grant-form" class="grant-form">
            <input id="grant-brick-id" type="text" placeholder="Brick ID (e.g. safe-cursor)" required />
            <input id="grant-source-hash" type="text" placeholder="sourceHash (64-hex)" required />
            <input id="grant-recipients" class="full" type="text" placeholder="Recipient IDs (comma-separated)" required />
            <input id="grant-expires" type="text" placeholder="ISO ExpiresAt (default +24h)" />
            <button type="submit" class="btn-emerald">Issue Cross-Org Grant</button>
          </form>
          <div id="grants-container">
            <div class="empty-state">No grants issued yet.</div>
          </div>
        </section>
      </div>
    </div>
  </div>

  <script>
    (function () {
      const viewerSelect = document.getElementById('viewer-select');
      const viewerInput = document.getElementById('viewer-input');
      const bearerInput = document.getElementById('bearer-input');
      const brickQuery = document.getElementById('brick-query');
      const statusBanner = document.getElementById('status-banner');
      const bricksContainer = document.getElementById('bricks-container');
      const grantsContainer = document.getElementById('grants-container');

      function setBanner(message, isError) {
        if (!message) {
          statusBanner.style.display = 'none';
          statusBanner.textContent = '';
          return;
        }
        statusBanner.style.display = 'block';
        statusBanner.style.borderColor = isError ? 'rgba(244, 63, 94, 0.55)' : 'rgba(16, 185, 129, 0.55)';
        statusBanner.textContent = String(message);
      }

      function makeEl(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined && text !== null) {
          el.textContent = String(text);
        }
        return el;
      }

      function currentViewer() {
        return (viewerInput.value || viewerSelect.value || '').trim();
      }

      function buildHeaders(includeJson) {
        const headers = {};
        if (includeJson) headers['Content-Type'] = 'application/json';
        const viewer = currentViewer();
        if (viewer) headers['X-Brick-Viewer'] = viewer;
        const token = (bearerInput.value || '').trim();
        if (token) headers['Authorization'] = 'Bearer ' + token;
        return headers;
      }

      async function apiFetch(path, options) {
        const opts = options || {};
        const resp = await fetch(path, {
          method: opts.method || 'GET',
          headers: buildHeaders(Boolean(opts.body)),
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        const payload = await resp.json().catch(function () {
          return { ok: false, summary: 'Invalid JSON response' };
        });
        return { status: resp.status, payload: payload };
      }

      function renderAuditTail(auditRes) {
        const ok = Boolean(auditRes && auditRes.ok);
        const data = (auditRes && auditRes.data) || {};
        const seqCount = Number(data.verifiedCount || 0);
        const kpiAudit = document.getElementById('kpi-audit');
        const kpiAuditSeq = document.getElementById('kpi-audit-seq');
        kpiAudit.textContent = ok ? 'VERIFIED' : 'TAMPERED';
        kpiAudit.style.color = ok ? 'var(--emerald)' : 'var(--rose)';
        kpiAuditSeq.textContent = 'seq: ' + String(seqCount);

        const verdictEl = document.getElementById('audit-verdict');
        verdictEl.textContent = ok ? 'VERIFIED' : 'INVALID';
        verdictEl.className = ok ? 'badge badge-verified' : 'badge badge-danger';
        document.getElementById('audit-seq').textContent = String(seqCount);
        document.getElementById('audit-head').textContent = data.headHash ? String(data.headHash).slice(0, 14) : '-';
        document.getElementById('audit-tail').textContent = data.tailHash ? String(data.tailHash).slice(0, 14) : '-';
      }

      async function loadStatsAndMembers() {
        const [statsResp, membersResp, auditResp] = await Promise.all([
          apiFetch('/api/stats'),
          apiFetch('/api/members'),
          apiFetch('/api/audit/verify'),
        ]);

        if (statsResp.payload && statsResp.payload.ok) {
          const st = statsResp.payload.data || {};
          document.getElementById('kpi-sealed').textContent = String(st.sealedBrickCount || 0);
          document.getElementById('kpi-reuses').textContent = String(st.adoptionCount || 0);
          document.getElementById('kpi-hours').textContent = String(st.estimatedHoursSavedTotal || 0) + 'h';
          document.getElementById('kpi-orgs').textContent = String(st.liveOrgCount ?? st.orgCount ?? 0);
          document.getElementById('kpi-members').textContent = String(st.memberCount || 0) + ' registered members';
        }

        if (membersResp.payload && membersResp.payload.ok) {
          const members = (membersResp.payload.data && membersResp.payload.data.members) || [];
          const prev = currentViewer();
          const placeholder = makeEl('option', '', 'Select member...');
          placeholder.value = '';
          const options = [placeholder];
          for (let i = 0; i < members.length; i++) {
            const m = members[i];
            const opt = makeEl('option', '', m.id + ' (' + m.orgId + ')');
            opt.value = m.id;
            options.push(opt);
          }
          viewerSelect.replaceChildren.apply(viewerSelect, options);
          if (!prev && members.length > 0) {
            viewerSelect.value = members[0].id;
            viewerInput.value = members[0].id;
          } else if (prev) {
            viewerSelect.value = prev;
          }
        }

        renderAuditTail(auditResp.payload);
      }

      async function loadVisibleBricks() {
        const viewer = currentViewer();
        if (!viewer) {
          bricksContainer.replaceChildren(
            makeEl('div', 'empty-state', 'Select or enter an X-Brick-Viewer ID to view authorized bricks.')
          );
          return;
        }

        const q = (brickQuery.value || '').trim();
        const url = '/api/bricks?viewerId=' + encodeURIComponent(viewer) + (q ? '&q=' + encodeURIComponent(q) : '');
        const resp = await apiFetch(url);
        if (!resp.payload || !resp.payload.ok) {
          const msg = (resp.payload && resp.payload.error && resp.payload.error.message) || 'Unable to load bricks';
          bricksContainer.replaceChildren(makeEl('div', 'empty-state', msg));
          return;
        }

        const bricks = (resp.payload.data && resp.payload.data.bricks) || [];
        if (bricks.length === 0) {
          bricksContainer.replaceChildren(
            makeEl('div', 'empty-state', '0 visible sealed bricks for viewer "' + viewer + '".')
          );
          return;
        }

        const table = makeEl('table');
        const thead = makeEl('thead');
        const headRow = makeEl('tr');
        const cols = ['Brick', 'Org', '4-Gate & Faults', 'Lineage & Key', 'Reuses', 'Hours Saved'];
        for (let i = 0; i < cols.length; i++) {
          headRow.appendChild(makeEl('th', '', cols[i]));
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = makeEl('tbody');
        for (let i = 0; i < bricks.length; i++) {
          const item = bricks[i];
          const b = item.bundle || item;
          const tr = makeEl('tr');

          const tdId = makeEl('td');
          const idStrong = makeEl('div', 'mono-tag', b.brickId || '-');
          const sumDiv = makeEl('div', '', b.summary || b.name || '');
          sumDiv.style.color = 'var(--muted)';
          sumDiv.style.fontSize = '0.78rem';
          sumDiv.style.marginTop = '4px';
          tdId.appendChild(idStrong);
          tdId.appendChild(sumDiv);

          const tdOrg = makeEl('td', '', (b.orgId || '-') + ' / ' + (b.authorId || '-'));

          const checksArr = Array.isArray(b.checks) ? b.checks : [];
          const faultCount =
            (b.lineage && typeof b.lineage.faultChallengeCount === 'number'
              ? b.lineage.faultChallengeCount
              : checksArr.filter(function (c) { return c && c.kind === 'fault'; }).length) || 0;
          const tdGates = makeEl('td');
          const sealBadge = makeEl('span', 'badge badge-verified', '4/4 GATES (' + String(checksArr.length) + ' checks)');
          const faultBadge = makeEl('span', 'badge badge-amber', String(faultCount) + ' fault challenge');
          faultBadge.style.marginLeft = '6px';
          tdGates.appendChild(sealBadge);
          tdGates.appendChild(faultBadge);

          const srcHash = (b.lineage && b.lineage.sourceHash) || b.sourceHash || '';
          const keyId = (b.attestation && b.attestation.keyId) || b.keyId || '-';
          const tdLineage = makeEl('td');
          const shaTag = makeEl('span', 'mono-tag', 'sha256:' + String(srcHash).slice(0, 12));
          const keyTag = makeEl('span', 'mono-tag', String(keyId));
          keyTag.style.marginLeft = '6px';
          tdLineage.appendChild(shaTag);
          tdLineage.appendChild(keyTag);
          tdLineage.style.cursor = 'pointer';
          tdLineage.title = 'Click to prefill grant form';
          tdLineage.addEventListener('click', function () {
            document.getElementById('grant-brick-id').value = b.brickId || '';
            document.getElementById('grant-source-hash').value = srcHash;
          });

          const reuses = item.adoptionCount ?? b.adoptionCount ?? 0;
          const hoursPerUse = Number(b.estimatedHoursSaved || 0);
          const tdReuses = makeEl('td', '', String(reuses));
          const tdHours = makeEl('td', '', String(hoursPerUse) + 'h / use');

          tr.appendChild(tdId);
          tr.appendChild(tdOrg);
          tr.appendChild(tdGates);
          tr.appendChild(tdLineage);
          tr.appendChild(tdReuses);
          tr.appendChild(tdHours);
          tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        bricksContainer.replaceChildren(table);
      }

      async function loadGrants() {
        const resp = await apiFetch('/api/grants');
        if (!resp.payload || !resp.payload.ok) {
          grantsContainer.replaceChildren(makeEl('div', 'empty-state', 'Unable to load grants.'));
          return;
        }
        const grants = (resp.payload.data && resp.payload.data.grants) || [];
        if (grants.length === 0) {
          grantsContainer.replaceChildren(makeEl('div', 'empty-state', 'No cross-org grants recorded.'));
          return;
        }

        const nodes = [];
        for (let i = 0; i < grants.length; i++) {
          const g = grants[i];
          const row = makeEl('div', 'grant-item');
          const info = makeEl('div');
          const titleLine = makeEl('div');
          titleLine.appendChild(makeEl('span', 'mono-tag', g.id));
          const brickSpan = makeEl('span', 'mono-tag', g.brickId + '@' + String(g.sourceHash || '').slice(0, 8));
          brickSpan.style.marginLeft = '6px';
          titleLine.appendChild(brickSpan);

          const metaLine = makeEl('div', '', 'To: ' + (Array.isArray(g.recipients) ? g.recipients.join(', ') : '-'));
          metaLine.style.fontSize = '0.78rem';
          metaLine.style.color = 'var(--muted)';
          metaLine.style.marginTop = '4px';

          const isRevoked = Boolean(g.revoked);
          const isExpired = Number.isFinite(Date.parse(g.expiresAt)) && Date.parse(g.expiresAt) <= Date.now();
          const pill = makeEl(
            'span',
            isRevoked ? 'badge badge-danger' : 'badge badge-amber',
            isRevoked ? 'REVOKED' : isExpired ? 'EXPIRED ' + g.expiresAt : 'EXPIRES ' + g.expiresAt
          );
          pill.style.marginTop = '6px';

          info.appendChild(titleLine);
          info.appendChild(metaLine);
          info.appendChild(pill);
          row.appendChild(info);

          if (!isRevoked) {
            const revokeBtn = makeEl('button', 'btn-danger', 'Revoke');
            revokeBtn.type = 'button';
            revokeBtn.addEventListener('click', async function () {
              const actorId = currentViewer() || g.issuerId;
              const revResp = await apiFetch('/api/revoke', {
                method: 'POST',
                body: { actorId: actorId, grantId: g.id },
              });
              if (revResp.payload && revResp.payload.ok) {
                setBanner('Revoked grant ' + g.id + ' - cross-org access blocked.', false);
                await refreshAll();
              } else {
                const errMsg = (revResp.payload && revResp.payload.error && revResp.payload.error.message) || 'Revoke failed';
                setBanner(errMsg, true);
              }
            });
            row.appendChild(revokeBtn);
          }

          nodes.push(row);
        }
        grantsContainer.replaceChildren.apply(grantsContainer, nodes);
      }

      async function refreshAll() {
        await loadStatsAndMembers();
        await Promise.all([loadVisibleBricks(), loadGrants()]);
      }

      viewerSelect.addEventListener('change', function () {
        viewerInput.value = viewerSelect.value;
        loadVisibleBricks();
      });

      document.getElementById('refresh-btn').addEventListener('click', function () {
        setBanner('', false);
        refreshAll();
      });

      document.getElementById('search-bricks-btn').addEventListener('click', function () {
        loadVisibleBricks();
      });

      document.getElementById('verify-audit-btn').addEventListener('click', async function () {
        const res = await apiFetch('/api/audit/verify');
        renderAuditTail(res.payload);
        setBanner(
          res.payload && res.payload.ok
            ? 'Audit hash chain verified cleanly.'
            : 'Audit hash chain verification reported an error!',
          !(res.payload && res.payload.ok)
        );
      });

      document.getElementById('grant-form').addEventListener('submit', async function (ev) {
        ev.preventDefault();
        const issuerId = currentViewer();
        const brickId = document.getElementById('grant-brick-id').value.trim();
        const sourceHash = document.getElementById('grant-source-hash').value.trim();
        const recipients = document
          .getElementById('grant-recipients')
          .value.split(',')
          .map(function (s) { return s.trim(); })
          .filter(Boolean);
        const rawExp = document.getElementById('grant-expires').value.trim();
        const expiresAt = rawExp || new Date(Date.now() + 86400000).toISOString();

        const resp = await apiFetch('/api/grants', {
          method: 'POST',
          body: {
            issuerId: issuerId,
            brickId: brickId,
            sourceHash: sourceHash,
            scope: 'federated',
            recipients: recipients,
            expiresAt: expiresAt,
          },
        });
        if (resp.payload && resp.payload.ok) {
          setBanner('Issued scoped cross-org grant for ' + brickId + '.', false);
          await refreshAll();
        } else {
          const msg = (resp.payload && resp.payload.error && resp.payload.error.message) || 'Grant creation failed';
          setBanner(msg, true);
        }
      });

      refreshAll();
    })();
  </script>
</body>
</html>`;
}

/**
 * Create the Brick Exchange HTTP Hub & Reuse Console server on top of `@krusch/toolkit/http`.
 *
 * @param {object} [options={}]
 * @param {object} options.store - Initialized `BrickExchangeStore` instance
 * @param {string} [options.serviceName='krusch-brick-exchange-hub']
 * @param {string} [options.version='1.0.0']
 * @param {Map<string, string|boolean>|string[]|Record<string, string|boolean>|null} [options.authTokens=null]
 * @param {string[]} [options.corsOrigins=['*']]
 * @param {object|null} [options.logger=null]
 * @returns {import('node:http').Server}
 */
export function createBrickExchangeServer({
    store,
    serviceName = 'krusch-brick-exchange-hub',
    version = '1.0.0',
    authTokens = null,
    corsOrigins = ['*'],
    logger = null,
} = {}) {
    if (!store || typeof store !== 'object') {
        throw new TypeError('createBrickExchangeServer requires a valid store instance');
    }

    const tokenEntries = normalizeAuthTokens(authTokens);
    const authRequired = tokenEntries.length > 0;

    /**
     * Authenticate incoming API request (when `authTokens` is configured) and resolve `viewerId`.
     *
     * @param {object} ctx
     * @returns {{ ok: boolean, viewerId: string }}
     */
    function authenticateAndResolveViewer(ctx) {
        const headerViewer = cleanIdentifier(ctx.req?.headers?.['x-brick-viewer']);
        const queryViewer = cleanIdentifier(ctx.query?.viewerId);

        if (!authRequired) {
            return {
                ok: true,
                viewerId: headerViewer || queryViewer,
            };
        }

        const rawAuth = Array.isArray(ctx.req?.headers?.authorization)
            ? ctx.req.headers.authorization[0]
            : ctx.req?.headers?.authorization;
        const authHeader = typeof rawAuth === 'string' ? rawAuth : '';

        let matched = false;
        let mappedMemberId = null;
        for (const [expectedSecret, candidateMemberId] of tokenEntries) {
            const check = verifyBearerToken(authHeader, expectedSecret, { tool: HUB_TOOL });
            if (check.ok) {
                matched = true;
                if (candidateMemberId && mappedMemberId === null) {
                    mappedMemberId = candidateMemberId;
                }
            }
        }

        if (!matched) {
            ctx.sendJson(
                401,
                errorEnvelope('UNAUTHORIZED', 'Valid Bearer authentication token is required', null, HUB_TOOL)
            );
            return { ok: false, viewerId: '' };
        }

        return {
            ok: true,
            viewerId: mappedMemberId || headerViewer || queryViewer,
        };
    }

    const routes = {
        'GET /': (ctx) => {
            const html = renderBrickExchangeConsoleHtml();
            const headers = {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': String(Buffer.byteLength(html, 'utf8')),
                'Cache-Control': 'no-store',
                'Content-Security-Policy':
                    "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
            };
            ctx.res.writeHead(200, headers);
            ctx.res.end(html);
        },

        'GET /api/stats': (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            return store.getPortfolioStats();
        },

        'GET /api/orgs': (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            return okEnvelope(HUB_TOOL, 'Listed orgs', { orgs: store.listOrgs() });
        },

        'POST /api/orgs': (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            const res = store.upsertOrg(ctx.body || {});
            if (!res.ok) {
                ctx.sendJson(400, res);
                return;
            }
            return res;
        },

        'GET /api/members': (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            return okEnvelope(HUB_TOOL, 'Listed members', {
                members: store.listMembers({ orgId: ctx.query.orgId || null }),
            });
        },

        'POST /api/members': (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            const res = store.upsertMember(ctx.body || {});
            if (!res.ok) {
                ctx.sendJson(400, res);
                return;
            }
            return res;
        },

        'POST /api/briefs': async (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            const res = await store.setWorkflowBrief(ctx.body || {});
            if (!res.ok) {
                ctx.sendJson(400, res);
                return;
            }
            return res;
        },

        'GET /api/bricks': (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            if (!auth.viewerId) {
                ctx.sendJson(
                    401,
                    errorEnvelope(
                        'VIEWER_REQUIRED',
                        'Viewer identity is required via Bearer token, X-Brick-Viewer header, or viewerId query parameter',
                        null,
                        HUB_TOOL
                    )
                );
                return;
            }
            const res = store.listVisibleBricks({
                viewerId: auth.viewerId,
                query: ctx.query.q || '',
            });
            if (!res.ok) {
                ctx.sendJson(statusForStoreError(res), res);
                return;
            }
            return res;
        },

        'GET /api/inbox': (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            if (!auth.viewerId) {
                ctx.sendJson(
                    401,
                    errorEnvelope(
                        'VIEWER_REQUIRED',
                        'Viewer identity is required via Bearer token, X-Brick-Viewer header, or viewerId query parameter',
                        null,
                        HUB_TOOL
                    )
                );
                return;
            }
            const res = store.listVisibleBricks({
                viewerId: auth.viewerId,
                query: ctx.query.q || '',
            });
            if (!res.ok) {
                ctx.sendJson(statusForStoreError(res), res);
                return;
            }
            return res;
        },

        'POST /api/bricks': (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            const bundle = ctx.body?.bundle || ctx.body;
            const res = store.publishSealedBrick(bundle, {
                actorId: auth.viewerId || ctx.body?.actorId || null,
                trustedPublicKeyPem: ctx.body?.trustedPublicKeyPem || null,
            });
            if (!res.ok) {
                ctx.sendJson(statusForStoreError(res), res);
                return;
            }
            return res;
        },

        'POST /api/suggest': async (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            const res = await store.suggestRecipients({
                actorId: auth.viewerId || ctx.body?.actorId,
                brickId: ctx.body?.brickId,
                sourceHash: ctx.body?.sourceHash || null,
                repoSignalsByOrg: ctx.body?.repoSignalsByOrg || {},
            });
            if (!res.ok) {
                ctx.sendJson(statusForStoreError(res), res);
                return;
            }
            return res;
        },

        'GET /api/grants': (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            return okEnvelope(HUB_TOOL, 'Listed grants', {
                grants: store.listGrants({
                    brickId: ctx.query.brickId || null,
                    recipientId: ctx.query.recipientId || null,
                }),
            });
        },

        'POST /api/grants': (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            const res = store.issueGrant({
                ...ctx.body,
                issuerId: auth.viewerId || ctx.body?.issuerId,
            });
            if (!res.ok) {
                ctx.sendJson(statusForStoreError(res), res);
                return;
            }
            return res;
        },

        'POST /api/revoke': (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            const res = store.revokeGrant({
                actorId: auth.viewerId || ctx.body?.actorId,
                grantId: ctx.body?.grantId,
            });
            if (!res.ok) {
                ctx.sendJson(statusForStoreError(res), res);
                return;
            }
            return res;
        },

        'GET /api/adoptions': (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            return okEnvelope(HUB_TOOL, 'Listed adoptions', {
                adoptions: store.listAdoptions({
                    brickId: ctx.query.brickId || null,
                    orgId: ctx.query.orgId || null,
                }),
            });
        },

        'POST /api/adoptions': async (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            const res = await store.recordAdoption({
                ...ctx.body,
                userId: auth.viewerId || ctx.body?.userId,
            });
            if (!res.ok) {
                ctx.sendJson(statusForStoreError(res), res);
                return;
            }
            return res;
        },

        'GET /api/audit/verify': (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            return store.verifyLedger();
        },

        'POST /api/blast-radius': async (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            const body = ctx.body || {};
            if (body.candidateEdits && typeof body.candidateEdits === 'object') {
                const verifyRes = await verifyTwoHopBlastRadius(body);
                if (!verifyRes.ok) {
                    ctx.sendJson(400, verifyRes);
                    return;
                }
                return verifyRes;
            }
            const res = analyzeBrickBlastRadius(body);
            if (!res.ok) {
                ctx.sendJson(400, res);
                return;
            }
            return res;
        },

        'POST /api/fanout/plan': (ctx) => {
            const auth = authenticateAndResolveViewer(ctx);
            if (!auth.ok) return;
            const res = planAgentFanOut(ctx.body || {});
            if (!res.ok) {
                ctx.sendJson(400, res);
                return;
            }
            return res;
        },
    };

    return createApiServer({
        serviceName,
        version,
        corsOrigins,
        logger,
        healthCheck: () => {
            if (typeof store.verifyLedger === 'function') {
                const ledger = store.verifyLedger();
                if (ledger && ledger.ok === false) return ledger;
            }
            return { auditHealthy: true };
        },
        routes,
    });
}

/**
 * 8 canonical MCP tools (`INV-STACK-03` 4-boolean annotated) for coding agent Brick Exchange workflows.
 */
export const BRICK_EXCHANGE_MCP_TOOLS = Object.freeze([
    defineMcpTool({
        name: 'brick_seal',
        title: 'Verify & Seal Brick',
        description:
            'Run 4-gate sandbox verification (zero-ambient-I/O safety, schema contract, positive + adversarial fault checks, and Ed25519 signature) to produce a sealed brick bundle, returning structured repairHints on gate failure.',
        inputSchema: {
            type: 'object',
            required: ['blueprint', 'source'],
            properties: {
                blueprint: { type: 'object', description: 'Brick blueprint and I/O schema contract' },
                source: { type: 'string', description: 'Zero-ambient-I/O JS or TS brick source code' },
                positiveChecks: { type: 'array', description: 'Positive sandbox verification checks' },
                faultChecks: { type: 'array', description: 'Adversarial fault-injection checks (>= 1 required)' },
                authorId: { type: 'string', description: 'Author member slug' },
                orgId: { type: 'string', description: 'Author organization slug' },
                brickClass: { type: 'string', description: 'Brick classification tag' },
                capabilities: { type: 'array', items: { type: 'string' }, description: 'Capability tags' },
                replacesBoilerplate: { type: 'string', description: 'Boilerplate pattern replaced by this brick' },
                estimatedHoursSaved: { type: 'number', description: 'Estimated engineering hours saved per adoption' },
                privateKeyPem: { type: 'string', description: 'Optional Ed25519 PKCS8 private key PEM' },
                publicKeyPem: { type: 'string', description: 'Optional Ed25519 SPKI public key PEM' },
                requirementId: { type: 'string', description: 'Optional spec or requirement lineage ID' },
                provenance: { type: 'string', description: 'Provenance label' },
                publish: { type: 'boolean', description: 'Publish sealed bundle directly to store when true' },
                actorId: { type: 'string', description: 'Optional publishing actor override' },
                timeoutMs: { type: 'number', description: 'Per-check sandbox wall-clock timeout in ms' },
                maxMemoryMb: { type: 'number', description: 'Sandbox V8 heap limit in MiB' },
            },
        },
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    }),

    defineMcpTool({
        name: 'brick_verify',
        title: 'Verify Sealed Brick Bundle',
        description:
            'Verify canonical SHA-256 lineage digests, fault-challenge coverage, and Ed25519 signature of a sealed brick bundle.',
        inputSchema: {
            type: 'object',
            required: ['bundle'],
            properties: {
                bundle: { type: 'object', description: 'Sealed brick bundle object' },
                trustedPublicKeyPem: { type: 'string', description: 'Optional pinned Ed25519 public key PEM' },
            },
        },
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    }),

    defineMcpTool({
        name: 'brick_suggest',
        title: 'Suggest Eligible Brick Recipients',
        description:
            'Recommend structurally authorized teammates and federated peers whose workflow briefs or boilerplate signals match a sealed brick.',
        inputSchema: {
            type: 'object',
            required: ['actorId', 'brickId'],
            properties: {
                actorId: { type: 'string', description: 'Author or exporter member ID' },
                brickId: { type: 'string', description: 'Sealed brick ID' },
                sourceHash: { type: 'string', description: 'Optional pinned sourceHash' },
                repoSignalsByOrg: { type: 'object', description: 'Optional lego-scout boilerplate signals keyed by orgId' },
                repoRoot: { type: 'string', description: 'Optional local repository directory to scan' },
            },
        },
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    }),

    defineMcpTool({
        name: 'brick_share',
        title: 'Issue Scoped Cross-Org Brick Grant',
        description:
            'Issue a non-reshareable, time-bounded federated grant authorizing specific peer-org recipients to discover and adopt a sealed brick.',
        inputSchema: {
            type: 'object',
            required: ['issuerId', 'brickId', 'recipients', 'expiresAt'],
            properties: {
                issuerId: { type: 'string', description: 'Exporter member ID issuing the grant' },
                brickId: { type: 'string', description: 'Sealed brick ID' },
                sourceHash: { type: 'string', description: 'Pinned 64-char hex sourceHash' },
                scope: { type: 'string', description: 'Grant scope (defaults to federated)' },
                recipients: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Authorized recipient member IDs',
                },
                expiresAt: { type: 'string', description: 'ISO-8601 expiration timestamp' },
            },
        },
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    }),

    defineMcpTool({
        name: 'brick_inbox',
        title: 'List Visible Bricks in Inbox',
        description:
            'List sealed bricks visible to viewerId via same-org team commons or active cross-org grants.',
        inputSchema: {
            type: 'object',
            required: ['viewerId'],
            properties: {
                viewerId: { type: 'string', description: 'Recipient member ID' },
                query: { type: 'string', description: 'Optional FTS5 or keyword search query' },
            },
        },
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    }),

    defineMcpTool({
        name: 'brick_try_local',
        title: 'Try Sealed Brick Locally in Sandbox',
        description:
            'Execute a sealed brick in the isolated local sandbox against recipient sampleInput and local hexagonal binding with zero remote upload.',
        inputSchema: {
            type: 'object',
            required: ['sampleInput'],
            properties: {
                bundle: { type: 'object', description: 'Sealed brick bundle (or resolve via viewerId + brickId)' },
                viewerId: { type: 'string', description: 'Viewer member ID when resolving bundle from store' },
                brickId: { type: 'string', description: 'Brick ID when resolving bundle from store' },
                sourceHash: { type: 'string', description: 'Optional sourceHash when resolving bundle from store' },
                sampleInput: { description: 'Recipient sample input validated against blueprint.inputSchema' },
                binding: { type: 'object', description: 'Local capability port bindings' },
                timeoutMs: { type: 'number', description: 'Optional sandbox timeout in ms' },
                maxMemoryMb: { type: 'number', description: 'Optional sandbox memory cap in MiB' },
            },
        },
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    }),

    defineMcpTool({
        name: 'brick_adopt',
        title: 'Adopt & Vendor Sealed Brick into Repo',
        description:
            'Vendor a verified sealed brick into bricks/<brickId>/, preserve local binding.js, update .brick-lock.json, verify lock integrity, and optionally record adoption in store.',
        inputSchema: {
            type: 'object',
            required: ['targetRepoDir'],
            properties: {
                bundle: { type: 'object', description: 'Sealed brick bundle (or resolve via userId/viewerId + brickId)' },
                userId: { type: 'string', description: 'Adopting member ID for store authorization and receipt' },
                viewerId: { type: 'string', description: 'Alias for userId when resolving from store' },
                brickId: { type: 'string', description: 'Brick ID when resolving from store' },
                sourceHash: { type: 'string', description: 'Optional pinned sourceHash' },
                targetRepoDir: { type: 'string', description: 'Target repository directory path' },
                bindingSource: { type: 'string', description: 'Optional starter bricks/<id>/binding.js source' },
                grantId: { type: 'string', description: 'Optional cross-org grant ID' },
                adoptedBy: { type: 'string', description: 'Adopter identifier written to .brick-lock.json' },
                sampleInput: { description: 'Optional pre-vendor local sampleInput check' },
                binding: { type: 'object', description: 'Optional local binding for pre-vendor sampleInput check' },
                recordInStore: { type: 'boolean', description: 'Whether to record adoption in store' },
                hydraRequestId: { type: 'string', description: 'Optional HydraDB request ID for positive feedback' },
            },
        },
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    }),

    defineMcpTool({
        name: 'brick_revoke',
        title: 'Revoke Scoped Brick Grant',
        description:
            'Immediately revoke a previously issued grant so future cross-org discovery, fetches, and adoptions fail closed.',
        inputSchema: {
            type: 'object',
            required: ['actorId', 'grantId'],
            properties: {
                actorId: { type: 'string', description: 'Issuer or authorized org publisher member ID' },
                grantId: { type: 'string', description: 'Grant ID to revoke' },
            },
        },
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    }),

    defineMcpTool({
        name: 'brick_blast_radius',
        title: 'Deadbolt 2-Hop AST Blast-Radius & Downstream Invariant Gate',
        description:
            'Map 1-hop and 2-hop AST caller chains (hop0 -> hop1 -> hop2) for modified files or upgraded bricks, or verify staged candidateEdits against subagent leases, Policy Floor protected files, AST export compatibility, and Node 22 --permission 2-hop invariants.',
        inputSchema: {
            type: 'object',
            required: ['repoDir'],
            properties: {
                repoDir: { type: 'string', description: 'Repository directory path' },
                changedFiles: { type: 'array', items: { type: 'string' }, description: 'Relative paths of changed files or bricks' },
                candidateEdits: { type: 'object', description: 'Optional map of { [relPath]: newSource } to stage and verify' },
                lease: { type: 'object', description: 'Optional subagent lease object ({ taskId, targetFiles })' },
                protectedFiles: { type: 'array', items: { type: 'string' }, description: 'Policy-Floor protected 2-hop verifier paths' },
                invariantScript: { type: 'string', description: 'Optional inline ESM script executing 2-hop downstream reconciliation' },
                invariantEntryFile: { type: 'string', description: 'Optional workspace-relative test/reconciler entry file' },
            },
        },
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    }),

    defineMcpTool({
        name: 'brick_plan_fanout',
        title: 'Plan Disjoint Multi-Agent / Multi-Engineer Fan-Out Waves',
        description:
            'Compute 2-hop AST blast-radius cones across parallel subagent or engineer tasks, detect hidden 2-hop collisions even when targetFiles look disjoint, reserve orchestrator choke points, and emit conflict-free execution waves with strict file leases.',
        inputSchema: {
            type: 'object',
            required: ['repoDir', 'tasks'],
            properties: {
                repoDir: { type: 'string', description: 'Repository directory path' },
                tasks: { type: 'array', description: 'Candidate subagent or engineer tasks [{ id, title, targetFiles }]' },
                protectedFiles: { type: 'array', items: { type: 'string' }, description: 'Policy-Floor protected files' },
                maxBlastHops: { type: 'number', description: 'Blast radius hop depth (default 2)' },
            },
        },
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    }),
]);

/**
 * Resolve a bundle directly from `args.bundle` or via authorized `store.getVisibleBrick(...)`.
 *
 * @param {object|null} store
 * @param {object} args
 * @returns {{ ok: true, bundle: object } | { ok: false, code: string, message: string, details?: unknown }}
 */
function resolveBundleFromArgsOrStore(store, args) {
    if (args?.bundle && typeof args.bundle === 'object') {
        return { ok: true, bundle: args.bundle };
    }
    const viewerId = args?.viewerId || args?.userId || '';
    const brickId = args?.brickId || '';
    if (!store || typeof store.getVisibleBrick !== 'function') {
        return {
            ok: false,
            code: 'BUNDLE_REQUIRED',
            message: 'Provide a sealed bundle object or configure a store with viewerId and brickId',
        };
    }
    if (!viewerId || !brickId) {
        return {
            ok: false,
            code: 'INVALID_ARGUMENTS',
            message: 'Provide bundle or both viewerId/userId and brickId',
        };
    }
    const visibleRes = store.getVisibleBrick({
        viewerId,
        brickId,
        sourceHash: args?.sourceHash || null,
    });
    if (!visibleRes.ok) {
        return {
            ok: false,
            code: visibleRes.error?.code || 'ACCESS_DENIED',
            message: visibleRes.error?.message || visibleRes.summary,
            details: visibleRes.error?.details ?? null,
        };
    }
    const resolved = visibleRes.data?.bundle || visibleRes.data?.brick || visibleRes.data;
    if (!resolved || typeof resolved !== 'object') {
        return {
            ok: false,
            code: 'BRICK_NOT_FOUND',
            message: `Unable to resolve sealed bundle for "${brickId}"`,
        };
    }
    return { ok: true, bundle: resolved };
}

/**
 * Create and wire the Brick Exchange MCP server (`connect: false` returns `{ server, normalizedTools, listTools, callTool }`).
 *
 * @param {object} [options={}]
 * @param {object|null} [options.store=null]
 * @param {string} [options.name='krusch-brick-exchange-mcp']
 * @param {string} [options.version='1.0.0']
 * @param {boolean} [options.connect=false]
 * @returns {Promise<object>}
 */
export async function createBrickExchangeMcpServer({
    store = null,
    name = 'krusch-brick-exchange-mcp',
    version = '1.0.0',
    connect = false,
} = {}) {
    const handler = async (toolName, rawArgs = {}) => {
        const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};

        switch (toolName) {
            case 'brick_seal': {
                const verifyRes = await runBrickVerificationGates({
                    blueprint: args.blueprint,
                    source: args.source,
                    positiveChecks: Array.isArray(args.positiveChecks) ? args.positiveChecks : [],
                    faultChecks: Array.isArray(args.faultChecks) ? args.faultChecks : [],
                    customRunner: typeof args.customRunner === 'function' ? args.customRunner : null,
                    timeoutMs: args.timeoutMs,
                    maxMemoryMb: args.maxMemoryMb,
                });

                if (!verifyRes.ok) {
                    const rawDetails =
                        verifyRes.error?.details && typeof verifyRes.error.details === 'object'
                            ? verifyRes.error.details
                            : {};
                    const repairHints =
                        Array.isArray(rawDetails.repairHints) && rawDetails.repairHints.length > 0
                            ? rawDetails.repairHints
                            : [
                                  {
                                      gate: 'verification',
                                      checkName: null,
                                      message: verifyRes.error?.message || verifyRes.summary,
                                      counterexample: null,
                                  },
                              ];
                    return errorMcpResult(
                        'brick_seal',
                        verifyRes.error?.code || 'BRICK_VERIFICATION_FAILED',
                        verifyRes.error?.message || verifyRes.summary,
                        { ...rawDetails, repairHints }
                    );
                }

                let privateKeyPem = args.privateKeyPem || '';
                let publicKeyPem = args.publicKeyPem || '';
                let ephemeralKeyGenerated = false;

                if (!privateKeyPem) {
                    const keyPairRes = generateBrickSigningKeyPair();
                    if (!keyPairRes.ok) {
                        return errorMcpResult(
                            'brick_seal',
                            keyPairRes.error?.code || 'KEYGEN_FAILED',
                            keyPairRes.error?.message || keyPairRes.summary,
                            {
                                ...keyPairRes.error?.details,
                                repairHints: [
                                    {
                                        gate: 'seal',
                                        checkName: 'keygen',
                                        message: keyPairRes.error?.message || 'Failed to generate Ed25519 keypair',
                                        counterexample: null,
                                    },
                                ],
                            }
                        );
                    }
                    privateKeyPem = keyPairRes.data.privateKeyPem;
                    publicKeyPem = keyPairRes.data.publicKeyPem;
                    ephemeralKeyGenerated = true;
                }

                const sealRes = sealVerifiedBrick({
                    blueprint: args.blueprint,
                    source: args.source,
                    verificationReport: verifyRes.data,
                    authorId: args.authorId || args.actorId || 'local-author',
                    orgId: args.orgId || 'local-org',
                    brickClass: args.brickClass || 'general',
                    capabilities: Array.isArray(args.capabilities) ? args.capabilities : [],
                    replacesBoilerplate: args.replacesBoilerplate || '',
                    estimatedHoursSaved: args.estimatedHoursSaved ?? 4,
                    privateKeyPem,
                    publicKeyPem,
                    requirementId: args.requirementId || null,
                    provenance: args.provenance || 'agent-verified',
                    createdAt: args.createdAt,
                });

                if (!sealRes.ok) {
                    const sealDetails =
                        sealRes.error?.details && typeof sealRes.error.details === 'object'
                            ? sealRes.error.details
                            : {};
                    const repairHints =
                        Array.isArray(sealDetails.repairHints) && sealDetails.repairHints.length > 0
                            ? sealDetails.repairHints
                            : [
                                  {
                                      gate: 'seal',
                                      checkName: 'sealVerifiedBrick',
                                      message: sealRes.error?.message || sealRes.summary,
                                      counterexample: null,
                                  },
                              ];
                    return errorMcpResult(
                        'brick_seal',
                        sealRes.error?.code || 'BRICK_NOT_QUALIFIED',
                        sealRes.error?.message || sealRes.summary,
                        { ...sealDetails, repairHints }
                    );
                }

                const bundle = sealRes.data.bundle;
                let publishReceipt = null;
                if (args.publish === true && store && typeof store.publishSealedBrick === 'function') {
                    const pubRes = await store.publishSealedBrick(bundle, {
                        actorId: args.actorId || args.authorId || bundle.authorId,
                        trustedPublicKeyPem: args.trustedPublicKeyPem || null,
                    });
                    if (!pubRes.ok) {
                        return errorMcpResult(
                            'brick_seal',
                            pubRes.error?.code || 'PUBLISH_DENIED',
                            pubRes.error?.message || pubRes.summary,
                            {
                                ...pubRes.error?.details,
                                bundle,
                                repairHints: [
                                    {
                                        gate: 'publish',
                                        checkName: 'publishSealedBrick',
                                        message: pubRes.error?.message || pubRes.summary,
                                        counterexample: null,
                                    },
                                ],
                            }
                        );
                    }
                    publishReceipt = pubRes.data;
                }

                return okMcpResult('brick_seal', sealRes.summary, {
                    bundle,
                    verification: verifyRes.data,
                    ephemeralKeyGenerated,
                    published: Boolean(publishReceipt),
                    ...(publishReceipt ? { publishReceipt } : {}),
                });
            }

            case 'brick_verify': {
                const res = verifyBrickBundle(args.bundle, {
                    trustedPublicKeyPem: args.trustedPublicKeyPem || null,
                });
                if (!res.ok) {
                    return errorMcpResult(
                        'brick_verify',
                        res.error?.code || 'INVALID_BRICK_BUNDLE',
                        res.error?.message || res.summary,
                        res.error?.details ?? null
                    );
                }
                return okMcpResult('brick_verify', res.summary, res.data);
            }

            case 'brick_suggest': {
                if (!store || typeof store.suggestRecipients !== 'function') {
                    return errorMcpResult(
                        'brick_suggest',
                        'STORE_REQUIRED',
                        'Brick Exchange store is required for brick_suggest'
                    );
                }
                const res = await store.suggestRecipients({
                    actorId: args.actorId,
                    brickId: args.brickId,
                    sourceHash: args.sourceHash || null,
                    repoSignalsByOrg: args.repoSignalsByOrg || {},
                    repoRoot: args.repoRoot || null,
                });
                if (!res.ok) {
                    return errorMcpResult(
                        'brick_suggest',
                        res.error?.code || 'SUGGEST_FAILED',
                        res.error?.message || res.summary,
                        res.error?.details ?? null
                    );
                }
                return okMcpResult('brick_suggest', res.summary, res.data);
            }

            case 'brick_share': {
                if (!store || typeof store.issueGrant !== 'function') {
                    return errorMcpResult(
                        'brick_share',
                        'STORE_REQUIRED',
                        'Brick Exchange store is required for brick_share'
                    );
                }
                let sourceHash = args.sourceHash || '';
                if (!sourceHash && typeof store.getVisibleBrick === 'function') {
                    const vis = store.getVisibleBrick({
                        viewerId: args.issuerId,
                        brickId: args.brickId,
                    });
                    if (vis?.ok) {
                        const found = vis.data?.bundle || vis.data?.brick || vis.data;
                        sourceHash = found?.lineage?.sourceHash || found?.sourceHash || '';
                    }
                }
                const res = store.issueGrant({
                    issuerId: args.issuerId,
                    brickId: args.brickId,
                    sourceHash,
                    scope: args.scope || 'federated',
                    recipients: Array.isArray(args.recipients) ? args.recipients : [],
                    expiresAt: args.expiresAt,
                });
                if (!res.ok) {
                    return errorMcpResult(
                        'brick_share',
                        res.error?.code || 'GRANT_DENIED',
                        res.error?.message || res.summary,
                        res.error?.details ?? null
                    );
                }
                return okMcpResult('brick_share', res.summary, res.data);
            }

            case 'brick_inbox': {
                if (!store || typeof store.listVisibleBricks !== 'function') {
                    return errorMcpResult(
                        'brick_inbox',
                        'STORE_REQUIRED',
                        'Brick Exchange store is required for brick_inbox'
                    );
                }
                const res = store.listVisibleBricks({
                    viewerId: args.viewerId,
                    query: args.query || '',
                });
                if (!res.ok) {
                    return errorMcpResult(
                        'brick_inbox',
                        res.error?.code || 'INBOX_DENIED',
                        res.error?.message || res.summary,
                        res.error?.details ?? null
                    );
                }
                return okMcpResult('brick_inbox', res.summary, res.data);
            }

            case 'brick_try_local': {
                const resolved = resolveBundleFromArgsOrStore(store, args);
                if (!resolved.ok) {
                    return errorMcpResult('brick_try_local', resolved.code, resolved.message, resolved.details ?? null);
                }
                const tryRes = await tryBrickLocally({
                    bundle: resolved.bundle,
                    binding: args.binding || {},
                    sampleInput: args.sampleInput,
                    customRunner: typeof args.customRunner === 'function' ? args.customRunner : null,
                    timeoutMs: args.timeoutMs,
                    maxMemoryMb: args.maxMemoryMb,
                });
                if (!tryRes.ok) {
                    return errorMcpResult(
                        'brick_try_local',
                        tryRes.error?.code || 'TRY_LOCAL_FAILED',
                        tryRes.error?.message || tryRes.summary,
                        tryRes.error?.details ?? null
                    );
                }
                return okMcpResult('brick_try_local', tryRes.summary, tryRes.data);
            }

            case 'brick_adopt': {
                const resolved = resolveBundleFromArgsOrStore(store, args);
                if (!resolved.ok) {
                    return errorMcpResult('brick_adopt', resolved.code, resolved.message, resolved.details ?? null);
                }
                const bundle = resolved.bundle;
                const adopter = args.adoptedBy || args.userId || args.viewerId || 'local-dev';

                const adoptRes = await adoptBrickIntoRepo({
                    bundle,
                    targetRepoDir: args.targetRepoDir,
                    bindingSource: args.bindingSource || null,
                    grantId: args.grantId || null,
                    adoptedBy: adopter,
                    sampleInput: args.sampleInput,
                    binding: args.binding || {},
                    customRunner: typeof args.customRunner === 'function' ? args.customRunner : null,
                });
                if (!adoptRes.ok) {
                    return errorMcpResult(
                        'brick_adopt',
                        adoptRes.error?.code || 'ADOPT_FAILED',
                        adoptRes.error?.message || adoptRes.summary,
                        adoptRes.error?.details ?? null
                    );
                }

                const lockAudit = auditRepoBrickLocks(args.targetRepoDir);
                if (!lockAudit.ok || lockAudit.data?.clean === false) {
                    return errorMcpResult(
                        'brick_adopt',
                        lockAudit.error?.code || 'BRICK_LOCK_AUDIT_FAILED',
                        lockAudit.error?.message || 'Post-vendor .brick-lock.json integrity audit failed',
                        lockAudit.data || lockAudit.error?.details || null
                    );
                }

                const actorUserId = args.userId || args.viewerId || null;
                let adoptionRecord = null;
                if (
                    store &&
                    typeof store.recordAdoption === 'function' &&
                    args.recordInStore !== false &&
                    (actorUserId || args.recordInStore === true)
                ) {
                    const recRes = await store.recordAdoption({
                        userId: actorUserId || adopter,
                        brickId: bundle.brickId,
                        sourceHash: bundle.lineage?.sourceHash || adoptRes.data.sourceHash,
                        grantId: args.grantId || null,
                        bindingHash: adoptRes.data.bindingHash || '',
                        localChecksPassed: true,
                        hydraRequestId: args.hydraRequestId || null,
                    });
                    if (!recRes.ok) {
                        return errorMcpResult(
                            'brick_adopt',
                            recRes.error?.code || 'RECORD_ADOPTION_FAILED',
                            recRes.error?.message || recRes.summary,
                            recRes.error?.details ?? null
                        );
                    }
                    adoptionRecord = recRes.data?.adoption || recRes.data;
                }

                return okMcpResult('brick_adopt', adoptRes.summary, {
                    ...adoptRes.data,
                    lockAudit: lockAudit.data,
                    ...(adoptionRecord ? { adoption: adoptionRecord } : {}),
                });
            }

            case 'brick_revoke': {
                if (!store || typeof store.revokeGrant !== 'function') {
                    return errorMcpResult(
                        'brick_revoke',
                        'STORE_REQUIRED',
                        'Brick Exchange store is required for brick_revoke'
                    );
                }
                const res = store.revokeGrant({
                    actorId: args.actorId,
                    grantId: args.grantId,
                });
                if (!res.ok) {
                    return errorMcpResult(
                        'brick_revoke',
                        res.error?.code || 'REVOKE_DENIED',
                        res.error?.message || res.summary,
                        res.error?.details ?? null
                    );
                }
                return okMcpResult('brick_revoke', res.summary, res.data);
            }

            case 'brick_blast_radius': {
                if (args.candidateEdits && typeof args.candidateEdits === 'object') {
                    const res = await verifyTwoHopBlastRadius({
                        repoDir: args.repoDir,
                        candidateEdits: args.candidateEdits,
                        lease: args.lease || null,
                        protectedFiles: Array.isArray(args.protectedFiles) ? args.protectedFiles : [],
                        invariantScript: args.invariantScript || '',
                        invariantEntryFile: args.invariantEntryFile || '',
                    });
                    if (!res.ok) {
                        return errorMcpResult(
                            'brick_blast_radius',
                            res.error?.code || 'BLAST_RADIUS_FAILED',
                            res.error?.message || res.summary,
                            res.error?.details ?? null
                        );
                    }
                    return okMcpResult('brick_blast_radius', res.summary, res.data);
                }

                const res = analyzeBrickBlastRadius({
                    repoDir: args.repoDir,
                    changedFiles: Array.isArray(args.changedFiles) ? args.changedFiles : [],
                    protectedFiles: Array.isArray(args.protectedFiles) ? args.protectedFiles : [],
                });
                if (!res.ok) {
                    return errorMcpResult(
                        'brick_blast_radius',
                        res.error?.code || 'BLAST_RADIUS_FAILED',
                        res.error?.message || res.summary,
                        res.error?.details ?? null
                    );
                }
                return okMcpResult('brick_blast_radius', res.summary, res.data);
            }

            case 'brick_plan_fanout': {
                const res = planAgentFanOut({
                    repoDir: args.repoDir,
                    tasks: Array.isArray(args.tasks) ? args.tasks : [],
                    protectedFiles: Array.isArray(args.protectedFiles) ? args.protectedFiles : [],
                    maxBlastHops: args.maxBlastHops,
                });
                if (!res.ok) {
                    return errorMcpResult(
                        'brick_plan_fanout',
                        res.error?.code || 'FANOUT_PLAN_FAILED',
                        res.error?.message || res.summary,
                        res.error?.details ?? null
                    );
                }
                return okMcpResult('brick_plan_fanout', res.summary, res.data);
            }

            default:
                return errorMcpResult(toolName, 'UNKNOWN_TOOL', `Unknown tool: ${toolName}`);
        }
    };

    return createMcpServer(name, version, BRICK_EXCHANGE_MCP_TOOLS, handler, {
        connect,
        strictTools: true,
    });
}
