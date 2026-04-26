/**
 * Chrysalis Monitor — Dashboard Application
 * 
 * Fetches data from the monitoring API, renders stats/tables/cards,
 * and provides a JSON Translator that converts raw execution data
 * into human-readable summaries.
 */

// ── State ───────────────────────────────────────────────────────────────────
let allExecutions = [];
let allPersonas = [];
let allSessions = [];
let healthData = {};
let refreshTimer = null;
const POLL_INTERVAL = 15000; // 15s auto-refresh

// ── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
   initTabs();
   initModal();
   document.getElementById('btn-refresh').addEventListener('click', refreshAll);
   document.getElementById('filter-persona').addEventListener('change', renderExecutions);
   refreshAll();
   refreshTimer = setInterval(refreshAll, POLL_INTERVAL);
});

// ── Data Fetching ───────────────────────────────────────────────────────────
async function refreshAll() {
   const btn = document.getElementById('btn-refresh');
   btn.style.animation = 'spin 0.6s ease';
   setTimeout(() => btn.style.animation = '', 600);
   
   try {
      await Promise.all([
         fetchStats(),
         fetchHealth(),
         fetchExecutions(),
         fetchPersonas(),
         fetchSessions(),
         fetchAnalytics(),
         fetchDAGPlans()
      ]);
      setLiveStatus(true);
   } catch (err) {
      console.error('[Monitor] Refresh failed:', err);
      setLiveStatus(false);
   }
}

async function fetchStats() {
   const res = await fetch('/api/stats');
   const data = await res.json();
   
   animateValue('val-personas', data.totalPersonas);
   animateValue('val-executions', data.totalExecutions);
   animateValue('val-sessions', data.totalSessions);
   document.getElementById('val-avg-time').textContent = 
      data.avgExecutionMs > 1000 ? `${(data.avgExecutionMs / 1000).toFixed(1)}s` : `${data.avgExecutionMs}ms`;
}

async function fetchHealth() {
   const res = await fetch('/api/health');
   healthData = await res.json();
   renderHealth();
}

async function fetchExecutions() {
   const res = await fetch('/api/executions?limit=100');
   allExecutions = await res.json();
   populatePersonaFilter();
   renderExecutions();
}

async function fetchPersonas() {
   const res = await fetch('/api/personas');
   allPersonas = await res.json();
   renderPersonas();
}

async function fetchSessions() {
   const res = await fetch('/api/sessions');
   allSessions = await res.json();
   renderSessions();
}

// ── Rendering: Health ───────────────────────────────────────────────────────
function renderHealth() {
   const grid = document.getElementById('nodes-grid');
   const badge = document.getElementById('health-badge');
   const entries = Object.entries(healthData);
   const onlineCount = entries.filter(([, v]) => v.status === 'online').length;
   
   badge.textContent = `${onlineCount}/${entries.length} Online`;
   badge.style.color = onlineCount === entries.length ? 'var(--accent-emerald)' : 'var(--accent-amber)';
   
   grid.innerHTML = entries.map(([name, info]) => {
      const nodeDisplayName = name.replace('_', ' › ');
      const isOnline = info.status === 'online';
      const modelsHtml = isOnline && info.models?.length 
         ? `<div class="node-models">${info.models.map(m => 
              `<span class="model-chip">${m.name}</span>`
           ).join('')}</div>`
         : '';
      const errorHtml = !isOnline ? `<div class="node-error">${escapeHtml(info.error || 'Unreachable')}</div>` : '';
      
      return `
         <div class="node-card">
            <div class="node-header">
               <span class="node-status ${isOnline ? 'online' : 'offline'}"></span>
               <span class="node-name">${nodeDisplayName}</span>
            </div>
            <div class="node-url">${info.url}</div>
            ${modelsHtml}
            ${errorHtml}
         </div>`;
   }).join('');
}

