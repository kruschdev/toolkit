"""
Layered configuration — mirrors @krusch/toolkit/config.

Priority: environment variable → file value → default.

Usage:
    from krusch_toolkit.config import load_project_config, env_or, env_int, env_bool
    from krusch_toolkit.config import safe_int, get_redis_connection, validate_config

    config = load_project_config()          # loads config.json + .env
    port = env_int('PORT', config.get('port'), 5000)
    debug = env_bool('DEBUG', config.get('debug'), False)
    api_key = env_or('API_KEY', config.get('api_key'), '')

    # Hardened int parsing (strips inline .env comments)
    cache_size = safe_int('CACHE_SIZE', 1000)

    # Graceful Redis — returns None if unavailable
    redis = get_redis_connection('redis://localhost:6379/0')

    # Prod/dev config validation
    validate_config({'API_KEY': api_key}, required=['API_KEY'], is_production=True)
"""

import json
import logging
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

logger = logging.getLogger(__name__)


def load_project_config(project_dir: str | None = None) -> dict:
    """
    Load config.json + .env from a project directory.

    If project_dir is None, searches upward from CWD for config.json.
    Loads .env into os.environ so env_or/env_int/env_bool can access them.

    Args:
        project_dir: Project root containing config.json and .env

    Returns:
        dict from config.json (empty dict if not found)
    """
    if project_dir is None:
        project_dir = _find_project_root()

    project_path = Path(project_dir)

    # Load .env first (lower priority than real env vars)
    env_path = project_path / '.env'
    if env_path.exists():
        load_dotenv(env_path, override=False)

    # Load config.json
    config_path = project_path / 'config.json'
    if config_path.exists():
        with open(config_path) as f:
            return json.load(f)

    return {}


def env_or(key: str, file_value: Any = None, default: str = '') -> str:
    """
    Get a string config value with layered priority: env → file → default.

    Args:
        key: Environment variable name
        file_value: Value from config.json (middle priority)
        default: Fallback default value

    Returns:
        Resolved string value
    """
    env_val = os.environ.get(key)
    if env_val is not None:
        return env_val
    if file_value is not None:
        return str(file_value)
    return default


def env_int(key: str, file_value: Any = None, default: int = 0) -> int:
    """
    Get an integer config value with layered priority: env → file → default.

    Args:
        key: Environment variable name
        file_value: Value from config.json (middle priority)
        default: Fallback default value

    Returns:
        Resolved integer value
    """
    env_val = os.environ.get(key)
    if env_val is not None:
        return int(env_val)
    if file_value is not None:
        return int(file_value)
    return default


def env_bool(key: str, file_value: Any = None, default: bool = False) -> bool:
    """
    Get a boolean config value with layered priority: env → file → default.

    Truthy strings: '1', 'true', 'yes', 'on' (case-insensitive)

    Args:
        key: Environment variable name
        file_value: Value from config.json (middle priority)
        default: Fallback default value

    Returns:
        Resolved boolean value
    """
    env_val = os.environ.get(key)
    if env_val is not None:
        return env_val.lower() in ('1', 'true', 'yes', 'on')
    if file_value is not None:
        if isinstance(file_value, bool):
            return file_value
        return str(file_value).lower() in ('1', 'true', 'yes', 'on')
    return default


def validate_required(*keys: str) -> None:
    """
    Ensure all required environment variables are set. Raises ValueError if any are missing.

    Args:
        *keys: Environment variable names to check

    Raises:
        ValueError: If any keys are not set in the environment
    """
    missing = [k for k in keys if not os.environ.get(k)]
    if missing:
        raise ValueError(f"Missing required environment variables: {', '.join(missing)}")


def validate_nonempty_str(val: Any, name: str) -> str:
    """Validate that a configuration string or environment variable value is non-empty (SEC-01)."""
    if val is None or not isinstance(val, str):
        raise ValueError(f"{name} cannot be empty")
    cleaned = val.strip()
    if not cleaned or "\x00" in cleaned:
        raise ValueError(f"{name} cannot be empty")
    return cleaned


def validate_url_env(
    key: str,
    default: str,
    allowed_schemes: tuple[str, ...] = ("http", "https", "sqlite", "postgresql", "postgres", "redis"),
) -> str:
    """Read an environment variable (or default) and validate its URL scheme and hostname (SEC-01)."""
    import re
    from urllib.parse import urlparse

    raw = os.environ.get(key, default)
    cleaned = validate_nonempty_str(raw, key)
    parsed = urlparse(cleaned)
    scheme = (parsed.scheme or "").split("+")[0].lower()
    if scheme not in allowed_schemes:
        raise ValueError(f"{key} uses unsupported URL scheme '{parsed.scheme}'")
    if scheme in ("http", "https", "postgresql", "postgres", "redis"):
        host = parsed.hostname or ""
        if not host or not re.match(r"^[A-Za-z0-9._:-]+$", host):
            raise ValueError(f"{key} contains an invalid hostname '{host}'")
    return cleaned


