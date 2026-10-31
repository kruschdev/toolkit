"""
SQLAlchemy Sync/Async Engine Pool, SQLite WAL & Transactional Session Scope Lego Bricks (`INV-LEGO-24`, `INV-LEGO-01`).

Imports cleanly in bare Python 3.11+ stdlib without `sqlalchemy`, `aiosqlite`, `asyncpg`, or `psycopg`
installed. SQLAlchemy and DBAPI drivers are resolved lazily inside engine/health functions unless
`sa_module` or `async_engine_factory` is injected for deterministic testing.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import math
import os
import re
import types
from collections.abc import AsyncIterator, Callable, Iterator
from typing import Any
from urllib.parse import unquote_plus, urlsplit

from krusch_toolkit.fastapi_app import error_envelope, ok_envelope

__all__ = [
    "DEFAULT_SQLITE_PRAGMAS",
    "redact_database_url",
    "apply_sqlite_wal_pragmas",
    "create_managed_engine",
    "create_managed_async_engine",
    "session_scope",
    "async_session_scope",
    "check_engine_health",
    "check_async_engine_health",
]

DEFAULT_SQLITE_PRAGMAS: types.MappingProxyType[str, Any] = types.MappingProxyType(
    {
        "journal_mode": "WAL",
        "synchronous": "NORMAL",
        "busy_timeout": 5000,
        "foreign_keys": "ON",
        "temp_store": "MEMORY",
    }
)

_VALID_JOURNAL_MODES = frozenset({"WAL", "DELETE", "TRUNCATE", "PERSIST", "MEMORY", "OFF"})
_VALID_SYNCHRONOUS_MODES = frozenset({"OFF", "NORMAL", "FULL", "EXTRA"})

_ASYNC_ONLY_DRIVERS = frozenset(
    {
        "aiosqlite",
        "asyncpg",
        "aiomysql",
        "asyncmy",
        "asyncodbc",
        "oracledb_async",
    }
)
_ASYNC_CAPABLE_DRIVERS = frozenset(
    {
        "aiosqlite",
        "asyncpg",
        "psycopg",
        "aiomysql",
        "asyncmy",
    }
)

_SENSITIVE_QUERY_KEYS = frozenset(
    {
        "password",
        "passwd",
        "pwd",
        "secret",
        "token",
        "api_key",
        "apikey",
        "sslpassword",
        "access_token",
        "auth_token",
    }
)

_SCHEME_RE = re.compile(r"^[a-z][a-z0-9_-]*(?:\+[a-z][a-z0-9_-]*)?$")
_STANDALONE_URL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")
_EMBEDDED_URL_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s'\"<>),\]]+")
_HOSTPORT_RE = re.compile(r"^(?:\[[0-9A-Fa-f:.%A-Za-z_-]+\]|[A-Za-z0-9._-]+)(?::\d{1,5})?$")
_QUERY_SPLIT_RE = re.compile(r"([&;])")
_DSN_KV_SECRET_RE = re.compile(
    r"(?i)(?<![?&;])\b(password|passwd|pwd|secret|token|api_key|apikey|sslpassword)\s*=\s*(?:'[^']*'|\"[^\"]*\"|[^\s,;)]+)"
)


def _safe_tool_name(tool: Any, default: str) -> str:
    return tool.strip() if isinstance(tool, str) and tool.strip() else default


def _is_strict_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_finite_number(value: Any) -> bool:
    if not isinstance(value, int | float) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, TypeError, ValueError):
        return False


def _split_first_delim(text: str, delims: str = "/?#") -> tuple[str, str]:
    earliest = -1
    for ch in delims:
        pos = text.find(ch)
        if pos != -1 and (earliest == -1 or pos < earliest):
            earliest = pos
    if earliest == -1:
        return text, ""
    return text[:earliest], text[earliest:]


def _scrub_query_string(query: str) -> str:
    if not query:
        return query
    parts = _QUERY_SPLIT_RE.split(query)
    scrubbed: list[str] = []
    for idx, part in enumerate(parts):
        if idx % 2 == 1:
            scrubbed.append(part)
            continue
        if "=" not in part:
            scrubbed.append(part)
            continue
        raw_key, _, _raw_val = part.partition("=")
        decoded_key = unquote_plus(raw_key).strip().lower()
        if decoded_key in _SENSITIVE_QUERY_KEYS:
            scrubbed.append(f"{raw_key}=***")
        else:
            scrubbed.append(part)
    return "".join(scrubbed)


def _split_path_query_fragment(remainder: str) -> tuple[str, str, str]:
    """Split a `/path?query#fragment` suffix using stdlib `urlsplit` without touching scheme/authority."""
    if not remainder:
        return "", "", ""
    parsed = urlsplit(f"http://placeholder{remainder if remainder.startswith(('/', '?', '#')) else '/' + remainder}")
    path = parsed.path if remainder.startswith("/") else ""
    return path, parsed.query, parsed.fragment


def _is_unambiguous_hostport(token: str) -> bool:
    if not token or not _HOSTPORT_RE.match(token):
        return False
    return token.startswith("[") or ":" in token or "." in token or token.lower() == "localhost"


def _scrub_userinfo_prefix(user: str) -> str:
    cleaned = _DSN_KV_SECRET_RE.sub(r"\1=***", user)
    if "?" in cleaned:
        prefix, _, query_part = cleaned.partition("?")
        cleaned = f"{prefix}?{_scrub_query_string(query_part)}"
    return cleaned


def _redact_single_url(raw_url: str) -> str:
    scheme, sep, after_scheme = raw_url.partition("://")
    if not sep:
        return _DSN_KV_SECRET_RE.sub(r"\1=***", raw_url)

    # Empty authority (e.g. sqlite://, sqlite:///path.db, sqlite:////abs/path.db, postgresql:///db?...)
    # Only fall through when `after_scheme` starts with `/:` followed by `@` before `?`/`#`
    # (e.g. `sqlite:///:secret@localhost/db`).
    is_slash_empty_user_secret = (
        after_scheme.startswith("/:") and "@" in after_scheme.partition("?")[0].partition("#")[0]
    )
    if not after_scheme or after_scheme[0] in "?#" or (after_scheme[0] == "/" and not is_slash_empty_user_secret):
        path, query, fragment = _split_path_query_fragment(after_scheme)
        clean_query = _scrub_query_string(query)
        suffix = path
        if clean_query or "?" in after_scheme.partition("#")[0]:
            suffix += f"?{clean_query}"
        if fragment or "#" in after_scheme:
            suffix += f"#{fragment}"
        return f"{scheme}://{suffix}"

    initial_segment, initial_rest = _split_first_delim(after_scheme, "/?#")
    init_at = initial_segment.rfind("@")
    authority_at = -1

    if init_at != -1:
        init_userinfo = initial_segment[:init_at]
        init_hostport = initial_segment[init_at + 1 :]
        if _HOSTPORT_RE.match(init_hostport) and (
            _is_unambiguous_hostport(init_hostport)
            or ":" not in init_userinfo
            or "@" not in initial_rest.partition("?")[0].partition("#")[0]
        ):
            authority_at = init_at

    if authority_at == -1:
        init_left = initial_segment.partition(":")[0]
        is_passwordless_ip_or_localhost_port = (
            init_at == -1
            and bool(_HOSTPORT_RE.match(initial_segment))
            and (initial_segment.startswith("[") or "." in init_left or init_left.lower() == "localhost")
        )
        can_have_split_password = is_slash_empty_user_secret or (
            ":" in initial_segment and not is_passwordless_ip_or_localhost_port
        )

        if can_have_split_password:
            search_end = len(after_scheme)
            while True:
                at_idx = after_scheme.rfind("@", 0, search_end)
                if at_idx == -1:
                    break
                search_end = at_idx
                before_at = after_scheme[:at_idx]
                after_at = after_scheme[at_idx + 1 :]
                cand_hostport, cand_rest = _split_first_delim(after_at, "/?#")
                if not cand_hostport or not _HOSTPORT_RE.match(cand_hostport):
                    continue

                if not any(ch in before_at for ch in "/?#"):
                    authority_at = at_idx
                    break

                q_pos = before_at.find("?")
                if q_pos != -1 and "=" in before_at[q_pos:] and not cand_rest.startswith("/"):
                    continue

                if not (
                    cand_rest.startswith("/")
                    or ("?" not in before_at and "#" not in before_at and _is_unambiguous_hostport(cand_hostport))
                ):
                    continue

                if (
                    init_at == -1
                    and _HOSTPORT_RE.match(initial_segment)
                    and not (cand_rest.startswith("/") and _is_unambiguous_hostport(cand_hostport))
                ):
                    continue

                if ":" in before_at:
                    authority_at = at_idx
                    break

    if authority_at != -1:
        userinfo = after_scheme[:authority_at]
        after_at = after_scheme[authority_at + 1 :]
        hostport, rest = _split_first_delim(after_at, "/?#")
        if ":" in userinfo:
            user, _, _ = userinfo.partition(":")
            redacted_userinfo = f"{_scrub_userinfo_prefix(user)}:***"
        else:
            redacted_userinfo = _scrub_userinfo_prefix(userinfo)
        authority = f"{redacted_userinfo}@{hostport}"
    else:
        authority = initial_segment
        rest = initial_rest

    path, query, fragment = _split_path_query_fragment(rest)
    clean_query = _scrub_query_string(query)
    rebuilt = f"{scheme}://{authority}{path}"
    if clean_query or (rest and "?" in rest.partition("#")[0]):
        rebuilt += f"?{clean_query}"
    if fragment or (rest and "#" in rest):
        rebuilt += f"#{fragment}"
    return rebuilt


def redact_database_url(database_url: str) -> str:
    """
    Pure non-throwing credential scrubber for database URLs and error text.

    Redacts `user:password@host` credentials to `user:***@host` (even when passwords
    contain `@`, `:`, `/`, `?`, `#`, or `%`-encoded bytes) and scrubs sensitive query
    parameters (`password`, `passwd`, `pwd`, `secret`, `token`, `api_key`, `apikey`,
    `sslpassword`) to `***` while preserving scheme, host, port, and database path.
    """
    if not isinstance(database_url, str) or not database_url.strip():
        return ""

    trimmed = database_url.strip()
    if _STANDALONE_URL_RE.match(trimmed) and not any(ch.isspace() for ch in trimmed):
        return _redact_single_url(trimmed)

    def _replace_embedded(match: re.Match[str]) -> str:
        token = match.group(0)
        trailing = ""
        while token and token[-1] in ".:;!" and not token.endswith("://"):
            trailing = token[-1] + trailing
            token = token[:-1]
        return _redact_single_url(token) + trailing

    scrubbed = _EMBEDDED_URL_RE.sub(_replace_embedded, database_url)
    return _DSN_KV_SECRET_RE.sub(r"\1=***", scrubbed)


def _scrub_error_text(message: str, raw_url: str | None = None) -> str:
    text = str(message or "")
    if isinstance(raw_url, str) and raw_url.strip():
        clean_raw = raw_url.strip()
        if clean_raw in text:
            text = text.replace(clean_raw, _redact_single_url(clean_raw))
    return redact_database_url(text) if text.strip() else "Database error"


def apply_sqlite_wal_pragmas(
    dbapi_connection: Any,
    *,
    busy_timeout_ms: int = 5000,
    synchronous: str = "NORMAL",
    foreign_keys: bool = True,
    journal_mode: str = "WAL",
) -> dict[str, Any]:
    """
    Apply whitelisted SQLite WAL, synchronous, busy_timeout, foreign_keys, and temp_store pragmas.

    Raises `ValueError` on any non-whitelisted or out-of-range argument so SQL injection via
    pragma parameters is structurally impossible.
    """
    if not isinstance(journal_mode, str) or journal_mode.strip().upper() not in _VALID_JOURNAL_MODES:
        raise ValueError(
            f"Invalid SQLite journal_mode {journal_mode!r}; expected one of {sorted(_VALID_JOURNAL_MODES)}"
        )
    if not isinstance(synchronous, str) or synchronous.strip().upper() not in _VALID_SYNCHRONOUS_MODES:
        raise ValueError(
            f"Invalid SQLite synchronous mode {synchronous!r}; expected one of {sorted(_VALID_SYNCHRONOUS_MODES)}"
        )
    if not _is_strict_int(busy_timeout_ms) or not (0 <= busy_timeout_ms <= 600_000):
        raise ValueError("busy_timeout_ms must be an integer between 0 and 600000")
    if not isinstance(foreign_keys, bool):
        raise ValueError("foreign_keys must be a boolean")
    if dbapi_connection is None or not callable(getattr(dbapi_connection, "cursor", None)):
        raise ValueError("dbapi_connection must provide a callable cursor() method")

    jm = journal_mode.strip().upper()
    sync_mode = synchronous.strip().upper()
    fk_mode = "ON" if foreign_keys else "OFF"

    cursor = dbapi_connection.cursor()
    actual_jm = jm
    try:
        cursor.execute(f"PRAGMA journal_mode={jm}")
        fetchone = getattr(cursor, "fetchone", None)
        if callable(fetchone):
            row = fetchone()
            if row is not None:
                first_col = row[0] if isinstance(row, tuple | list) and len(row) > 0 else row
                if isinstance(first_col, str) and first_col.strip():
                    actual_jm = first_col.strip().upper()

        cursor.execute(f"PRAGMA synchronous={sync_mode}")
        cursor.execute(f"PRAGMA busy_timeout={busy_timeout_ms}")
        cursor.execute(f"PRAGMA foreign_keys={fk_mode}")
        cursor.execute("PRAGMA temp_store=MEMORY")
    finally:
        close = getattr(cursor, "close", None)
        if callable(close):
            close()

    return {
        "journal_mode": actual_jm,
        "synchronous": sync_mode,
        "busy_timeout_ms": busy_timeout_ms,
        "foreign_keys": fk_mode,
        "temp_store": "MEMORY",
    }


def _validate_engine_options(
    *,
    env_var: Any,
    pool_size: Any,
    max_overflow: Any,
    pool_timeout: Any,
    pool_recycle: Any,
    busy_timeout_ms: Any,
    sqlite_wal: Any,
    synchronous: Any,
    foreign_keys: Any,
    echo: Any,
    safe_tool: str,
) -> tuple[str, dict[str, Any] | None]:
    if not isinstance(env_var, str) or not env_var.strip() or "\x00" in env_var:
        return "", error_envelope("DB_INVALID_OPTIONS", "env_var must be a non-empty string", tool=safe_tool)
    if not _is_strict_int(pool_size) or not (1 <= pool_size <= 256):
        return "", error_envelope(
            "DB_INVALID_OPTIONS",
            "pool_size must be an integer between 1 and 256",
            tool=safe_tool,
        )
    if not _is_strict_int(max_overflow) or not (0 <= max_overflow <= 512):
        return "", error_envelope(
            "DB_INVALID_OPTIONS",
            "max_overflow must be an integer between 0 and 512",
            tool=safe_tool,
        )
    if not _is_finite_number(pool_timeout) or not (0.0 < float(pool_timeout) <= 600.0):
        return "", error_envelope(
            "DB_INVALID_OPTIONS",
            "pool_timeout must be a finite number in (0, 600]",
            tool=safe_tool,
        )
    if not _is_strict_int(pool_recycle) or pool_recycle < -1 or pool_recycle == 0:
        return "", error_envelope(
            "DB_INVALID_OPTIONS",
            "pool_recycle must be -1 or a positive integer",
            tool=safe_tool,
        )
    if not _is_strict_int(busy_timeout_ms) or not (0 <= busy_timeout_ms <= 600_000):
        return "", error_envelope(
            "DB_INVALID_OPTIONS",
            "busy_timeout_ms must be an integer between 0 and 600000",
            tool=safe_tool,
        )
    if not isinstance(sqlite_wal, bool):
        return "", error_envelope("DB_INVALID_OPTIONS", "sqlite_wal must be a boolean", tool=safe_tool)
    if not isinstance(foreign_keys, bool):
        return "", error_envelope("DB_INVALID_OPTIONS", "foreign_keys must be a boolean", tool=safe_tool)
    if not isinstance(echo, bool):
        return "", error_envelope("DB_INVALID_OPTIONS", "echo must be a boolean", tool=safe_tool)
    if not isinstance(synchronous, str) or synchronous.strip().upper() not in _VALID_SYNCHRONOUS_MODES:
        return "", error_envelope(
            "DB_INVALID_OPTIONS",
            f"synchronous must be one of {sorted(_VALID_SYNCHRONOUS_MODES)}",
            tool=safe_tool,
        )
    return synchronous.strip().upper(), None


def _resolve_and_parse_url(
    database_url: Any,
    *,
    env_var: str,
    safe_tool: str,
) -> tuple[str, str, str, str, dict[str, Any] | None]:
    raw_url = database_url if database_url is not None else os.getenv(env_var.strip())
    if not isinstance(raw_url, str) or not raw_url.strip():
        return (
            "",
            "",
            "",
            "",
            error_envelope(
                "DB_MISSING_URL",
                f"Database URL is missing (checked {env_var.strip()})",
                tool=safe_tool,
            ),
        )

    if any(ch in raw_url for ch in ("\x00", "\r", "\n")):
        return (
            "",
            "",
            "",
            "",
            error_envelope(
                "DB_INVALID_URL",
                "Database URL contains forbidden control characters",
                details={"redacted_url": redact_database_url(raw_url)},
                tool=safe_tool,
            ),
        )

    url = raw_url.strip()
    scheme = url.split("://", 1)[0].lower() if "://" in url else ""
    if not scheme or not _SCHEME_RE.match(scheme):
        return (
            "",
            "",
            "",
            "",
            error_envelope(
                "DB_INVALID_URL",
                "Database URL is missing a valid dialect scheme",
                details={"redacted_url": redact_database_url(url)},
                tool=safe_tool,
            ),
        )

    raw_dialect, _, driver = scheme.partition("+")
    dialect = "postgresql" if raw_dialect == "postgres" else raw_dialect
    after_scheme = url.split("://", 1)[1]
    if dialect != "sqlite" and not after_scheme.strip():
        return (
            "",
            "",
            "",
            "",
            error_envelope(
                "DB_INVALID_URL",
                f"Database URL for dialect '{dialect}' is missing host or database target",
                details={"redacted_url": redact_database_url(url)},
                tool=safe_tool,
            ),
        )

    if raw_dialect == "postgres":
        normalized_scheme = f"postgresql+{driver}" if driver else "postgresql"
        url = f"{normalized_scheme}://{after_scheme}"

    return url, raw_dialect, dialect, driver, None


def _is_driver_unavailable_exception(exc: BaseException) -> bool:
    return (
        isinstance(exc, ImportError | ModuleNotFoundError)
        or isinstance(getattr(exc, "__cause__", None), ImportError | ModuleNotFoundError)
        or exc.__class__.__name__ == "NoSuchModuleError"
    )


def _dispose_engine_quietly(engine: Any) -> None:
    if engine is None:
        return
    sync_eng = getattr(engine, "sync_engine", None)
    if sync_eng is not None and callable(getattr(sync_eng, "dispose", None)):
        with contextlib.suppress(Exception):
            sync_eng.dispose()
            return
    dispose_fn = getattr(engine, "dispose", None)
    if callable(dispose_fn) and not inspect.iscoroutinefunction(dispose_fn):
        with contextlib.suppress(Exception):
            res = dispose_fn()
            if inspect.iscoroutine(res):
                res.close()


def _attach_sqlite_listener(
    sa_mod: Any,
    target_engine: Any,
    *,
    busy_timeout_ms: int,
    synchronous: str,
    foreign_keys: bool,
    journal_mode: str,
) -> None:
    if sa_mod is None or target_engine is None:
        return
    event_api = getattr(sa_mod, "event", None)
    listens_for = getattr(event_api, "listens_for", None)
    if not callable(listens_for):
        return
    # Avoid InvalidRequestError when tests inject a plain mock object without SQLAlchemy `_Dispatch`.
    if getattr(target_engine, "dispatch", None) is None and hasattr(sa_mod, "__version__"):
        return

    @listens_for(target_engine, "connect")
    def _on_sqlite_connect(dbapi_conn: Any, _connection_record: Any) -> None:
        apply_sqlite_wal_pragmas(
            dbapi_conn,
            busy_timeout_ms=busy_timeout_ms,
            synchronous=synchronous,
            foreign_keys=foreign_keys,
            journal_mode=journal_mode,
        )


def create_managed_engine(
    database_url: str | None = None,
    *,
    env_var: str = "DATABASE_URL",
    pool_size: int = 5,
    max_overflow: int = 10,
    pool_timeout: float = 30.0,
    pool_recycle: int = 1800,
    busy_timeout_ms: int = 5000,
    sqlite_wal: bool = True,
    synchronous: str = "NORMAL",
    foreign_keys: bool = True,
    echo: bool = False,
    sa_module: Any = None,
    tool: str = "db_async.engine",
) -> dict[str, Any]:
    """Create a managed synchronous SQLAlchemy engine + sessionmaker with SQLite WAL & pool guards."""
    safe_tool = _safe_tool_name(tool, "db_async.engine")
    sync_norm, opt_err = _validate_engine_options(
        env_var=env_var,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_timeout=pool_timeout,
        pool_recycle=pool_recycle,
        busy_timeout_ms=busy_timeout_ms,
        sqlite_wal=sqlite_wal,
        synchronous=synchronous,
        foreign_keys=foreign_keys,
        echo=echo,
        safe_tool=safe_tool,
    )
    if opt_err is not None:
        return opt_err

    url, _raw_dialect, dialect, driver, url_err = _resolve_and_parse_url(
        database_url,
        env_var=env_var,
        safe_tool=safe_tool,
    )
    if url_err is not None:
        return url_err

    redacted = redact_database_url(url)
    if driver in _ASYNC_ONLY_DRIVERS:
        return error_envelope(
            "DB_ASYNC_DRIVER_MISMATCH",
            "Async database driver URL passed to sync create_managed_engine; use create_managed_async_engine",
            details={"redacted_url": redacted},
            tool=safe_tool,
        )

    if sa_module is False:
        return error_envelope(
            "DB_DRIVER_UNAVAILABLE",
            "SQLAlchemy module is disabled or unavailable",
            details={"redacted_url": redacted},
            tool=safe_tool,
        )

    sessionmaker_fn: Callable[..., Any] | None = None
    if sa_module is not None:
        sa = sa_module
        orm_attr = getattr(sa, "orm", None)
        sessionmaker_fn = getattr(orm_attr, "sessionmaker", None) or getattr(sa, "sessionmaker", None)
        if sessionmaker_fn is None:
            with contextlib.suppress(ImportError, ModuleNotFoundError):
                from sqlalchemy.orm import sessionmaker as _sa_sessionmaker

                sessionmaker_fn = _sa_sessionmaker
    else:
        try:
            import sqlalchemy as sa
            import sqlalchemy.orm as sa_orm

            if sa is None or sa_orm is None:  # pragma: no cover - defensive guard
                raise ModuleNotFoundError("sqlalchemy is disabled")
            sessionmaker_fn = sa_orm.sessionmaker
        except (ImportError, ModuleNotFoundError) as exc:
            return error_envelope(
                "DB_DRIVER_UNAVAILABLE",
                _scrub_error_text(f"SQLAlchemy is unavailable: {exc}", url),
                details={"redacted_url": redacted},
                tool=safe_tool,
            )

    target_jm = "WAL" if sqlite_wal else "DELETE"
    engine: Any = None

    try:
        if dialect == "sqlite":
            connect_args = {
                "check_same_thread": False,
                "timeout": max(1.0, busy_timeout_ms / 1000.0),
            }
            engine = sa.create_engine(url, connect_args=connect_args, echo=echo)
            _attach_sqlite_listener(
                sa,
                engine,
                busy_timeout_ms=busy_timeout_ms,
                synchronous=sync_norm,
                foreign_keys=foreign_keys,
                journal_mode=target_jm,
            )
        else:
            engine = sa.create_engine(
                url,
                pool_size=pool_size,
                max_overflow=max_overflow,
                pool_timeout=float(pool_timeout),
                pool_recycle=pool_recycle,
                pool_pre_ping=True,
                echo=echo,
            )

        if callable(sessionmaker_fn):
            session_factory: Callable[[], Any] = sessionmaker_fn(
                bind=engine,
                autocommit=False,
                autoflush=False,
                expire_on_commit=False,
            )
        elif callable(getattr(engine, "session_factory", None)):
            session_factory = engine.session_factory
        else:

            def _fallback_session_factory() -> Any:
                session_attr = getattr(engine, "session", None)
                return session_attr() if callable(session_attr) else engine.connect()

            session_factory = _fallback_session_factory
    except Exception as exc:
        _dispose_engine_quietly(engine)
        code = "DB_DRIVER_UNAVAILABLE" if _is_driver_unavailable_exception(exc) else "DB_ENGINE_ERROR"
        return error_envelope(
            code,
            _scrub_error_text(str(exc), url),
            details={"redacted_url": redacted},
            tool=safe_tool,
        )

    return ok_envelope(
        safe_tool,
        f"Created managed {dialect} engine",
        {
            "engine": engine,
            "session_factory": session_factory,
            "dialect": dialect,
            "redacted_url": redacted,
            "is_async": False,
        },
    )


def create_managed_async_engine(
    database_url: str | None = None,
    *,
    env_var: str = "DATABASE_URL",
    pool_size: int = 5,
    max_overflow: int = 10,
    pool_timeout: float = 30.0,
    pool_recycle: int = 1800,
    busy_timeout_ms: int = 5000,
    sqlite_wal: bool = True,
    synchronous: str = "NORMAL",
    foreign_keys: bool = True,
    echo: bool = False,
    async_engine_factory: Callable[..., Any] | None = None,
    tool: str = "db_async.async_engine",
) -> dict[str, Any]:
    """Create a managed asynchronous SQLAlchemy engine + async_sessionmaker with SQLite WAL & pool guards."""
    safe_tool = _safe_tool_name(tool, "db_async.async_engine")
    sync_norm, opt_err = _validate_engine_options(
        env_var=env_var,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_timeout=pool_timeout,
        pool_recycle=pool_recycle,
        busy_timeout_ms=busy_timeout_ms,
        sqlite_wal=sqlite_wal,
        synchronous=synchronous,
        foreign_keys=foreign_keys,
        echo=echo,
        safe_tool=safe_tool,
    )
    if opt_err is not None:
        return opt_err

    if async_engine_factory is False:
        return error_envelope(
            "DB_DRIVER_UNAVAILABLE",
            "Async database engine factory is disabled",
            tool=safe_tool,
        )
    if async_engine_factory is not None and not callable(async_engine_factory):
        return error_envelope(
            "DB_INVALID_OPTIONS",
            "async_engine_factory must be callable when provided",
            tool=safe_tool,
        )

    url, _raw_dialect, dialect, driver, url_err = _resolve_and_parse_url(
        database_url,
        env_var=env_var,
        safe_tool=safe_tool,
    )
    if url_err is not None:
        return url_err

    redacted = redact_database_url(url)
    if async_engine_factory is None and (not driver or driver not in _ASYNC_CAPABLE_DRIVERS):
        return error_envelope(
            "DB_ASYNC_DRIVER_MISMATCH",
            "Sync database driver URL passed to create_managed_async_engine; use sqlite+aiosqlite:// or postgresql+asyncpg://",
            details={"redacted_url": redacted},
            tool=safe_tool,
        )

    if dialect == "sqlite":
        engine_kwargs: dict[str, Any] = {
            "connect_args": {"timeout": max(1.0, busy_timeout_ms / 1000.0)},
        }
    else:
        engine_kwargs = {
            "pool_size": pool_size,
            "max_overflow": max_overflow,
            "pool_timeout": float(pool_timeout),
            "pool_recycle": pool_recycle,
            "pool_pre_ping": True,
        }

    target_jm = "WAL" if sqlite_wal else "DELETE"
    engine: Any = None

    try:
        sa_mod: Any = None
        async_engine_cls: Any = None
        async_session_cls: Any = None
        async_sessionmaker_fn: Callable[..., Any] | None = None

        if async_engine_factory is not None:
            engine = async_engine_factory(url, echo=echo, **engine_kwargs)
            with contextlib.suppress(ImportError, ModuleNotFoundError):
                import sqlalchemy as _sa
                import sqlalchemy.ext.asyncio as _sa_async

                sa_mod = _sa
                async_engine_cls = _sa_async.AsyncEngine
                async_session_cls = _sa_async.AsyncSession
                async_sessionmaker_fn = _sa_async.async_sessionmaker
        else:
            import sqlalchemy as _sa
            import sqlalchemy.ext.asyncio as _sa_async

            sa_mod = _sa
            async_engine_cls = _sa_async.AsyncEngine
            async_session_cls = _sa_async.AsyncSession
            async_sessionmaker_fn = _sa_async.async_sessionmaker
            engine = _sa_async.create_async_engine(url, echo=echo, **engine_kwargs)

        sync_engine = getattr(engine, "sync_engine", None)
        if dialect == "sqlite" and sync_engine is not None:
            _attach_sqlite_listener(
                sa_mod,
                sync_engine,
                busy_timeout_ms=busy_timeout_ms,
                synchronous=sync_norm,
                foreign_keys=foreign_keys,
                journal_mode=target_jm,
            )

        if (
            async_engine_cls is not None
            and isinstance(engine, async_engine_cls)
            and callable(async_sessionmaker_fn)
        ):
            session_factory: Callable[[], Any] = async_sessionmaker_fn(
                bind=engine,
                class_=async_session_cls,
                autocommit=False,
                autoflush=False,
                expire_on_commit=False,
            )
        else:
            custom_sf = getattr(engine, "session_factory", None)
            if callable(custom_sf):
                session_factory = custom_sf
            else:

                def _mock_async_session_factory() -> Any:
                    return engine.session()

                session_factory = _mock_async_session_factory
    except Exception as exc:
        _dispose_engine_quietly(engine)
        code = "DB_DRIVER_UNAVAILABLE" if _is_driver_unavailable_exception(exc) else "DB_ENGINE_ERROR"
        return error_envelope(
            code,
            _scrub_error_text(str(exc), url),
            details={"redacted_url": redacted},
            tool=safe_tool,
        )

    return ok_envelope(
        safe_tool,
        f"Created managed async {dialect} engine",
        {
            "engine": engine,
            "session_factory": session_factory,
            "dialect": dialect,
            "redacted_url": redacted,
            "is_async": True,
        },
    )


async def _maybe_await(value: Any, *, shielded: bool = False) -> Any:
    if not inspect.isawaitable(value):
        return value
    if shielded:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return await value
        fut = value if isinstance(value, asyncio.Future) else asyncio.ensure_future(value)
        fut.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
        return await asyncio.shield(fut)
    return await value


@contextlib.contextmanager
def session_scope(session_factory: Callable[[], Any]) -> Iterator[Any]:
    """
    Transactional synchronous session scope.

    Commits on normal exit, rolls back and re-raises on `BaseException` (never masking the
    original exception if rollback fails), and closes the session in `finally`.
    """
    if not callable(session_factory):
        raise TypeError("session_factory must be callable")

    session = session_factory()
    exc_in_flight = False
    try:
        yield session
        session.commit()
    except BaseException:
        exc_in_flight = True
        with contextlib.suppress(Exception):
            rollback = getattr(session, "rollback", None)
            if callable(rollback):
                rollback()
        raise
    finally:
        close = getattr(session, "close", None)
        if callable(close):
            if exc_in_flight:
                with contextlib.suppress(Exception):
                    close()
            else:
                close()


@contextlib.asynccontextmanager
async def async_session_scope(session_factory: Callable[[], Any]) -> AsyncIterator[Any]:
    """
    Transactional asynchronous session scope.

    Commits on normal exit, shields/awaits `session.rollback()` on `BaseException` (including
    `asyncio.CancelledError`) without masking the primary exception, and closes in `finally`.
    """
    if not callable(session_factory):
        raise TypeError("session_factory must be callable")

    session = await _maybe_await(session_factory())
    exc_in_flight = False
    try:
        yield session
        commit = getattr(session, "commit", None)
        if callable(commit):
            await _maybe_await(commit())
    except BaseException:
        exc_in_flight = True
        with contextlib.suppress(Exception, asyncio.CancelledError):
            rollback = getattr(session, "rollback", None)
            if callable(rollback):
                await _maybe_await(rollback(), shielded=True)
        raise
    finally:
        close = getattr(session, "close", None)
        if callable(close):
            if exc_in_flight:
                with contextlib.suppress(Exception, asyncio.CancelledError):
                    await _maybe_await(close(), shielded=True)
            else:
                await _maybe_await(close(), shielded=True)


def _extract_engine_dialect(engine: Any) -> str:
    dialect_attr = getattr(engine, "dialect", None)
    if isinstance(dialect_attr, str) and dialect_attr.strip():
        return dialect_attr.strip().lower()
    dialect_name = getattr(dialect_attr, "name", None)
    if isinstance(dialect_name, str) and dialect_name.strip():
        return dialect_name.strip().lower()
    sync_eng = getattr(engine, "sync_engine", None)
    if sync_eng is not None and sync_eng is not engine:
        return _extract_engine_dialect(sync_eng)
    url_attr = getattr(engine, "url", None)
    if url_attr is not None:
        url_str = str(url_attr)
        if "://" in url_str:
            base = url_str.split("://", 1)[0].lower().split("+", 1)[0]
            return "postgresql" if base == "postgres" else base
    return "unknown"


def _extract_raw_engine_url(engine: Any) -> str | None:
    url_obj = getattr(engine, "url", None)
    if url_obj is None:
        sync_eng = getattr(engine, "sync_engine", None)
        url_obj = getattr(sync_eng, "url", None) if sync_eng is not None else None
    if url_obj is None:
        return None
    render = getattr(url_obj, "render_as_string", None)
    if callable(render):
        with contextlib.suppress(Exception):
            rendered = render(hide_password=False)
            if isinstance(rendered, str) and rendered:
                return rendered
    return str(url_obj)


def _build_sql_clause(sql: str) -> Any:
    with contextlib.suppress(ImportError, ModuleNotFoundError):
        from sqlalchemy import text as sa_text

        return sa_text(sql)
    return sql


def _extract_scalar_str(result: Any) -> str | None:
    if result is None:
        return None
    if isinstance(result, str) and result.strip():
        return result.strip().lower()
    scalar_fn = getattr(result, "scalar", None)
    if callable(scalar_fn):
        val = scalar_fn()
        if isinstance(val, str) and val.strip():
            return val.strip().lower()
    fetchone_fn = getattr(result, "fetchone", None)
    if callable(fetchone_fn):
        row = fetchone_fn()
        if isinstance(row, tuple | list) and len(row) > 0 and isinstance(row[0], str) and row[0].strip():
            return row[0].strip().lower()
        if isinstance(row, str) and row.strip():
            return row.strip().lower()
    return None


def check_engine_health(
    engine: Any,
    *,
    tool: str = "db_async.health",
) -> dict[str, Any]:
    """Execute `SELECT 1` (and `PRAGMA journal_mode` for SQLite) on a synchronous engine."""
    safe_tool = _safe_tool_name(tool, "db_async.health")
    if engine is None or not callable(getattr(engine, "connect", None)):
        return error_envelope("DB_UNHEALTHY", "Invalid engine instance", tool=safe_tool)

    dialect = _extract_engine_dialect(engine)
    raw_url = _extract_raw_engine_url(engine)
    journal_mode: str | None = None

    try:
        with engine.connect() as conn:
            conn.execute(_build_sql_clause("SELECT 1"))
            if dialect == "sqlite":
                jm_res = conn.execute(_build_sql_clause("PRAGMA journal_mode"))
                journal_mode = _extract_scalar_str(jm_res)
    except Exception as exc:
        scrubbed_msg = _scrub_error_text(str(exc) or "Database health check failed", raw_url)
        return error_envelope(
            "DB_UNHEALTHY",
            scrubbed_msg,
            details={"dialect": dialect},
            tool=safe_tool,
        )

    return ok_envelope(
        safe_tool,
        "Database engine is healthy",
        {
            "healthy": True,
            "dialect": dialect,
            "journal_mode": journal_mode,
        },
    )


async def check_async_engine_health(
    engine: Any,
    *,
    tool: str = "db_async.health",
) -> dict[str, Any]:
    """Execute `SELECT 1` (and `PRAGMA journal_mode` for SQLite) on an asynchronous engine."""
    safe_tool = _safe_tool_name(tool, "db_async.health")
    if engine is None or not callable(getattr(engine, "connect", None)):
        return error_envelope("DB_UNHEALTHY", "Invalid engine instance", tool=safe_tool)

    dialect = _extract_engine_dialect(engine)
    raw_url = _extract_raw_engine_url(engine)
    journal_mode: str | None = None

    try:
        conn_ctx = engine.connect()
        if inspect.isawaitable(conn_ctx) and not hasattr(conn_ctx, "__aenter__"):
            conn_ctx = await conn_ctx
        async with conn_ctx as conn:
            await _maybe_await(conn.execute(_build_sql_clause("SELECT 1")))
            if dialect == "sqlite":
                jm_res = await _maybe_await(conn.execute(_build_sql_clause("PRAGMA journal_mode")))
                journal_mode = _extract_scalar_str(jm_res)
    except Exception as exc:
        scrubbed_msg = _scrub_error_text(str(exc) or "Database health check failed", raw_url)
        return error_envelope(
            "DB_UNHEALTHY",
            scrubbed_msg,
            details={"dialect": dialect},
            tool=safe_tool,
        )

    return ok_envelope(
        safe_tool,
        "Database engine is healthy",
        {
            "healthy": True,
            "dialect": dialect,
            "journal_mode": journal_mode,
        },
    )
