import { addMemory } from '../../brain/memory_controller.js';

export const schema = {
    name: "write_shared_memory",
    description: "Write an urgent note, design decision, or path variable into the shared Project Scratchpad so all other active personas can read it. It acts as a global Hive Mind for the current project context.",
    parameters: {
        type: "object",
        properties: {
            content: {
                type: "string",
                description: "The insight or note you want to broadcast to the swarm's working memory (e.g., 'Backend running on port 3000', 'Decided to use regex instead of parsing')."
            }
        },
        required: ["content"]
    }
};

export async function execute(args, context) {
    try {
        // Broadcast this note to the pseudo-persona 'PROJECT_HIVE' which is accessible globally
        await addMemory('PROJECT_HIVE', 'scratchpad', args.content, context.project || 'homelab');
        return { success: true, message: "Added to project scratchpad successfully." };
    } catch (err) {
        return { success: false, error: err.message };
    }
}
