import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export const schema = {
    name: "sandbox_stop",
    description: "Kills an active isolated sandbox Docker container and frees up hardware resources.",
    parameters: {
        type: "object",
        properties: {
            project: { type: "string", description: "Project subfolder name, e.g., 'caren'" }
        },
        required: ["project"]
    }
};

export async function execute(args, { isRemote, node, remoteCmd }) {
    const { project } = args;
    if (!project || project.includes("..") || project.includes("/")) {
        return { error: "Invalid project name. Must be a flat subfolder string." };
    }
    
    const containerName = `sandbox-${project}`;
    const cmdToRun = `docker rm -f ${containerName}`;
    
    try {
        const { stdout, stderr } = await execAsync(cmdToRun, { timeout: 45000 });
        return { success: true, output: stdout.slice(0, 4000), stderr: stderr.slice(0, 2000) };
    } catch (err) {
        return { error: `Sandbox stop failed: ${err.message}` };
    }
}