def _find_project_root() -> str:
    """Walk upward from CWD looking for config.json or pyproject.toml."""
    current = Path.cwd()
    for parent in [current, *current.parents]:
        if (parent / 'config.json').exists() or (parent / 'pyproject.toml').exists():
            return str(parent)
    return str(current)


# ── Battle-tested patterns (extracted from Pocket Lawyer) ────────────────────

def safe_int(env_var: str, default: int) -> int:
    """
    Safely parse an integer from an environment variable.

    Handles inline comments (e.g., "100  # comment" in .env files)
    and malformed values. Logs a warning and returns default on parse failure.

    Args:
        env_var: Environment variable name
        default: Fallback value if missing or malformed

    Returns:
        Parsed integer or default
    """
    value = os.environ.get(env_var, str(default))
    # Strip inline comments (dotenv doesn't always strip them)
    if '#' in value:
        value = value.split('#')[0].strip()
    try:
        return int(value)
    except (ValueError, TypeError):
        logger.warning(f"Invalid {env_var}='{value}', using default {default}")
        return default


def get_redis_connection(url: str = 'redis://localhost:6379/0'):
    """
    Get a Redis connection with graceful degraded-mode fallback.

    Returns None instead of crashing when Redis is unavailable,
    allowing the application to continue in degraded mode (no caching).

    Args:
        url: Redis URL (default: 'redis://localhost:6379/0')

    Returns:
        Redis client instance, or None if unavailable
    """
    try:
        import redis
        r = redis.from_url(url, decode_responses=True)
        r.ping()  # Verify connection
        return r
    except ImportError:
        logger.warning("redis package not installed — caching disabled")
        return None
    except Exception as e:
        logger.warning(f"Redis unavailable ({e}), caching disabled")
        return None


def validate_config(
    config: dict,
    *,
    required: list[str] | None = None,
    is_production: bool = False,
    production_checks: dict[str, callable] | None = None,
) -> None:
    """
    Validate configuration with production/dev awareness.

    In production, missing required keys and failed checks raise ValueError.
    In development, they emit warnings but don't crash.

    Args:
        config: Dict of config key → value pairs to validate
        required: Keys that must have truthy values
        is_production: If True, failures raise ValueError instead of logging
        production_checks: Dict of key → validator function for prod-only checks.
            Each validator receives the value and returns True if valid.

    Raises:
        ValueError: In production, if required keys are missing or checks fail
    """
    errors = []
    warnings_list = []

    # Check required keys
    for key in (required or []):
        if not config.get(key):
            msg = f"Required config missing: {key}"
            if is_production:
                errors.append(msg)
            else:
                warnings_list.append(msg)

    # Run production-specific validators
    for key, validator in (production_checks or {}).items():
        value = config.get(key)
        if not validator(value):
            msg = f"Config validation failed for: {key}"
            if is_production:
                errors.append(msg)
            else:
                warnings_list.append(msg)

    # Emit warnings
    for w in warnings_list:
        logger.warning(w)

    # In production, raise on errors
    if errors:
        for e in errors:
            logger.error(e)
        raise ValueError(f"Configuration validation failed: {'; '.join(errors)}")


class ConfigurationError(ValueError):
    """Raised when required service configuration (such as DATABASE_URL) is missing or invalid."""


from dataclasses import dataclass


@dataclass
class NexusConfig:
    """Shared fleet configuration helper populated from environment variables with override support (BUG-02)."""

    database_url: str | None = None
    postgres_password: str | None = None
    watch_dir: str = "/var/watch"

    @classmethod
    def from_env(cls, *, require_database_url: bool = False, **overrides: Any) -> "NexusConfig":
        env_vals: dict[str, Any] = {
            "database_url": os.getenv("DATABASE_URL"),
            "postgres_password": os.getenv("POSTGRES_PASSWORD"),
            "watch_dir": os.getenv("WATCH_DIR", "/var/watch"),
        }
        merged = {**env_vals, **overrides}
        db_url = merged.get("database_url")
        if isinstance(db_url, str):
            db_url = db_url.strip() or None
            merged["database_url"] = db_url
        if require_database_url and not merged.get("database_url"):
            raise ConfigurationError("DATABASE_URL is required for database connection")
        return cls(**merged)

