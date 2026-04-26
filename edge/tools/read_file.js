import fs from 'fs/promises';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export const schema = {
    name: "read_file",
    description: "Read contents of a file at the given path.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Absolute file path" } }, required: ["path"] }
};

export async function execute(args, { isRemote, remoteCmd }) {
    if (isRemote) {
        try {
            const { stdout } = await execAsync(remoteCmd(`cat ${args.path}`), { shell: '/bin/bash' });
            return { content: stdout.slice(0, 10_000) };
        } catch(e) {
            return { error: `File ${args.path} not found or access denied on remote node.` };
        }
    }
    try {
        const content = await fs.readFile(args.path, 'utf8');
        return { content: content.slice(0, 10_000) };
    } catch(e) {
        return { error: `File ${args.path} not found locally.` };
    }
}
