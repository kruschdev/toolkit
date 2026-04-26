import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export const schema = {
    name: "sandbox_exec",
    description: "Safely runs shell commands inside an isolated active Chrysalis Sandbox Docker container.",
    parameters: {
        type: "object",
        properties: {
            project: { type: "string", description: "Project subfolder name, e.g., 'caren'" },
            command: { type: "string", description: "The shell command to run in the container" }
        },
        required: ["project", "command"]
    }
};

export async function execute(args, { isRemote, node, remoteCmd, _cpu_core }) {
    const { project, command } = args;
    if (!project || project.includes("..") || project.includes("/")) {
        return { error: "Invalid project name. Must be a flat subfolder string." };
    }
    
    const containerName = `sandbox-${project}`;
    const safeCommand = command.replace(/"/g, '\\"');
    let cmdToRun = `docker exec ${containerName} sh -c "${safeCommand}"`;
    
    if (_cpu_core !== undefined && _cpu_core !== null) {
        cmdToRun = `taskset -c ${_cpu_core} ${cmdToRun}`;
    }
    
    try {
        const { stdout, stderr } = await execAsync(cmdToRun, { timeout: 45000 });
        return { success: true, output: stdout.slice(0, 4000), stderr: stderr.slice(0, 2000) };
    } catch (err) {
        return { error: `Sandbox exec failed: ${err.message}` };
    }
}
