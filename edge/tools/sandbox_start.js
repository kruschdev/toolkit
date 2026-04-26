import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export const schema = {
    name: "sandbox_start",
    description: "Spins up an isolated Docker container binding the entire chrysalis project workspace on data2.",
    parameters: {
        type: "object",
        properties: {
            project: { type: "string", description: "Project subfolder name, e.g., 'caren'" },
            image: { type: "string", description: "The exact docker image to use for the sandbox, e.g. 'node:22'" }
        },
        required: ["project", "image"]
    }
};

export async function execute(args, { isRemote, node, remoteCmd }) {
    const { project, image } = args;
    if (!project || project.includes("..") || project.includes("/")) {
        return { error: "Invalid project name. Must be a flat subfolder string." };
    }
    
    const containerName = `sandbox-${project}`;
    
    // [Strict RAM Constraint] Only ONE sandbox project can run at a time to prevent CPU/RAM stutter
    const killAllSandboxes = `docker ps -a -q --filter "name=sandbox-" | xargs -r docker rm -f`;
    // Bind ENTIRE /mnt/data2/chrysalis so dependencies map locally natively
    const cmdToRun = `${killAllSandboxes} && docker run -d --rm --name ${containerName} --network host -v /mnt/data2/chrysalis:/chrysalis -w /chrysalis/projects/${project} ${image} tail -f /dev/null`;
    
    try {
        const { stdout, stderr } = await execAsync(cmdToRun, { timeout: 45000 });
        return { success: true, output: stdout.slice(0, 4000), stderr: stderr.slice(0, 2000) };
    } catch (err) {
        return { error: `Sandbox start failed: ${err.message}` };
    }
}
