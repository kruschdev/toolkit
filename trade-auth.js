/**
 * Rough-In Trade App — API Key Authentication Middleware
 *
 * Protects trade app /api routes with a shared secret (X-Trade-Key header).
 * The roughin hub (and any authorized caller) must include this header.
 *
 * Configuration:
 *   - Set TRADE_API_KEY in .env (all trade apps + roughin hub share the same key)
 *   - In development, if TRADE_API_KEY is unset, auth is SKIPPED (open access)
 *   - The /api/health endpoint is always exempt (used for monitoring)
 *
 * Usage (automatically wired by trade-app-factory.js):
 *   import { createTradeAuthMiddleware } from '../../lib/trade-auth.js';
 *   app.use('/api', createTradeAuthMiddleware(config));
 */

import { timingSafeEqual } from 'node:crypto';

const HEADER_NAME = 'x-trade-key';
const EXEMPT_PATHS = ['/health'];

/**
 * Creates Express middleware that validates the X-Trade-Key header.
 *
 * @param {Object} options
 * @param {string} [options.apiKey] — expected key value (from config / env)
 * @param {boolean} [options.devBypass=true] — if true and no key configured, skip auth
 * @returns {import('express').RequestHandler}
 */
export function createTradeAuthMiddleware({ apiKey, devBypass = true } = {}) {
  return (req, res, next) => {
    // Always allow health checks through (path is relative to mount point)
    if (EXEMPT_PATHS.includes(req.path)) return next();

    // Dev bypass: if no key is configured, allow all requests
    if (!apiKey) {
      if (devBypass) return next();
      return res.status(500).json({ error: 'TRADE_API_KEY not configured' });
    }

    const provided = req.headers[HEADER_NAME];
    if (!provided) {
      return res.status(401).json({ error: 'Missing X-Trade-Key header' });
    }

    // Constant-time comparison to prevent timing attacks
    if (provided.length !== apiKey.length ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(apiKey))) {
      return res.status(403).json({ error: 'Invalid API key' });
    }

    next();
  };
}
