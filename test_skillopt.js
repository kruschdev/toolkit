/**
 * @file test_skillopt.js
 * @description Comprehensive unit test suite for the SkillOpt-Lite optimizer module.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { applySkillPatch, proposeSkillEdits, runValidationGate } from './skillopt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempSkillPath = path.join(__dirname, 'temp_test_skill.md');

// Utility to reset the temporary test skill file
async function resetTempSkill() {
    const initialContent = `# Test Agent Skill
This is the root instruction page.

<!-- SLOW_UPDATE_START -->
CRITICAL SAFETY RULE: Never delete data from OS drives.
<!-- SLOW_UPDATE_END -->

## Standard Operational Procedures
1. Run diagnostic scans.
2. Complete health checks.
`;
    await fs.writeFile(tempSkillPath, initialContent, 'utf8');
    return initialContent;
}

// Clean up temporary files
async function cleanupTempFiles() {
    try {
        await fs.unlink(tempSkillPath);
    } catch {
        // Ignore if file doesn't exist
    }
}

async function testApplySkillPatch() {
    console.log("=== Running testApplySkillPatch ===");
    await resetTempSkill();

    const edits = [
        {
            op: 'append',
            content: '## Advanced Strategy\nAlways verify node credentials before SSH authorization.'
        },
        {
            op: 'insert_after',
            target: '1. Run diagnostic scans.',
            content: '   - Check cooling profiles.'
        },
        {
            op: 'replace',
            target: '2. Complete health checks.',
            content: '2. Complete health sweeps via SRE Loop.'
        },
        {
            op: 'delete',
            target: 'This is the root instruction page.'
        }
    ];

    const updatedContent = await applySkillPatch(tempSkillPath, edits);
    
    // Asserts
    if (!updatedContent.includes('## Advanced Strategy')) throw new Error('Append operation failed.');
    if (!updatedContent.includes('   - Check cooling profiles.')) throw new Error('Insert_after operation failed.');
    if (!updatedContent.includes('2. Complete health sweeps via SRE Loop.')) throw new Error('Replace operation failed.');
    if (updatedContent.includes('This is the root instruction page.')) throw new Error('Delete operation failed.');
    
    // Verify protected area shielding
    if (!updatedContent.includes('CRITICAL SAFETY RULE: Never delete data from OS drives.')) {
        throw new Error('catastrophic error: Protected slow-update area was erased or corrupted.');
    }

    console.log("✅ testApplySkillPatch PASSED.");
}

async function testApplySkillPatchErrorHandling() {
    console.log("\n=== Running testApplySkillPatchErrorHandling ===");
    await resetTempSkill();

    const badEdits = [
        { op: 'replace', target: 'NON_EXISTENT_STRING', content: 'some replacement' }
    ];

    try {
        await applySkillPatch(tempSkillPath, badEdits);
        throw new Error('Fail: Safe patch engine failed to throw error on missing target string.');
    } catch (err) {
        if (!err.message.includes('Target not found for replace')) {
            throw new Error(`Unexpected error thrown: ${err.message}`);
        }
        console.log("✅ testApplySkillPatchErrorHandling PASSED (correctly threw error on missing target).");
    }
}

async function testProposeSkillEditsBudget() {
    console.log("\n=== Running testProposeSkillEditsBudget ===");
    const currentSkill = "Current skill instructions.";
    const trajectories = [{ taskInput: "Task A", success: false, score: 0 }];
    const budget = 2; // Lt limit

    // Mock analyst proposing 3 edits (exceeding budget)
    const mockChatJson = async () => {
        return {
            reasoning: "Fix all failures.",
            edits: [
                { op: 'append', content: 'Rule 1' },
                { op: 'append', content: 'Rule 2' },
                { op: 'append', content: 'Rule 3' }
            ]
        };
    };

    const proposedEdits = await proposeSkillEdits(
        trajectories,
        currentSkill,
        budget,
        { provider: 'mock' },
        { mockChatJson }
    );

    if (proposedEdits.length !== 2) {
        throw new Error(`Budget constraint failed. Expected 2 edits, got ${proposedEdits.length}`);
    }

    console.log("✅ testProposeSkillEditsBudget PASSED (correctly clipped edits to Lt learning rate budget).");
}

async function testValidationGatePassing() {
    console.log("\n=== Running testValidationGatePassing ===");
    await resetTempSkill();

    const candidateSkill = `# Test Agent Skill\nCandidate content.`;
    const selectionTasks = [{ id: 1 }, { id: 2 }];

    // Mock task callback returning a clear improvement
    const mockRunTask = async (task, skillContent) => {
        if (skillContent.includes('Candidate content.')) {
            return 80; // Candidate improves score
        }
        return 50; // Baseline score
    };

    const result = await runValidationGate(tempSkillPath, candidateSkill, selectionTasks, mockRunTask);

    if (!result.success || result.newScore !== 80 || result.oldScore !== 50) {
        throw new Error(`Validation gate should have passed. Result: ${JSON.stringify(result)}`);
    }

    // Verify candidate committed
    const finalContent = await fs.readFile(tempSkillPath, 'utf8');
    if (!finalContent.includes('Candidate content.')) {
        throw new Error('Committed candidate content is missing from file.');
    }

    console.log("✅ testValidationGatePassing PASSED (correctly committed and updated target file).");
}

async function testValidationGateRejection() {
    console.log("\n=== Running testValidationGateRejection ===");
    const originalContent = await resetTempSkill();

    const candidateSkill = `# Test Agent Skill\nCandidate content.`;
    const selectionTasks = [{ id: 1 }, { id: 2 }];

    // Mock task callback returning a drop/tie
    const mockRunTask = async (task, skillContent) => {
        if (skillContent.includes('Candidate content.')) {
            return 30; // Candidate drops score
        }
        return 50; // Baseline score
    };

    const result = await runValidationGate(tempSkillPath, candidateSkill, selectionTasks, mockRunTask);

    if (result.success || result.newScore !== 30 || result.oldScore !== 50) {
        throw new Error(`Validation gate should have rejected and rolled back. Result: ${JSON.stringify(result)}`);
    }

    // Verify rollback perfectly restored the file
    const finalContent = await fs.readFile(tempSkillPath, 'utf8');
    if (finalContent !== originalContent) {
        throw new Error('Rollback failed to perfectly restore the original baseline contents.');
    }

    console.log("✅ testValidationGateRejection PASSED (correctly rejected candidate and rolled back target file).");
}

async function run() {
    try {
        await testApplySkillPatch();
        await testApplySkillPatchErrorHandling();
        await testProposeSkillEditsBudget();
        await testValidationGatePassing();
        await testValidationGateRejection();
        console.log("\n⭐️ ALL SKILLOPT-LITE TESTS PASSED SUCCESSFULLY! ⭐️");
    } catch (err) {
        console.error("\n❌ TEST SUITE FAILED:", err);
        process.exit(1);
    } finally {
        await cleanupTempFiles();
    }
}

run();
