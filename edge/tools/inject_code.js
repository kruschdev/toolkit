import fs from 'fs/promises';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export const schema = {
    name: "inject_code",
    description: "Surgically inject code into a file at a specific anchor point without destroying the rest of the file. Use this for edge workers to avoid overwriting large files.",
    parameters: { 
        type: "object", 
        properties: { 
            path: { type: "string", description: "Absolute file path" }, 
            target_anchor: { type: "string", description: "The exact 1-3 lines of text in the file to target (must be an EXACT substring match)" },
            action: { type: "string", enum: ["replace", "append_after", "append_before"], description: "How to inject the content relative to the anchor" },
            content: { type: "string", description: "The code payload to inject" } 
        }, 
        required: ["path", "target_anchor", "action", "content"] 
    }
};

export async function execute(args, { isRemote, node }) {
    let fileContent;
    if (isRemote) {
        try {
            const { stdout } = await execAsync(`ssh -n -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${node} "cat '${args.path}'"`);
            fileContent = stdout;
        } catch (e) {
            return { error: `File read failed or does not exist on remote node: ${e.message}` };
        }
    } else {
        try {
            fileContent = await fs.readFile(args.path, 'utf8');
        } catch (e) {
            return { error: `File read failed or does not exist locally: ${e.message}` };
        }
    }

    const anchorIndex = fileContent.indexOf(args.target_anchor);
    if (anchorIndex === -1) {
        return { error: `target_anchor not found in the file. Ensure you provide an EXACT substring match including any whitespace or indentation. Use read_file to check exact file lines first if needed.` };
    }

    // Guard against multiple matches by warning the model (though we blindly replace the first if not 'replace')
    const matchCount = fileContent.split(args.target_anchor).length - 1;
    if (matchCount > 1) {
        return { error: `target_anchor is ambiguous and matches ${matchCount} times in the file. Context is not unique enough. Add surrounding lines to the anchaor to make it unique.` };
    }

    let modifiedContent = '';
    
    if (args.action === 'replace') {
        modifiedContent = fileContent.replace(args.target_anchor, args.content);
    } else if (args.action === 'append_after') {
        modifiedContent = fileContent.slice(0, anchorIndex + args.target_anchor.length) + '\n' + args.content + fileContent.slice(anchorIndex + args.target_anchor.length);
    } else if (args.action === 'append_before') {
        modifiedContent = fileContent.slice(0, anchorIndex) + args.content + '\n' + fileContent.slice(anchorIndex);
    } else {
        return { error: `Invalid action specified. Must be one of: replace, append_after, append_before.` };
    }

    if (isRemote) {
        const dest = `/tmp/chrysalis_inject_${Date.now()}`;
        await fs.writeFile(dest, modifiedContent);
        await execAsync(`scp -o ConnectTimeout=10 -o StrictHostKeyChecking=no "${dest}" "${node}:${args.path}"`);
        await fs.unlink(dest).catch(() => { });
    } else {
        await fs.writeFile(args.path, modifiedContent);
    }

    return { 
        success: true, 
        message: `Successfully injected ${args.content.length} characters using ${args.action} at anchor. File saved.` 
    };
}
