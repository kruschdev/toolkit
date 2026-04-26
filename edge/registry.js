import { query, embedText } from './db-pg.js';
import { cachePersonas, loadCachedPersonas } from './registry-cache.js';

/**
 * Builds the persona registry from the PostgreSQL database.
 * If a search query is provided, it uses pgvector cosine similarity to prioritize the best matches.
 * Falls back to local SQLite cache when Postgres is unreachable.
 * 
 * @param {string} rootDir - Ignored. Maintained for compat.
 * @param {string} [searchQuery] - Task string to vector search against
 * @returns {Promise<Map<string, object>>} Map of persona name -> spec
 */
export async function buildRegistry(rootDir, searchQuery) {
  const registry = new Map();
  
  try {
      let rows;
      if (searchQuery) {
          // Compute embedding of the incoming task via Gemini/Ollama
          console.log(`[Registry] Generating task vector for: "${searchQuery.slice(0, 30)}..."`);
          const taskVector = await embedText(searchQuery);
          
          // Use pgvector cosine distance (<=>) to order by relevance
          const res = await query(`
             SELECT name, base_model as base, node, skill, project_domain as project, is_synthetic, tools 
             FROM personas 
             ORDER BY embedding <=> $1
             LIMIT 15
          `, [taskVector]);
          rows = res.rows;
      } else {
          const res = await query(`
             SELECT name, base_model as base, node, skill, project_domain as project, is_synthetic, tools 
             FROM personas
          `);
          rows = res.rows;
      }
      
      for (const row of rows) {
          const spec = {
              name: row.name,
              base: row.base,
              node: row.node,
              skill: row.skill,
              project: row.project,
              is_synthetic: row.is_synthetic,
              tools: row.tools || []
          };
          console.log(`[Registry] Loaded DB persona: ${spec.name} (synthetic: ${spec.is_synthetic})`);
          registry.set(spec.name, spec);
      }
      
      // Write-through: cache to local SQLite for offline resilience
      await cachePersonas(rows);
      
  } catch (err) {
      console.error(`[Registry Error] Failed to load from PostgreSQL: ${err.message}`);
      console.log(`[Registry] Attempting SQLite fallback...`);
      return await loadCachedPersonas();
  }
  
  return registry;
}
