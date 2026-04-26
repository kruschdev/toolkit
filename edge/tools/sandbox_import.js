import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export const schema = {
    name: "sandbox_import",
    description: "Initializes the Chrysalis sandbox on the data2 drive as a pristine git clone of the homelab monorepo, isolating execution constraints.",
    parameters: {
        type: "object",
        properties: {
            project: { type: "string", description: "The exact directory name of the project subfolder to import." }
        },
        required: ["project"]
    }
};

export async function execute(args, { isRemote, node, remoteCmd }) {
    let { project } = args;
    if (!project || project.includes("..")) {
        return { error: "Invalid project name. Could not parse subfolder." };
    }
    
    // Smooth over the Swarm's absolute path formatting instruction
    if (project.includes("/")) {
        const parts = project.split('/');
        project = parts[parts.length - 1]; 
    }
    
    if (!project || project.length === 0) return { error: "Invalid project name extracted." };
    // Clone homelab to /mnt/data2/chrysalis if it doesn't exist. Otherwise, reset strictly to master.
    const setupRepo = `if [ ! -d "/mnt/data2/chrysalis/.git" ]; then sudo mkdir -p /mnt/data2/chrysalis && sudo chown -R kruschdev:kruschdev /mnt/data2/chrysalis && git clone /home/kruschdev/homelab /mnt/data2/chrysalis; else cd /mnt/data2/chrysalis && git fetch origin && git reset --hard origin/master && git clean -fd; fi`;

    try {
        const { stdout, stderr } = await execAsync(setupRepo, { timeout: 120000 });
        return { success: true, output: `[Sandbox] /mnt/data2/chrysalis is now a pristine mirror. Focus on projects/${project}.`, stderr: stderr ? stderr.slice(0, 1000) : '' };
    } catch (err) {
        return { error: `Sandbox import/clone failed: ${err.message}` };
    }
}
