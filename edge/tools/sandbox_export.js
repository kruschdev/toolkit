import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export const schema = {
    name: "sandbox_export",
    description: "Rsyncs fully tested code from the isolated Chrysalis data2 sandbox back into the primary homelab monorepo for human review.",
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
    
    const src = `/home/kruschdev/homelab/projects/${project}/`;
    const dest = `/mnt/data2/chrysalis/projects/${project}`;
    const cmdToRun = `mkdir -p ${src} && rsync -a --delete ${dest}/ ${src}`;
    
    try {
        const { stdout, stderr } = await execAsync(cmdToRun, { timeout: 45000 });
        return { success: true, output: `[Sandbox Exp] Successfully promoted ${project} changes to ${src}. Run 'git status' in homelab to review.`, stderr: stderr.slice(0, 2000) };
    } catch (err) {
        return { error: `Sandbox export failed: ${err.message}` };
    }
}
