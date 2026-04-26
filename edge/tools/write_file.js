import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export const schema = {
    name: "write_file",
    description: "Write content to a file. Creates parent dirs. Overwrites if it exists. To create an empty directory, end the path with a trailing slash (e.g. '/path/to/dir/').",
    parameters: { type: "object", properties: { path: { type: "string", description: "Absolute file path" }, content: { type: "string", description: "File content to write (can be empty for directories)" } }, required: ["path", "content"] }
};

export async function execute(args, { isRemote, node }) {
    const isDir = args.path.endsWith('/');

    if (isRemote) {
        if (isDir) {
            await execAsync(`ssh -n -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${node} "mkdir -p '${args.path}'"`);
            return { success: true };
        }
        const dest = `/tmp/chrysalis_write_${Date.now()}`;
        await fs.writeFile(dest, args.content);
        await execAsync(`ssh -n -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${node} "mkdir -p \\"$(dirname '${args.path}')\\""`);
        await execAsync(`scp -o ConnectTimeout=10 -o StrictHostKeyChecking=no "${dest}" "${node}:${args.path}"`);
        await fs.unlink(dest).catch(() => { });
        return { success: true };
    }

    if (isDir) {
        await fs.mkdir(args.path, { recursive: true });
        return { success: true };
    }

    await fs.mkdir(path.dirname(args.path), { recursive: true });
    await fs.writeFile(args.path, args.content);
    return { success: true };
}