// ── Rendering: Executions ───────────────────────────────────────────────────
function renderExecutions() {
   const tbody = document.getElementById('exec-tbody');
   const filterPersona = document.getElementById('filter-persona').value;
   
   const filtered = filterPersona
      ? allExecutions.filter(e => e.persona_name === filterPersona)
      : allExecutions;
   
   if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state"><p>No executions found</p></td></tr>`;
      return;
   }
   
   tbody.innerHTML = filtered.map(exec => {
      const time = formatTime(exec.created_at);
      const latency = formatLatency(exec.execution_time_ms);
      const latencyClass = getLatencyClass(exec.execution_time_ms);
      const nodeClass = (exec.node || '').includes('kruschgame') ? 'kruschgame' : 'kruschdev';
      const nodeLabel = exec.node ? exec.node.replace('kruschdev_', '').replace('kruschgame', 'game') : '—';
      const actionPreview = truncate(exec.action, 80);
      
      return `
         <tr>
            <td class="td-time">${time}</td>
            <td>
               <div class="td-persona">
                  <span class="persona-dot ${exec.is_synthetic ? 'synthetic' : 'native'}"></span>
                  <span class="td-persona-name">${escapeHtml(exec.persona_name || '—')}</span>
               </div>
            </td>
            <td class="td-node"><span class="node-tag ${nodeClass}">${nodeLabel}</span></td>
            <td class="td-action" title="${escapeHtml(exec.action)}">${escapeHtml(actionPreview)}</td>
            <td class="td-latency ${latencyClass}">${latency}</td>
            <td><button class="btn-detail" onclick='showExecDetail(${JSON.stringify(exec).replace(/'/g, "&#39;")})'>View</button></td>
         </tr>`;
   }).join('');
}

function populatePersonaFilter() {
   const select = document.getElementById('filter-persona');
   const current = select.value;
   const personas = [...new Set(allExecutions.map(e => e.persona_name).filter(Boolean))].sort();
   
   select.innerHTML = '<option value="">All Personas</option>' + 
      personas.map(p => `<option value="${p}" ${p === current ? 'selected' : ''}>${p}</option>`).join('');
}

// ── Rendering: Personas ─────────────────────────────────────────────────────
function renderPersonas() {
   const grid = document.getElementById('personas-grid');
   const badge = document.getElementById('persona-count-badge');
   badge.textContent = `${allPersonas.length} total`;
   
   grid.innerHTML = allPersonas.map(p => {
      const nodeClass = (p.node || '').includes('kruschgame') ? 'kruschgame' : 'kruschdev';
      const execCount = parseInt(p.execution_count) || 0;
      const avgMs = Math.round(parseFloat(p.avg_exec_ms) || 0);
      
      return `
         <div class="persona-card" onclick='showPersonaDetail(${JSON.stringify(p).replace(/'/g, "&#39;")})'>
            <div class="persona-card-header">
               <span class="persona-card-name">${escapeHtml(p.name)}</span>
               <span class="persona-card-badge ${p.is_synthetic ? 'synthetic' : 'native'}">${p.is_synthetic ? '🧪 Synth' : '📦 Native'}</span>
            </div>
            <div class="persona-card-meta">
               <span class="persona-meta-tag">${escapeHtml(p.base_model)}</span>
               <span class="persona-meta-tag node-tag ${nodeClass}">${p.node}</span>
               ${p.project_domain ? `<span class="persona-meta-tag">${escapeHtml(p.project_domain)}</span>` : ''}
            </div>
            <div class="persona-card-skill">${escapeHtml(p.skill || 'No skill defined')}</div>
            <div class="persona-card-stats">
               <span class="persona-stat"><strong>${execCount}</strong> runs</span>
               <span class="persona-stat"><strong>${avgMs > 1000 ? (avgMs/1000).toFixed(1) + 's' : avgMs + 'ms'}</strong> avg</span>
            </div>
         </div>`;
   }).join('');
}

