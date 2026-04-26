/**
 * @module system
 * Hardware and infrastructure monitoring utilities for the Krusch homelab.
 */

import { execSync } from 'node:child_process';

/**
 * Get the liquid temperature from the AIO cooler via liquidctl.
 * Currently optimized for the Corsair H100i GTX on kruschdev.
 * 
 * @returns {number|null} Liquid temperature in Celsius, or null if unreadable.
 */
export function getLiquidTemp() {
    try {
        // Note: Requires sudo privileges for liquidctl
        const output = execSync('sudo liquidctl --match H100i status', { encoding: 'utf8' });
        const match = output.match(/Liquid temperature\s+([\d.]+)/);
        return match ? parseFloat(match[1]) : null;
    } catch (err) {
        // Non-critical: some nodes may not have liquidctl or the H100i
        return null;
    }
}

/**
 * Check if the system is within safe thermal operating limits.
 * Default threshold is 43°C (liquid), as 45°C is the observed plateau/risk level.
 * 
 * @param {object} [options]
 * @param {number} [options.maxLiquidTemp=43] - Liquid temperature threshold
 * @param {boolean} [options.silent=false] - If true, returns boolean instead of throwing
 * @returns {boolean} True if safe, false if unsafe (only if silent=true)
 * @throws {Error} If temperature exceeds threshold and silent is false
 */
export function checkThermalSafety(options = {}) {
    const { maxLiquidTemp = 43, silent = false } = options;
    const temp = getLiquidTemp();

    if (temp === null) return true; // Assume safe if sensor is missing

    if (temp > maxLiquidTemp) {
        if (silent) return false;
        throw new Error(`THERMAL ALERT: Liquid temperature is ${temp}°C (Threshold: ${maxLiquidTemp}°C). Please offload workload or maximize fans.`);
    }

    return true;
}
