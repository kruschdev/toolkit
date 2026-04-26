import fs from 'fs/promises';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export const schema = {
    name: "list_dir",
    description: "List contents of a directory.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Absolute directory path" } }, required: ["path"] }
};

export async function execute(args, { isRemote, remoteCmd }) {
    if (isRemote) {
        try {
            const { stdout } = await execAsync(remoteCmd(`ls -1 ${args.path}`), { shell: '/bin/bash' });
            return { files: stdout.split('\n').filter(Boolean) };
        } catch (e) {
            return { error: `Directory ${args.path} does not exist or access denied.` };
        }
    }
    try {
        const files = await fs.readdir(args.path);
        return { files };
    } catch (e) {
        return { error: `Directory ${args.path} does not exist.` };
    }
}
