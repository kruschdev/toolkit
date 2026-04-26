import { embedText, query } from '../db-pg.js';

export const schema = {
    name: "search_rules",
    description: "Search the homelab rulebook and architecture guidelines. Use this tool when you need to know testing policies, network rules, setup commands, or general practices. Provide a concise semantic search query.",
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "The topic to search for (e.g. 'how should I handle docker updates' or 'rsyncing database volumes')"
            }
        },
        required: ["query"]
    }
};

export async function execute(args) {
    if (!args.query) return "Error: query parameter is required.";

    try {
        const embeddingStr = await embedText(args.query);
        const res = await query(`
            SELECT document_name, header_path, content, 
                   1 - (embedding <=> $1::vector) AS similarity
            FROM agent_knowledge_vectors
            ORDER BY embedding <=> $1::vector ASC
            LIMIT 3
        `, [embeddingStr]);

        if (res.rowCount === 0) {
            return "No relevant rules found.";
        }

        const formattedResults = res.rows.map(r => 
            `--- [Source: ${r.document_name} > ${r.header_path}] ---\n${r.content}`
        ).join('\n\n');

        return formattedResults;
    } catch (err) {
        return `Error searching rules: ${err.message}`;
    }
}
