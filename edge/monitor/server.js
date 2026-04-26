/**
 * @module edge/monitor/server
 * Chrysalis Edge Swarm — Monitoring API & Dashboard Server
 * 
 * Serves the real-time monitoring UI and provides REST endpoints
 * for execution logs, persona registry, session replay, and node health.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db-pg.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.MONITOR_PORT || 3847;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ──────────────────────────────────────────────────────────────

/** GET /api/stats — Aggregate dashboard stats */
app.get('/api/stats', async (req, res) => {
   try {
      const [personas, logs, sessions, avgTime, nodeBreakdown] = await Promise.all([
         query('SELECT count(*) as count FROM personas'),
         query('SELECT count(*) as count FROM execution_logs'),
         query('SELECT count(DISTINCT session_id) as count FROM execution_logs'),
         query('SELECT COALESCE(AVG(execution_time_ms), 0) as avg_ms FROM execution_logs'),
         query(`SELECT p.node, count(e.id) as executions, 
                COALESCE(AVG(e.execution_time_ms), 0) as avg_ms
                FROM personas p LEFT JOIN execution_logs e ON p.name = e.persona_name
                GROUP BY p.node ORDER BY executions DESC`)
      ]);
      res.json({
         totalPersonas: parseInt(personas.rows[0].count),
         totalExecutions: parseInt(logs.rows[0].count),
         totalSessions: parseInt(sessions.rows[0].count),
         avgExecutionMs: Math.round(parseFloat(avgTime.rows[0].avg_ms)),
         nodeBreakdown: nodeBreakdown.rows
      });
   } catch (err) {
      res.status(500).json({ error: err.message });
   }
});

/** GET /api/personas — Full persona registry */
app.get('/api/personas', async (req, res) => {
   try {
      const result = await query(`
         SELECT p.name, p.base_model, p.node, p.skill, p.project_domain, 
                p.is_synthetic, p.created_at, p.last_used_at,
                count(e.id) as execution_count,
                COALESCE(AVG(e.execution_time_ms), 0) as avg_exec_ms
         FROM personas p
         LEFT JOIN execution_logs e ON p.name = e.persona_name
         GROUP BY p.id ORDER BY p.name
      `);
      res.json(result.rows);
   } catch (err) {
      res.status(500).json({ error: err.message });
   }
});

/** GET /api/executions — Recent execution logs with optional filters */
app.get('/api/executions', async (req, res) => {
   try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const sessionFilter = req.query.session_id;
      const personaFilter = req.query.persona;
      
      let sql = `SELECT e.id, e.session_id, e.persona_name, e.action, e.result,
                        e.execution_time_ms, e.created_at, p.base_model, p.node, p.skill
                 FROM execution_logs e 
                 LEFT JOIN personas p ON e.persona_name = p.name
                 WHERE 1=1`;
      const params = [];
      
      if (sessionFilter) {
         params.push(sessionFilter);
         sql += ` AND e.session_id = $${params.length}`;
      }
      if (personaFilter) {
         params.push(personaFilter);
         sql += ` AND e.persona_name = $${params.length}`;
      }
      
      params.push(limit);
      sql += ` ORDER BY e.created_at DESC LIMIT $${params.length}`;
      
      const result = await query(sql, params);
      res.json(result.rows);
   } catch (err) {
      res.status(500).json({ error: err.message });
   }
});

/** GET /api/sessions — Session summaries */
app.get('/api/sessions', async (req, res) => {
   try {
      const result = await query(`
         SELECT session_id, 
                MIN(created_at) as started_at,
                MAX(created_at) as ended_at,
                count(*) as step_count,
                COALESCE(SUM(execution_time_ms), 0) as total_ms,
                array_agg(DISTINCT persona_name) as personas_used
         FROM execution_logs 
         GROUP BY session_id
         ORDER BY started_at DESC
         LIMIT 20
      `);
      res.json(result.rows);
   } catch (err) {
      res.status(500).json({ error: err.message });
   }
});

/** GET /api/session/:id — Full session timeline (for replay) */
app.get('/api/session/:id', async (req, res) => {
   try {
      const result = await query(`
         SELECT e.id, e.persona_name, e.action, e.result, e.execution_time_ms, 
                e.created_at, p.base_model, p.node, p.skill, p.project_domain
         FROM execution_logs e
         LEFT JOIN personas p ON e.persona_name = p.name
         WHERE e.session_id = $1
         ORDER BY e.created_at ASC
      `, [req.params.id]);
      res.json(result.rows);
   } catch (err) {
      res.status(500).json({ error: err.message });
   }
});