// ── Rendering: Sessions ─────────────────────────────────────────────────────
function renderSessions() {
   const list = document.getElementById('sessions-list');
   
   if (allSessions.length === 0) {
      list.innerHTML = '<div class="empty-state"><p>No sessions recorded yet</p></div>';
      return;
   }
   
   list.innerHTML = allSessions.map(s => {
      const startTime = formatTime(s.started_at);
      const totalMs = parseInt(s.total_ms) || 0;
      const personaChips = (s.personas_used || []).map(p => 
         `<span class="model-chip">${escapeHtml(p)}</span>`
      ).join('');
      
      return `
         <div class="session-item" onclick="loadSession('${s.session_id}', this)">
            <div class="session-header">
               <span class="session-id">${s.session_id.slice(0, 8)}…</span>
               <span class="session-time">${startTime}</span>
            </div>
            <div class="session-meta">
               <span><strong>${s.step_count}</strong> steps</span>
               <span><strong>${totalMs > 1000 ? (totalMs/1000).toFixed(1) + 's' : totalMs + 'ms'}</strong> total</span>
            </div>
            <div class="session-personas">${personaChips}</div>
         </div>`;
   }).join('');
}

// ── Analytics ───────────────────────────────────────────────────────────────
let analyticsData = null;

async function fetchAnalytics() {
   const res = await fetch('/api/persona-stats');
   analyticsData = await res.json();
   renderAnalytics();
}

function renderAnalytics() {
   if (!analyticsData) return;
   const { summary, topPerformers, neverUsed } = analyticsData;

   // Summary cards
   animateValue('val-total-calls', summary.totalCalls);
   animateValue('val-active-personas', summary.activePersonas);
   document.getElementById('val-success-rate').textContent = `${summary.overallSuccessRate}%`;
   document.getElementById('analytics-badge').textContent = `${summary.activePersonas}/${summary.totalPersonas} active`;

   // Top performers table
   const tbody = document.getElementById('top-performers-tbody');
   if (topPerformers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state"><p>No execution data yet</p></td></tr>';
   } else {
      tbody.innerHTML = topPerformers.map(p => {
         const successRate = parseFloat(p.success_rate) || 0;
         const rateClass = successRate >= 95 ? 'latency-fast' : successRate >= 80 ? 'latency-medium' : 'latency-slow';
         const avgMs = parseInt(p.avg_exec_ms) || 0;
         return `
            <tr>
               <td><strong>${escapeHtml(p.name)}</strong></td>
               <td>${p.call_count}</td>
               <td class="${getLatencyClass(avgMs)}">${formatLatency(avgMs)}</td>
               <td class="${rateClass}">${successRate}%</td>
               <td class="td-time">${formatTime(p.last_execution)}</td>
            </tr>`;
      }).join('');
   }

   // Never used list
   const neverUsedEl = document.getElementById('never-used-list');
   if (neverUsed.length === 0) {
      neverUsedEl.innerHTML = '<p class="empty-state" style="padding: var(--space-sm);">All personas have been used! 🎉</p>';
   } else {
      neverUsedEl.innerHTML = neverUsed.map(name =>
         `<span class="model-chip never-used-chip">${escapeHtml(name)}</span>`
      ).join('');
   }
}

// ── DAG Visualization ───────────────────────────────────────────────────────
let dagPlans = [];

async function fetchDAGPlans() {
   try {
      const res = await fetch('/api/dag-plans');
      dagPlans = await res.json();
      renderDAGPlans();
   } catch (err) {
      console.warn('[Monitor] DAG fetch failed:', err);
   }
}

async function renderDAGPlans() {
   const container = document.getElementById('dag-plans-list');
   const badge = document.getElementById('dag-count-badge');
   badge.textContent = `${dagPlans.length} plans`;
   
   if (!dagPlans || dagPlans.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No DAG plans recorded yet. Execute a multi-step task to see visualizations here.</p></div>';
      return;
   }
   
   container.innerHTML = dagPlans.map((plan, i) => {
      const statusIcon = plan.status === 'completed' ? '✅' : plan.status === 'running' ? '⏳' : '⏸️';
      const stepCount = (plan.steps || []).length;
      const roots = (plan.steps || []).filter(s => !s.depends_on || s.depends_on.length === 0).length;
      
      return `
         <div class="dag-plan-item">
            <div class="dag-plan-header">
               <div>
                  <span class="dag-status">${statusIcon}</span>
                  <strong>${stepCount} steps</strong> (${roots} parallel roots)
                  <span class="dag-plan-time">${formatTime(plan.created_at)}</span>
               </div>
               <span class="badge">${plan.status}</span>
            </div>
            <div class="dag-mermaid-container">
               <pre class="mermaid" id="dag-mermaid-${i}">${escapeHtml(plan.mermaid || '')}</pre>
            </div>
            <div class="dag-step-list">
               ${(plan.steps || []).map(s => `
                  <div class="dag-step-chip">
                     <span class="dag-step-id">${s.id}</span>
                     <span class="dag-step-persona">${escapeHtml(s.persona)}</span>
                     <span class="dag-step-deps">${s.depends_on && s.depends_on.length > 0 ? '← ' + s.depends_on.join(', ') : '(root)'}</span>
                  </div>
               `).join('')}
            </div>
         </div>`;
   }).join('');
   
   // Trigger Mermaid rendering
   try {
      await mermaid.run({ querySelector: '.mermaid' });
   } catch (err) {
      console.warn('[Monitor] Mermaid render failed:', err);
   }
}

