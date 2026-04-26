/**
 * @module config
 * Universal config loader for homelab projects.
 * Loads from config.json (IDE-editable) + .env file + environment variable overrides.
 *
 * Usage:
 *   import { createConfig } from '@krusch/toolkit/config';
 *   const config = createConfig({ defaults: { port: 3000 }, envPrefix: 'APP' });
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
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
    try {
        if (existsSync(filePath)) {
            return JSON.parse(readFileSync(filePath, 'utf-8'));
        }
    } catch (err) {
        console.warn(`⚠️  Could not load ${filePath}: ${err.message}`);
    }
    return {};
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
 * Logs warnings for missing keys.
 *
 * @param {object} config - Config object to validate
 * @param {string[]} requiredKeys - Dot-notation paths like 'gemini.apiKey'
 * @returns {boolean} True if all keys are present
 */
export function validateRequired(config, requiredKeys) {
    const missing = [];
    for (const key of requiredKeys) {
        const val = key.split('.').reduce((obj, k) => obj?.[k], config);
        if (!val) missing.push(key);
    }
    if (missing.length > 0) {
        console.warn(`⚠️  Missing required config: ${missing.join(', ')}`);
        return false;
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
 * Get the static homelab node topology for agent spatial awareness.
 * Provides the ensemble with real-world network maps without hallucinations.
 *
 * @returns {string} Textual representation of the homelab network
 */
export function getHomelabTopology() {
    try {
        const nodesDir = join(__dirname, '../nodes');
        if (!existsSync(nodesDir)) {
            return 'Homelab Node Topology (Fallback):\n- kruschserv (100.105.135.121)\n- kruschgame (10.0.0.19)\n- kruschdev (100.126.126.119)';
        }
        
        const files = readdirSync(nodesDir).filter(f => f.endsWith('.md'));
        let topology = 'Homelab Infrastructure Context\n==============================\n';
        for (const file of files) {
            const content = readFileSync(join(nodesDir, file), 'utf-8');
            topology += `\n--- Node: ${file} ---\n${content}\n`;
        }
        return topology.trim();
    } catch (err) {
        console.warn(`⚠️  Could not read nodes topologoy: ${err.message}`);
        return 'Homelab Node Topology: Unavailable';
    }
}

/**
 * Get the core operating constraints and current state for the homelab orchestrator.
 * Connects Brain3 directly to the ground truth of the homelab rules, bugs, and outcomes.
 *
 * @returns {string} Textual representation of the orchestrator state
 */
export function getHomelabContext() {
    try {
        const rootDir = join(__dirname, '..');
        const filesToRead = [
            'AGENTS.md',
            '.agent/priorities.md',
            '.agent/bugs.md',
            '.agent/rules/lessons-learned.md'
        ];
        
        let contextData = 'Homelab Operating Context\n===========================\n';
        for (const file of filesToRead) {
            const filePath = join(rootDir, file);
            if (existsSync(filePath)) {
                contextData += `\n--- Context File: ${file} ---\n`;
                const content = readFileSync(filePath, 'utf-8');
                // Truncate excessively long files to save tokens if necessary, though
                // Gemini Flash can handle 1M. We'll just append it directly.
                contextData += content + '\n';
            }
        }
        return contextData.trim();
    } catch (err) {
        console.warn(`⚠️  Could not read homelab context files: ${err.message}`);
        return 'Homelab Context: Unavailable';
    }
}
