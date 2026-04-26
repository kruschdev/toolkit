import { exec } from 'child_process';
import util from 'util';
import { validateCommand, validateRemoteCommand, getTimeout, getAllowlistDescription } from '../allowlist.js';

const execAsync = util.promisify(exec);

export const schema = {
    name: "run_safe",
    description: `Execute a pre-approved read-only shell command for monitoring and inspection. Only commands matching the allowlist will execute — all others are rejected. Use for checking service health, viewing container logs, checking git status, and monitoring system resources.\n\nAllowed commands:\n${getAllowlistDescription()}`,
    parameters: { 
        type: "object", 
        properties: { 
            command: { type: "string", description: "The exact shell command to run (must match allowlist)" },
            node: { type: "string", enum: ["kruschserv", "kruschgame", "kruschdev", "krmac", "kr1yoga"], description: "Optional: Target node for remote SSH execution. If omitted, runs on the persona's current node." }
        }, 
        required: ["command"] 
    }
};

export async function execute(args, { isRemote: personaIsRemote, node: personaNode, remoteCmd: personaRemoteCmd, _cpu_core }) {
    const cmd = (args.command || '').trim();
    const targetNode = args.node || personaNode;
    const isExplicitRemote = !!args.node;
    const isRemote = personaIsRemote || isExplicitRemote;
    
    let rule;
    
    // Explicit remote (via tool param) always uses validateRemoteCommand
    // Implicit remote (via persona node) uses it too
    if (isRemote) {
        rule = validateRemoteCommand(targetNode, cmd);
    } else {
        rule = validateCommand(cmd);
    }
    
    if (!rule) {
        return { error: `Command rejected by allowlist: "${cmd.slice(0, 80)}". Only pre-approved read-only commands are allowed.` };
    }
    
    const cmdTimeout = getTimeout(rule);
    
    // If we're bridging local-to-remote, we need to construct our own SSH command
    let finalCmd = cmd;
    if (isExplicitRemote) {
        finalCmd = `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${targetNode} "${cmd.replace(/"/g, '\\"')}"`;
    } else if (personaIsRemote) {
        finalCmd = personaRemoteCmd(cmd);
    }
    
    if (_cpu_core !== undefined && _cpu_core !== null) {
        finalCmd = `taskset -c ${_cpu_core} ${finalCmd}`;
    }
    
    const { stdout, stderr } = await execAsync(finalCmd, { 
        shell: '/bin/bash', 
        timeout: cmdTimeout,
        maxBuffer: 1024 * 512  // 512KB max output
    });
    
    return { 
        output: stdout.slice(0, 8_000), 
        stderr: stderr ? stderr.slice(0, 2_000) : undefined,
        rule: rule.name 
    };
}