async function loadSession(sessionId, el) {
   // Toggle: if timeline already exists, remove it
   const existing = el.querySelector('.session-timeline');
   if (existing) { existing.remove(); return; }
   
   try {
      const res = await fetch(`/api/session/${sessionId}`);
      const steps = await res.json();
      
      const timelineHtml = steps.map((step, i) => `
         <div class="timeline-step">
            <div class="timeline-persona">${escapeHtml(step.persona_name)} <span style="color:var(--text-muted);font-weight:400;font-size:0.72rem">on ${step.node || '?'}</span></div>
            <div class="timeline-action">${escapeHtml(truncate(step.action, 200))}</div>
            <div class="timeline-time">${formatLatency(step.execution_time_ms)} · ${formatTime(step.created_at)}</div>
         </div>
      `).join('');
      
      const timeline = document.createElement('div');
      timeline.className = 'session-timeline';
      timeline.innerHTML = timelineHtml;
      el.appendChild(timeline);
   } catch (err) {
      console.error('Failed to load session:', err);
   }
}

// ── JSON Translator (Modal) ─────────────────────────────────────────────────

/**
 * Shows execution detail in the modal with a human-readable
 * "translated" summary above the raw JSON.
 */
function showExecDetail(exec) {
   const title = document.getElementById('modal-title');
   const body = document.getElementById('modal-body');
   
   title.textContent = `Execution: ${exec.persona_name}`;
   
   // Build the human-readable translation
   const translation = translateExecution(exec);
   
   // Build the detail view
   const detailFields = [
      ['Persona', exec.persona_name],
      ['Model', exec.base_model || '—'],
      ['Node', exec.node || '—'],
      ['Session', exec.session_id ? exec.session_id.slice(0, 8) + '…' : '—'],
      ['Time', formatTime(exec.created_at)],
      ['Latency', formatLatency(exec.execution_time_ms)],
   ];
   
   body.innerHTML = `
      <div class="translated-summary">
         <strong>📖 What happened:</strong><br>
         ${translation}
      </div>
      
      <div class="detail-section">
         <div class="detail-section-title">Execution Metadata</div>
         ${detailFields.map(([k, v]) => `
            <div class="detail-field">
               <span class="detail-key">${k}</span>
               <span class="detail-value">${escapeHtml(String(v))}</span>
            </div>`).join('')}
      </div>
      
      <div class="detail-section">
         <div class="detail-section-title">Action</div>
         <div class="detail-json">${escapeHtml(exec.action || '—')}</div>
      </div>
      
      ${exec.result ? `
         <div class="detail-section">
            <div class="detail-section-title">Result (Translated)</div>
            ${renderTranslatedResult(exec.result)}
         </div>` : ''}
      
      ${exec.skill ? `
         <div class="detail-section">
            <div class="detail-section-title">Persona Skill</div>
            <div class="detail-json">${escapeHtml(exec.skill)}</div>
         </div>` : ''}
   `;
   
   openModal();
}

