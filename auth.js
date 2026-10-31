/**
 * @module auth
 * JWT authentication helpers — extracted from the FTF pattern.
 * Provides signToken, cookie management, and Express middleware.
 *
 * Usage:
 *   import { createAuth } from '@krusch/toolkit/auth';
 *   const auth = createAuth({ secret: 'my-secret', cookieName: 'app_token' });
 *   app.use('/api', auth.requireAuth);
 */

import jwt from 'jsonwebtoken';

/**
 * @typedef {object} AuthConfig
 * @property {string} secret - JWT signing secret
 * @property {string} [cookieName='app_token'] - Cookie name for the JWT
 * @property {string} [expiresIn='30d'] - Token expiration (e.g., '30d', '7d', '1h')
 * @property {boolean} [secureCookie] - Force secure cookies (auto-detected from NODE_ENV)
 */

/**
 * Create an auth helper with the given configuration.
 *
 * @param {AuthConfig} config - Auth configuration
 * @returns {object} Auth utilities: signToken, setTokenCookie, requireAuth, optionalAuth
 */
export function createAuth(config) {
    const {
        secret,
        cookieName = 'app_token',
        expiresIn = '30d',
        secureCookie,
    } = config;

    if (!secret) throw new Error('Auth: secret is required');

    /**
     * Generate a JWT for the given user.
     * @param {object} user - User object (must have id, optionally email)
     * @returns {string} Signed JWT
     */
    function signToken(user) {
        return jwt.sign(
            { id: user.id, email: user.email },
            secret,
            { expiresIn }
        );
    }

    /**
     * Set the JWT as an httpOnly cookie on the response.
     * @param {object} res - Express response
     * @param {string} token - JWT to set
     */
    function setTokenCookie(res, token) {
        const isProd = secureCookie ?? process.env.NODE_ENV === 'production';
        res.cookie(cookieName, token, {
            httpOnly: true,
            secure: isProd,
            sameSite: isProd ? 'none' : 'lax',
            maxAge: parseDuration(expiresIn),
            path: '/',
        });
    }

    /**
     * Clear the auth cookie.
     * @param {object} res - Express response
     */
    function clearTokenCookie(res) {
        res.clearCookie(cookieName, { path: '/' });
    }

    /**
     * Express middleware: require authentication.
     * Reads JWT from cookie → sets req.user = { id, email }.
     */
    function requireAuth(req, res, next) {
        const token = req.cookies?.[cookieName];
        if (!token) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        try {
            const decoded = jwt.verify(token, secret);
            req.user = { id: decoded.id, email: decoded.email };
            next();
        } catch {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
    }

    /**
     * Express middleware: optional authentication.
     * Sets req.user if token exists and is valid, otherwise continues.
     */
    function optionalAuth(req, _res, next) {
        const token = req.cookies?.[cookieName];
        if (token) {
            try {
                const decoded = jwt.verify(token, secret);
                req.user = { id: decoded.id, email: decoded.email };
            } catch {
                // Invalid token — continue without user
            }
        }
        next();
    }

    return { signToken, setTokenCookie, clearTokenCookie, requireAuth, optionalAuth };
}

/**
 * Parse a duration string like '30d', '7d', '1h' into milliseconds.
 * @param {string} duration - Duration string
 * @returns {number} Duration in milliseconds
 */
function parseDuration(duration) {
    const match = duration.match(/^(\d+)([dhms])$/);
    if (!match) return 30 * 24 * 60 * 60 * 1000; // default 30 days

    const value = parseInt(match[1], 10);
    const unit = match[2];
    const multipliers = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
    return value * (multipliers[unit] || 86400000);
}
