"""Tests for krusch_toolkit.config — including PL-extracted patterns."""

import os
import pytest
from unittest.mock import patch

from krusch_toolkit.config import (
    env_or, env_int, env_bool, validate_required,
    safe_int, get_redis_connection, validate_config,
)


# ── env_or / env_int / env_bool ──────────────────────────────────────────────

def test_env_or_returns_env_var():
    with patch.dict(os.environ, {'TEST_KEY': 'from_env'}):
        assert env_or('TEST_KEY', 'from_file', 'default') == 'from_env'


def test_env_or_returns_file_value():
    with patch.dict(os.environ, {}, clear=True):
        os.environ.pop('TEST_KEY', None)
        assert env_or('TEST_KEY', 'from_file', 'default') == 'from_file'


def test_env_or_returns_default():
    with patch.dict(os.environ, {}, clear=True):
        os.environ.pop('TEST_KEY', None)
        assert env_or('TEST_KEY', None, 'default') == 'default'


def test_env_int_parses_int():
    with patch.dict(os.environ, {'PORT': '8080'}):
        assert env_int('PORT', None, 5000) == 8080


def test_env_bool_truthy():
    for val in ('1', 'true', 'yes', 'on', 'True', 'YES'):
        with patch.dict(os.environ, {'FLAG': val}):
            assert env_bool('FLAG', None, False) is True


def test_env_bool_falsy():
    with patch.dict(os.environ, {'FLAG': 'no'}):
        assert env_bool('FLAG', None, True) is False


# ── safe_int (PL pattern) ────────────────────────────────────────────────────

def test_safe_int_normal():
    with patch.dict(os.environ, {'CACHE': '500'}):
        assert safe_int('CACHE', 100) == 500


def test_safe_int_with_inline_comment():
    with patch.dict(os.environ, {'CACHE': '500  # 500 items'}):
        assert safe_int('CACHE', 100) == 500


def test_safe_int_malformed_returns_default():
    with patch.dict(os.environ, {'CACHE': 'not_a_number'}):
        assert safe_int('CACHE', 100) == 100


def test_safe_int_missing_returns_default():
    with patch.dict(os.environ, {}, clear=True):
        os.environ.pop('MISSING_INT', None)
        assert safe_int('MISSING_INT', 42) == 42


def test_safe_int_negative_values():
    with patch.dict(os.environ, {'CACHE': '-200000  # KB'}):
        assert safe_int('CACHE', 0) == -200000


# ── get_redis_connection (PL pattern) ────────────────────────────────────────

def test_get_redis_connection_returns_none_when_unavailable():
    """Should return None gracefully — not crash — when Redis isn't running."""
    result = get_redis_connection('redis://localhost:59999/0')  # unlikely port
    assert result is None


# ── validate_config (PL pattern) ─────────────────────────────────────────────

def test_validate_config_passes_when_all_present():
    validate_config(
        {'API_KEY': 'abc123', 'SECRET': 'xxx'},
        required=['API_KEY', 'SECRET'],
        is_production=True,
    )
    # Should not raise


def test_validate_config_raises_in_production_on_missing():
    with pytest.raises(ValueError, match='Required config missing'):
        validate_config(
            {'API_KEY': ''},
            required=['API_KEY'],
            is_production=True,
        )


def test_validate_config_warns_in_dev_on_missing():
    # Should NOT raise — just warn
    validate_config(
        {'API_KEY': ''},
        required=['API_KEY'],
        is_production=False,
    )


def test_validate_config_production_checks():
    with pytest.raises(ValueError, match='validation failed'):
        validate_config(
            {'SECRET_KEY': 'short'},
            production_checks={'SECRET_KEY': lambda v: v and len(v) >= 32},
            is_production=True,
        )


def test_validate_config_production_checks_pass():
    validate_config(
        {'SECRET_KEY': 'a' * 32},
        production_checks={'SECRET_KEY': lambda v: v and len(v) >= 32},
        is_production=True,
    )
    # Should not raise


# ── validate_required ────────────────────────────────────────────────────────

def test_validate_required_raises_on_missing():
    os.environ.pop('NONEXISTENT_123', None)
    with pytest.raises(ValueError, match='Missing required'):
        validate_required('NONEXISTENT_123')


def test_validate_required_passes_when_set():
    with patch.dict(os.environ, {'EXISTING_KEY': 'value'}):
        validate_required('EXISTING_KEY')  # Should not raise


def test_init_db_raises_configuration_error_when_database_url_missing(monkeypatch):
    from krusch_toolkit.config import ConfigurationError
    from krusch_toolkit.db import init_db

    monkeypatch.delenv('DATABASE_URL', raising=False)
    with pytest.raises(ConfigurationError, match='DATABASE_URL is required'):
        init_db()
    with pytest.raises(ConfigurationError, match='DATABASE_URL is required'):
        init_db('   ')


def test_nexus_config_from_env_and_overrides(monkeypatch):
    from krusch_toolkit.config import ConfigurationError, NexusConfig

    monkeypatch.setenv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/nexus')
    monkeypatch.setenv('POSTGRES_PASSWORD', 's3cret')
    monkeypatch.setenv('WATCH_DIR', '/tmp/watch')

    cfg = NexusConfig.from_env(require_database_url=True)
    assert cfg.database_url == 'postgresql://user:pass@localhost:5432/nexus'
    assert cfg.postgres_password == 's3cret'
    assert cfg.watch_dir == '/tmp/watch'

    overridden = NexusConfig.from_env(watch_dir='/custom/watch', database_url='sqlite:///:memory:')
    assert overridden.watch_dir == '/custom/watch'
    assert overridden.database_url == 'sqlite:///:memory:'

    monkeypatch.delenv('DATABASE_URL', raising=False)
    with pytest.raises(ConfigurationError, match='DATABASE_URL is required'):
        NexusConfig.from_env(require_database_url=True)

