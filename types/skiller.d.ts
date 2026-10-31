export { createExecutableSkillContract, evaluateSkillTransfer, extractSkillFromTrajectory, routeDiverseSkills } from "./research.js";
/**
 * Stages and writes an extracted skill into the monorepo skills directory.
 *
 * @param {string} skillName - Name of the skill.
 * @param {string} skillMarkdown - Full markdown content.
 * @param {string} [targetDir=".agent/skills"] - Destination directory.
 * @returns {Promise<{ skillPath: string, bytesWritten: number }>}
 */
export declare function stageSkillForMonorepo(skillName: string, skillMarkdown: string, targetDir?: string): Promise<{
    skillPath: string;
    bytesWritten: number;
}>;
