"""
Flask auth helpers — extracted from Pocket Lawyer's production auth patterns.

Provides factory functions for Flask-Login setup, subscription-tier gating,
rate limiting with graceful fallback, and password hashing.

Usage:
    from krusch_toolkit.auth import create_flask_auth, require_subscription, hash_password

    # In app setup:
    create_flask_auth(app, user_loader_fn)

    # In routes:
    @app.route('/api/premium')
    @login_required
    @require_subscription('professional')
    def premium_endpoint():
        ...
"""

import functools
import logging
from typing import Callable

import bcrypt

logger = logging.getLogger(__name__)


def create_flask_auth(app, user_loader: Callable, *, login_view: str = 'auth.login'):
    """
    Configure Flask-Login on a Flask app.

    Args:
        app: Flask application instance
        user_loader: Function that loads a user by ID — receives user_id, returns user or None
        login_view: Route name for the login page (default 'auth.login')

    Returns:
        LoginManager instance
    """
    from flask_login import LoginManager

    login_manager = LoginManager()
    login_manager.init_app(app)
    login_manager.login_view = login_view
    login_manager.login_message_category = 'info'

    @login_manager.user_loader
    def load_user(user_id):
        return user_loader(user_id)

    logger.info(f"Flask-Login initialized (login_view={login_view})")
    return login_manager


def require_subscription(tier: str):
    """
    Decorator to require a minimum subscription tier.

    Usage:
        @require_subscription('professional')
        def premium_feature():
            ...

    Args:
        tier: Required subscription tier string

    Returns:
        Decorator function
    """
    from flask import jsonify, url_for
    from flask_login import current_user, login_required

    def decorator(f):
        @functools.wraps(f)
        @login_required
        def decorated(*args, **kwargs):
            user_tier = getattr(current_user, 'subscription_tier', 'free')

            # Trial users can't access paid tiers
            if user_tier == 'trial' and tier != 'trial':
                return jsonify({
                    'error': 'This feature requires a paid subscription',
                    'upgrade_url': url_for('auth.subscription', _external=True) if _has_route('auth.subscription') else '/upgrade',
                }), 403

            return f(*args, **kwargs)
        return decorated
    return decorator


def safe_rate_limit(limit_string: str):
    """
    Graceful rate limiting decorator — falls through if flask-limiter unavailable.

    Usage:
        @safe_rate_limit("10 per minute")
        def my_endpoint():
            ...

    Args:
        limit_string: Rate limit string (e.g., "10 per minute", "3 per hour")

    Returns:
        Decorator function
    """
    def decorator(f):
        try:
            from flask import current_app
            limiter = current_app.extensions.get('limiter')
            if limiter:
                return limiter.limit(limit_string)(f)
        except (RuntimeError, ImportError):
            pass
        return f
    return decorator


# ── Password Hashing ────────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    """
    Hash a password using bcrypt.

    Args:
        password: Plain text password

    Returns:
        Bcrypt hash string
    """
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password(password: str, hashed: str) -> bool:
    """
    Verify a password against a bcrypt hash.

    Args:
        password: Plain text password
        hashed: Bcrypt hash to check against

    Returns:
        True if password matches
    """
    return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))


# ── Internal Helpers ─────────────────────────────────────────────────────────

def _has_route(endpoint: str) -> bool:
    """Check if a Flask route endpoint exists."""
    try:
        from flask import current_app
        return endpoint in current_app.view_functions
    except (RuntimeError, ImportError):
        return False
