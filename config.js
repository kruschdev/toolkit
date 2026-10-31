/**
 * @module config
 * Universal config loader across Node.js & AI projects.
 * Loads from config.json (IDE-editable) + .env file + environment variable overrides.
 *
 * Usage:
 *   import { createConfig } from '@krusch/toolkit/config';
 *   const config = createConfig({ defaults: { port: 3000 }, envPrefix: 'APP' });
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import path, { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load a JSON config file safely.
 *
 * @param {string} filePath - Absolute path to config.json
 * @returns {object} Parsed config or empty object
 */
export function loadJsonConfig(filePath) {
    if (!filePath || !existsSync(filePath)) {
        return {};
    }
    try {
        return JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch (err) {
        throw new Error(`Failed to load config ${filePath}: ${err.message}`, { cause: err });
    }
}

/**
 * Create a configuration object with layered overrides:
 * defaults → config.json → .env → environment variables
 *
 * @param {object} options
 * @param {object} options.defaults - Default configuration values
 * @param {string} [options.configPath] - Path to config.json
 * @param {string} [options.envFile] - Path to .env file (loaded via dotenv)
 * @returns {object} Merged configuration
 */
export async function createConfig({ defaults = {}, configPath = null, envFile = null }) {
    // Load dotenv if .env file specified
    if (envFile || existsSync(join(process.cwd(), '.env'))) {
        try {
            // Use createRequire for sync loading of dotenv
            const { createRequire } = await import('module');
            const require = createRequire(import.meta.url);
            const dotenv = require('dotenv');
            dotenv.config({ path: envFile || undefined });
        } catch {
            // dotenv not installed, skip
        }
    }

    // Load config.json
    const fileConfig = configPath ? loadJsonConfig(configPath) : {};

    // Deep merge: defaults → fileConfig → env overrides
    return deepMerge(defaults, fileConfig);
}

/**
 * Get an environment variable with a fallback chain.
 * Checks env var → fileConfig value → default value.
 *
 * @param {string} envKey - Environment variable name
 * @param {*} fileValue - Value from config.json
 * @param {*} defaultValue - Final fallback
 * @returns {*} Resolved value
 */
export function envOr(envKey, fileValue, defaultValue) {
    const envVal = process.env[envKey];
    if (envVal !== undefined && envVal !== '') return envVal;
    if (fileValue !== undefined && fileValue !== null) return fileValue;
    return defaultValue;
}

/**
 * Get an environment variable as an integer.
 *
 * @param {string} envKey - Environment variable name
 * @param {number} fileValue - Value from config.json
 * @param {number} defaultValue - Final fallback
 * @returns {number} Resolved integer value
 */
export function envInt(envKey, fileValue, defaultValue) {
    const val = envOr(envKey, fileValue, defaultValue);
    return parseInt(val, 10);
}

/**
 * Get an environment variable as a boolean.
 *
 * @param {string} envKey - Environment variable name
 * @param {boolean} fileValue - Value from config.json
 * @param {boolean} defaultValue - Final fallback
 * @returns {boolean} Resolved boolean value
 */
export function envBool(envKey, fileValue, defaultValue) {
    const envVal = process.env[envKey];
    if (envVal !== undefined) {
        return envVal === 'true' || envVal === '1';
    }
    if (fileValue !== undefined && fileValue !== null) return Boolean(fileValue);
    return defaultValue;
}

/**
 * Validate that required config keys are present.
 * Logs warnings for missing keys and throws an Error unless options.throwOnMissing is false.
 *
 * @param {object} config - Config object to validate
 * @param {string[]} requiredKeys - Dot-notation paths like 'gemini.apiKey'
 * @param {object} [options] - Validation options
 * @param {boolean} [options.throwOnMissing=true] - Throw an Error when keys are missing
 * @returns {boolean} True if all keys are present
 */
export function validateRequired(config, requiredKeys, options = {}) {
    const missing = [];
    for (const key of requiredKeys) {
        const val = key.split('.').reduce((obj, k) => obj?.[k], config);
        if (!val) missing.push(key);
    }
    if (missing.length > 0) {
        const msg = `Missing required config: ${missing.join(', ')}`;
        console.warn(`⚠️  ${msg}`);
        if (options?.throwOnMissing === false) {
            return false;
        }
        throw new Error(msg);
    }
    return true;
}

/**
 * Load project config using the FTF layered pattern in one call.
 * Loads config.json from project root, then applies .env overrides.
 *
 * @param {string} [projectRoot] - Project root directory (defaults to cwd)
 * @param {object} [defaults] - Default values
 * @returns {Promise<object>} Fully merged config
 */
export async function loadProjectConfig(projectRoot = process.cwd(), defaults = {}) {
    const configPath = join(projectRoot, 'config.json');
    const envPath = join(projectRoot, '.env');

    // Load .env if present
    if (existsSync(envPath)) {
        try {
            const { createRequire } = await import('module');
            const require = createRequire(import.meta.url);
            const dotenv = require('dotenv');
            dotenv.config({ path: envPath });
        } catch {
            // dotenv not installed, skip
        }
    }

    // Load config.json
    const fileConfig = loadJsonConfig(configPath);

    // Merge: defaults → fileConfig
    return deepMerge(defaults, fileConfig);
}

/**
 * Deep merge two objects. Source values override target values.
 *
 * @param {object} target - Base object
 * @param {object} source - Override object
 * @returns {object} Merged object
 */
function deepMerge(target, source) {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && typeof result[key] === 'object') {
            result[key] = deepMerge(result[key], value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Get the static workspace node topology for agent spatial awareness.
 * Provides the ensemble with real-world network maps without hallucinations.
 *
 * @returns {string} Textual representation of the workspace network
 */
export function getHomelabTopology() {
    const fallbackTopology =
        process.env.WORKSPACE_TOPOLOGY_FALLBACK ||
        'Workspace Node Topology (Fallback):\n- local (127.0.0.1)';
    try {
        const nodesDir = process.env.WORKSPACE_TOPOLOGY_DIR || path.join(__dirname, '..', 'nodes');
        if (!existsSync(nodesDir)) {
            return fallbackTopology;
        }

        const files = readdirSync(nodesDir).filter(f => f.endsWith('.md'));
        if (files.length === 0) {
            return fallbackTopology;
        }

        let topology = 'Workspace Node Topology:\n==============================\n';
        for (const file of files) {
            const content = readFileSync(join(nodesDir, file), 'utf-8');
            topology += `\n--- Node: ${file} ---\n${content}\n`;
        }
        return topology.trim();
    } catch (err) {
        console.warn(`⚠️  Could not read workspace node topology: ${err.message}`);
        return fallbackTopology;
    }
}

/**
 * Get the core operating constraints and current state for the workspace orchestrator.
 * Connects agents directly to the ground truth of workspace rules, bugs, and outcomes.
 *
 * @returns {string} Textual representation of the orchestrator state
 */
export function getHomelabContext() {
    try {
        const rootDir = process.env.WORKSPACE_CONTEXT_DIR || join(__dirname, '..');
        const filesToRead = [
            'AGENTS.md',
            '.agent/priorities.md',
            '.agent/bugs.md',
            '.agent/rules/lessons-learned.md'
        ];

        let contextData = 'Workspace Operating Context\n===========================\n';
        let foundAny = false;
        for (const file of filesToRead) {
            const filePath = join(rootDir, file);
            if (existsSync(filePath)) {
                foundAny = true;
                contextData += `\n--- Context File: ${file} ---\n`;
                const content = readFileSync(filePath, 'utf-8');
                contextData += content + '\n';
            }
        }
        if (!foundAny) {
            return 'Context unavailable.';
        }
        return contextData.trim();
    } catch (err) {
        console.warn(`⚠️  Could not read workspace context files: ${err.message}`);
        return 'Context unavailable.';
    }
}