/** GET /api/health — Node health check (live Ollama ping) */
app.get('/api/health', async (req, res) => {
   const nodes = {
      kruschdev_router: 'http://localhost:11434',
      kruschdev_director: 'http://localhost:11434',
      kruschgame: 'http://10.0.0.19:11434'
   };
   
   const results = {};
   await Promise.all(Object.entries(nodes).map(async ([name, url]) => {
      try {
         const controller = new AbortController();
         const timeout = setTimeout(() => controller.abort(), 5000);
         const resp = await fetch(`${url}/api/tags`, { signal: controller.signal });
         clearTimeout(timeout);
         const data = await resp.json();
         results[name] = {
            status: 'online',
            url,
            models: (data.models || []).map(m => ({ name: m.name, size: m.size }))
         };
      } catch (err) {
         results[name] = { status: 'offline', url, error: err.message };
      }
   }));
   res.json(results);
});

/** GET /api/dag-plans — Recent DAG execution plans with Mermaid rendering */
app.get('/api/dag-plans', async (req, res) => {
   try {
      const result = await query(`
         SELECT id, session_id, steps, status, created_at, completed_at
         FROM dag_plans
         ORDER BY created_at DESC
         LIMIT 20
      `);
      
      // Generate Mermaid markup for each DAG
      const plans = result.rows.map(plan => {
         const steps = typeof plan.steps === 'string' ? JSON.parse(plan.steps) : plan.steps;
         let mermaid = 'graph TD\n';
         for (const step of steps) {
            const label = `${step.persona}\\n${(step.action || '').slice(0, 40)}`;
            const safeLabel = label.replace(/"/g, "'");
            mermaid += `    ${step.id}["${safeLabel}"]\n`;
            if (step.depends_on && step.depends_on.length > 0) {
               for (const dep of step.depends_on) {
                  mermaid += `    ${dep} --> ${step.id}\n`;
               }
            }
         }
         // Style nodes by status
         if (plan.status === 'completed') {
            for (const step of steps) {
               mermaid += `    style ${step.id} fill:#065f46,stroke:#6ee7b7,color:#d1fae5\n`;
            }
         } else if (plan.status === 'running') {
            mermaid += `    classDef running fill:#92400e,stroke:#fbbf24,color:#fef3c7\n`;
         }
         
         return { ...plan, steps, mermaid };
      });
      
      res.json(plans);
   } catch (err) {
      res.status(500).json({ error: err.message });
   }
});

/** GET /api/error-patterns — Self-healing error pattern memory */
app.get('/api/error-patterns', async (req, res) => {
   try {
      const result = await query(`
         SELECT error_signature, persona_name, resolution, times_applied, 
                last_seen_at, created_at
         FROM error_patterns
         ORDER BY times_applied DESC, last_seen_at DESC
         LIMIT 50
      `);
      res.json(result.rows);
   } catch (err) {
      res.status(500).json({ error: err.message });
   }
});

/** GET /api/persona-stats — Persona usage analytics (from persona_stats view) */
app.get('/api/persona-stats', async (req, res) => {
   try {
      const result = await query('SELECT * FROM persona_stats');
      // Compute summary totals for the dashboard card
      const rows = result.rows;
      const totalCalls = rows.reduce((sum, r) => sum + parseInt(r.call_count), 0);
      const activePersonas = rows.filter(r => parseInt(r.call_count) > 0).length;
      const overallSuccessRate = totalCalls > 0
         ? (100 * rows.reduce((sum, r) => sum + (parseInt(r.call_count) - parseInt(r.error_count)), 0) / totalCalls).toFixed(1)
         : 0;
      const topPerformers = rows.slice(0, 5);
      const neverUsed = rows.filter(r => parseInt(r.call_count) === 0).map(r => r.name);
      res.json({ summary: { totalCalls, activePersonas, totalPersonas: rows.length, overallSuccessRate }, topPerformers, neverUsed, all: rows });
   } catch (err) {
      res.status(500).json({ error: err.message });
   }
});

/** GET /api/benchmark — Latest benchmark results */
app.get('/api/benchmark', async (req, res) => {
   try {
      const data = await import('node:fs/promises').then(fs => 
         fs.default.readFile('/tmp/chrysalis_benchmark_results.json', 'utf8')
      );
      res.json(JSON.parse(data));
   } catch (err) {
      res.json({ error: 'No benchmark results found. Run: bash scripts/benchmark_swarm.sh' });
   }
});

// ── Serve SPA ───────────────────────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
   res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
   console.log(`\n🔍 Chrysalis Monitor → http://localhost:${PORT}\n`);
});
