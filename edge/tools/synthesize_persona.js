import { synthesizePersonaBlueprint } from '../factory.js';

export const schema = {
    name: "synthesize_persona",
    description: "Synthesize a new persona blueprint (JSON) based on a task description. Use this when the Director identifies a missing skill in the swarm.",
    parameters: {
        type: "object",
        properties: {
            name: { type: "string", description: "The name of the new persona (e.g., 'security-auditor')" },
            domain: { type: "string", description: "The project domain (default: 'homelab')" }
        },
        required: ["name"]
    }
};

export async function execute(args) {
    try {
        const spec = await synthesizePersonaBlueprint(args.name, args.domain || 'homelab');
        return { success: true, blueprint: spec };
    } catch (e) {
        return { error: `Synthesis failed: ${e.message}` };
    }
}
