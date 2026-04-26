import fs from 'fs/promises';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export const schema = {
    name: "make_dir",
    description: "Create a directory on the filesystem. Automatically creates parent directories.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Absolute directory path" } }, required: ["path"] }
};

export async function execute(args, { isRemote, node }) {
    if (isRemote) {
        await execAsync(`ssh -n -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${node} "mkdir -p '${args.path}'"`);
        return { success: true };
    }
    
    await fs.mkdir(args.path, { recursive: true });
    return { success: true };
}
