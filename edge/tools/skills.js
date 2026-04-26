/**
 * @module skills
 * Defines ADK 2.0 SkillToolsets for progressive disclosure and composable context bounds.
 */

export const SkillToolsets = {
    FileSystem: ['read_file', 'write_file', 'inject_code', 'list_dir', 'make_dir'],
    Execution: ['run_safe'],
    Analysis: ['analyze_code'],
    Sandbox: ['sandbox_import', 'sandbox_start', 'sandbox_exec', 'sandbox_export', 'sandbox_stop'],
    Core: ['search_rules', 'write_shared_memory']
};

/**
 * Given an array of desired SkillToolsets (e.g. ['FileSystem', 'Core']), 
 * returns a flattened array of allowed tool names.
 * @param {string[]} toolsetNames 
 * @returns {string[]}
 */
export function resolveToolsets(toolsetNames) {
    const tools = new Set(SkillToolsets.Core); // Core is always injected
    if (Array.isArray(toolsetNames)) {
        for (const ts of toolsetNames) {
            if (SkillToolsets[ts]) {
                for (const tool of SkillToolsets[ts]) tools.add(tool);
            }
        }
    }
    return Array.from(tools);
}