function showPersonaDetail(persona) {
   const title = document.getElementById('modal-title');
   const body = document.getElementById('modal-body');
   
   title.textContent = `Persona: ${persona.name}`;
   
   const translation = translatePersona(persona);
   
   body.innerHTML = `
      <div class="translated-summary">
         <strong>📖 Who is this:</strong><br>
         ${translation}
      </div>
      
      <div class="detail-section">
         <div class="detail-section-title">Configuration</div>
         ${[
            ['Name', persona.name],
            ['Base Model', persona.base_model],
            ['Node', persona.node],
            ['Domain', persona.project_domain],
            ['Type', persona.is_synthetic ? '🧪 Synthetic (AI-generated)' : '📦 Native (from SKILL.md)'],
            ['Executions', persona.execution_count],
            ['Avg Latency', formatLatency(Math.round(parseFloat(persona.avg_exec_ms) || 0))],
            ['Created', formatTime(persona.created_at)],
            ['Last Used', formatTime(persona.last_used_at)],
         ].map(([k, v]) => `
            <div class="detail-field">
               <span class="detail-key">${k}</span>
               <span class="detail-value">${escapeHtml(String(v || '—'))}</span>
            </div>`).join('')}
      </div>
      
      <div class="detail-section">
         <div class="detail-section-title">Skill (Full System Prompt)</div>
         <div class="detail-json">${escapeHtml(persona.skill || 'No skill defined')}</div>
      </div>
   `;
   
   openModal();
}

// ── JSON Translation Engine ─────────────────────────────────────────────────

/**
 * Translates a raw execution record into a human-readable sentence.
 */
