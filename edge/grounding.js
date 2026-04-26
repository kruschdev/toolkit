/**
 * @module grounding
 * Environment Context Resolver.
 * Aggregates runtime project architecture, rules, SQLite scratchpad memory, 
 * and explicit MCP tool structures dynamically into the System Prompts.
 */

import readline from 'node:readline';

/** Reusable readline instance — prevents interface leaks across multiple HitL checks */
let _rl = null;
function getRl() {
    if (!_rl) {
        _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        _rl.on('close', () => { _rl = null; });
    }
    return _rl;
}

export async function checkHitLGate(personaName, proposedAction) {
  console.log(`\n[HitL Gate] Persona: ${personaName}`);
  console.log(`[HitL Gate] Proposed Action: ${proposedAction}`);
  
  if (!process.stdout.isTTY || process.env.AUTO_APPROVE_SWARM === 'true') {
     console.log(`[HitL Gate] AUTO-APPROVED (headless).`);
     return true;
  }

  const rl = getRl();

  return new Promise((resolve) => {
    rl.question('Approve execution? Type /gyes to approve, anything else to reject: ', (answer) => {
      const approved = answer.trim() === '/gyes';
      if (!approved) console.log(`[HitL Gate] REJECTED.`);
      else console.log(`[HitL Gate] APPROVED.`);
      resolve(approved);
    });
  });
}