function translateExecution(exec) {
   const persona = exec.persona_name || 'Unknown';
   const node = friendlyNode(exec.node);
   const latency = formatLatency(exec.execution_time_ms);
   const action = exec.action || '';
   
   // Detect the action type from content
   if (action.startsWith('write_file') || action.includes('write_file')) {
      const pathMatch = action.match(/write_file\s+(\S+)/);
      const filePath = pathMatch ? pathMatch[1] : 'a file';
      return `The <strong>${persona}</strong> persona wrote to <strong>${escapeHtml(filePath)}</strong> on ${node}. Took ${latency}.`;
   }
   
   if (action.startsWith('read_file') || action.includes('cat ') || action.includes('read_file')) {
      const pathMatch = action.match(/(?:cat|read_file)\s+(\S+)/);
      const filePath = pathMatch ? pathMatch[1] : 'a file';
      return `The <strong>${persona}</strong> persona read <strong>${escapeHtml(filePath)}</strong> on ${node}. Took ${latency}.`;
   }
   
   if (action.includes('list_dir') || action.includes('ls ')) {
      return `The <strong>${persona}</strong> persona listed directory contents on ${node}. Took ${latency}.`;
   }
   
   if (action.includes('run_bash') || action.includes('bash -c')) {
      const cmdMatch = action.match(/(?:run_bash|bash -c)\s+['"]?(.{0,60})/);
      const cmd = cmdMatch ? cmdMatch[1].replace(/['"]$/, '') : 'a command';
      return `The <strong>${persona}</strong> persona executed a shell command (<code>${escapeHtml(cmd)}…</code>) on ${node}. Took ${latency}.`;
   }
   
   // Generic fallback
   return `The <strong>${persona}</strong> persona performed: "<em>${escapeHtml(truncate(action, 120))}</em>" on ${node}. Took ${latency}.`;
}

/**
 * Translates a persona record into a human-readable description.
 */
function translatePersona(persona) {
   const type = persona.is_synthetic ? 'AI-synthesized' : 'native skill-based';
   const node = friendlyNode(persona.node);
   const domain = persona.project_domain || 'general';
   const execCount = parseInt(persona.execution_count) || 0;
   
   let description = `<strong>${persona.name}</strong> is a ${type} persona running on ${node} `;
   description += `using the <strong>${persona.base_model}</strong> model. `;
   description += `It specializes in the <strong>${domain}</strong> domain`;
   
   if (execCount > 0) {
      const avg = Math.round(parseFloat(persona.avg_exec_ms) || 0);
      description += ` and has executed <strong>${execCount}</strong> task${execCount !== 1 ? 's' : ''} `;
      description += `with an average latency of <strong>${formatLatency(avg)}</strong>`;
   }
   
   description += '.';
   return description;
}

/**
 * Renders the result field — attempts to parse JSON and translate it,
 * otherwise renders as plaintext.
 */
function renderTranslatedResult(result) {
   if (!result) return '<div class="detail-json">No result data</div>';
   
   // Try to parse as JSON
   let parsed = null;
   try {
      parsed = JSON.parse(result);
   } catch (e) {
      // Not JSON, render as text
   }
   
   if (parsed && typeof parsed === 'object') {
      const summary = translateResultObject(parsed);
      return `
         <div class="translated-summary" style="margin-bottom: var(--space-sm);">
            ${summary}
         </div>
         <div class="detail-json">${syntaxHighlight(JSON.stringify(parsed, null, 2))}</div>
      `;
   }
   
   // Plain text result — check if it might contain embedded JSON
   const jsonBlocks = extractJsonBlocks(result);
   if (jsonBlocks.length > 0) {
      let html = '';
      for (const block of jsonBlocks) {
         try {
            const obj = JSON.parse(block);
            const summary = translateResultObject(obj);
            html += `
               <div class="translated-summary" style="margin-bottom: var(--space-sm);">
                  ${summary}
               </div>
               <div class="detail-json">${syntaxHighlight(JSON.stringify(obj, null, 2))}</div>
            `;
         } catch (e) {
            html += `<div class="detail-json">${escapeHtml(block)}</div>`;
         }
      }
      // Show non-JSON portions too
      const nonJson = result;
      if (nonJson.trim().length > jsonBlocks.join('').length + 10) {
         html += `<div class="detail-json" style="margin-top: var(--space-sm);">${escapeHtml(result)}</div>`;
      }
      return html;
   }
   
   return `<div class="detail-json">${escapeHtml(result)}</div>`;
}

/**
 * Translates a parsed JSON result object into a human-readable explanation.
 */
function translateResultObject(obj) {
   const parts = [];
   
   if (obj.stdout !== undefined) {
      const preview = truncate(String(obj.stdout), 100);
      parts.push(`<strong>Output:</strong> <code>${escapeHtml(preview)}</code>`);
   }
   if (obj.stderr && obj.stderr.trim()) {
      parts.push(`<strong>⚠️ Errors:</strong> <code>${escapeHtml(truncate(obj.stderr, 80))}</code>`);
   }
   if (obj.content !== undefined) {
      const preview = truncate(String(obj.content), 150);
      parts.push(`<strong>File content</strong> (${obj.content.length} chars): <code>${escapeHtml(preview)}</code>`);
   }
   if (obj.success === true) {
      parts.push('<strong>✅ Operation succeeded</strong>');
   }
   if (obj.success === false) {
      parts.push('<strong>❌ Operation failed</strong>');
   }
   if (obj.error) {
      parts.push(`<strong>❌ Error:</strong> ${escapeHtml(obj.error)}`);
   }
   if (obj.files) {
      const fileList = Array.isArray(obj.files) ? obj.files : [];
      parts.push(`<strong>📁 ${fileList.length} items</strong>: ${fileList.slice(0, 5).map(f => `<code>${escapeHtml(f)}</code>`).join(', ')}${fileList.length > 5 ? ` +${fileList.length - 5} more` : ''}`);
   }
   if (obj.status) {
      parts.push(`<strong>Status:</strong> ${escapeHtml(String(obj.status))}`);
   }
   if (obj.reasoning) {
      parts.push(`<strong>Reasoning:</strong> ${escapeHtml(obj.reasoning)}`);
   }
   
   // Fallback for unrecognized structures
   if (parts.length === 0) {
      const keys = Object.keys(obj);
      parts.push(`JSON object with keys: ${keys.map(k => `<code>${escapeHtml(k)}</code>`).join(', ')}`);
   }
   
   return parts.join('<br>');
}

/**
 * Extract JSON blocks from mixed text content.
 */
function extractJsonBlocks(text) {
   const blocks = [];
   let depth = 0, start = -1;
   for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') { if (depth === 0) start = i; depth++; }
      else if (text[i] === '}') { depth--; if (depth === 0 && start !== -1) { blocks.push(text.slice(start, i + 1)); start = -1; } }
   }
   return blocks;
}

/**
 * Syntax-highlight JSON for display.
 */
function syntaxHighlight(json) {
   return json.replace(/("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, 
      (match) => {
         let cls = 'json-number';
         if (/^"/.test(match)) {
            cls = /:$/.test(match) ? 'json-key' : 'json-string';
         } else if (/true|false/.test(match)) {
            cls = 'json-bool';
         } else if (/null/.test(match)) {
            cls = 'json-null';
         }
         return `<span class="${cls}">${match}</span>`;
   });
}

// ── Tabs ────────────────────────────────────────────────────────────────────
function initTabs() {
   document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
         document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
         document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
         tab.classList.add('active');
         document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
      });
   });
}

// ── Modal ───────────────────────────────────────────────────────────────────
function initModal() {
   const overlay = document.getElementById('modal-overlay');
   document.getElementById('modal-close').addEventListener('click', closeModal);
   overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
   });
   document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
   });
}

function openModal() {
   document.getElementById('modal-overlay').classList.add('open');
   document.body.style.overflow = 'hidden';
}

function closeModal() {
   document.getElementById('modal-overlay').classList.remove('open');
   document.body.style.overflow = '';
}

// ── Utilities ───────────────────────────────────────────────────────────────
function formatTime(ts) {
   if (!ts) return '—';
   const d = new Date(ts + (ts.includes('Z') || ts.includes('+') ? '' : 'Z'));
   const now = new Date();
   const diffMs = now - d;
   
   if (diffMs < 60000) return `${Math.round(diffMs / 1000)}s ago`;
   if (diffMs < 3600000) return `${Math.round(diffMs / 60000)}m ago`;
   if (diffMs < 86400000) return `${Math.round(diffMs / 3600000)}h ago`;
   
   return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatLatency(ms) {
   if (ms == null) return '—';
   if (ms >= 10000) return `${(ms / 1000).toFixed(1)}s`;
   if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
   return `${ms}ms`;
}

function getLatencyClass(ms) {
   if (ms == null) return '';
   if (ms < 3000) return 'latency-fast';
   if (ms < 8000) return 'latency-medium';
   return 'latency-slow';
}

function friendlyNode(node) {
   if (!node) return 'unknown node';
   const map = {
      'kruschdev': 'kruschdev (RTX 3060)',
      'kruschdev_router': 'kruschdev GTX 970 (Router)',
      'kruschdev_director': 'kruschdev RTX 3060 (Director)',
      'kruschgame': 'kruschgame (RTX 3050)',
   };
   return map[node] || node;
}

function truncate(str, len) {
   if (!str) return '';
   return str.length > len ? str.slice(0, len) + '…' : str;
}

function escapeHtml(str) {
   if (!str) return '';
   const div = document.createElement('div');
   div.textContent = str;
   return div.innerHTML;
}

function setLiveStatus(online) {
   const dot = document.getElementById('live-indicator');
   const text = document.getElementById('live-text');
   if (online) {
      dot.classList.add('online');
      text.textContent = 'Live';
   } else {
      dot.classList.remove('online');
      text.textContent = 'Offline';
   }
}

function animateValue(elemId, targetValue) {
   const el = document.getElementById(elemId);
   const current = parseInt(el.textContent) || 0;
   if (current === targetValue) { el.textContent = targetValue; return; }
   
   const diff = targetValue - current;
   const steps = Math.min(Math.abs(diff), 20);
   const stepSize = diff / steps;
   let frame = 0;
   
   const animate = () => {
      frame++;
      if (frame >= steps) { el.textContent = targetValue; return; }
      el.textContent = Math.round(current + stepSize * frame);
      requestAnimationFrame(animate);
   };
   requestAnimationFrame(animate);
}

// CSS keyframes for spin (injected once)
if (!document.getElementById('monitor-keyframes')) {
   const style = document.createElement('style');
   style.id = 'monitor-keyframes';
   style.textContent = `@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
   document.head.appendChild(style);
}
