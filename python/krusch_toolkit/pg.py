"""
PostgreSQL & pgvector Lego Bricks — SQL-injection-guarded identifiers, safe URI builder,
1024d pgvector literal formatting, idempotent transactional migrations, and cosine search.

Imports cleanly in bare Python 3.11+ without requiring a running PostgreSQL server or psycopg2.
"""

from __future__ import annotations

import contextlib
import ipaddress
import os
import re
from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import quote

from krusch_toolkit.embeddings import DEFAULT_EMBED_DIMS, validate_vector_dimension
from krusch_toolkit.fastapi_app import ok_envelope

__all__ = [
    "assert_safe_pg_identifier",
    "build_pg_connection_string",
    "format_pgvector_literal",
    "run_sql_migrations",
    "pg_vector_search",
]

_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_UNSAFE_HOST_RE = re.compile(r"[\s/@?#\\\x00]")
_LEADING_WHERE_RE = re.compile(r"^WHERE(?:\s+|$)", re.IGNORECASE)
_DISALLOWED_WHERE_KEYWORDS_RE = re.compile(
    r"(?<![\w$])(?:"
    r"SELECT|TABLE|VALUES|WITH(?!\s+TIME\s+ZONE(?![\w$]))|UNION|INTERSECT|EXCEPT|INTO|COPY|"
    r"INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXECUTE|PREPARE|"
    r"DEALLOCATE|CALL|DO|SET|SHOW|RESET|DISCARD|FETCH|MOVE|DECLARE|CLOSE|LOCK|LISTEN|"
    r"UNLISTEN|NOTIFY|LOAD|VACUUM|ANALYZE|EXPLAIN|CLUSTER|REINDEX|REFRESH|CHECKPOINT|"
    r"COMMENT|SECURITY|PG_NOTIFY|SET_CONFIG|CURRENT_SETTING|CURRENT_USER|SESSION_USER|"
    r"SYSTEM_USER|USER|CURRENT_ROLE|CURRENT_DATABASE|CURRENT_SCHEMA|CURRENT_CATALOG|"
    r"REGCLASS|REGPROC|REGPROCEDURE|REGOPER|REGOPERATOR|REGTYPE|REGROLE|REGNAMESPACE|"
    r"REGCONFIG|REGDICTIONARY|PG_SLEEP|PG_READ_FILE|PG_READ_BINARY_FILE|PG_LS_DIR|"
    r"PG_STAT_FILE|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|PG_RELOAD_CONF|"
    r"PG_ROTATE_LOGFILE|PG_ADVISORY_LOCK|PG_ADVISORY_XACT_LOCK|LO_IMPORT|LO_EXPORT|DBLINK|"
    r"QUERY_TO_XML|QUERY_TO_XMLSCHEMA|QUERY_TO_XML_AND_XMLSCHEMA|"
    r"TABLE_TO_XML|TABLE_TO_XMLSCHEMA|TABLE_TO_XML_AND_XMLSCHEMA|"
    r"CURSOR_TO_XML|CURSOR_TO_XMLSCHEMA|SCHEMA_TO_XML|SCHEMA_TO_XMLSCHEMA|"
    r"SCHEMA_TO_XML_AND_XMLSCHEMA|DATABASE_TO_XML|DATABASE_TO_XMLSCHEMA|"
    r"DATABASE_TO_XML_AND_XMLSCHEMA|XMLTABLE|JSON_TABLE|XPATH|XPATH_EXISTS|XMLPARSE"
    r")(?![\w$])",
    re.IGNORECASE,
)
_SCHEMA_QUALIFIED_CALL_RE = re.compile(
    r"(?<![\w$])[^\W\d][\w$]*\s*\.\s*(?:[^\W\d][\w$]*|_ident_)\s*\("
)
_CALLABLE_TOKEN_RE = re.compile(r"(?<![\w$])([^\W\d][\w$]*)\s*\(")
_SAFE_WHERE_CALLABLES = frozenset(
    {
        "AND",
        "OR",
        "NOT",
        "IN",
        "ANY",
        "SOME",
        "ALL",
        "SIMILAR",
        "SYMMETRIC",
        "ASYMMETRIC",
        "BETWEEN",
        "IS",
        "DISTINCT",
        "CASE",
        "WHEN",
        "THEN",
        "ELSE",
        "COALESCE",
        "NULLIF",
        "GREATEST",
        "LEAST",
        "CAST",
        "ROW",
        "LOWER",
        "UPPER",
        "TRIM",
        "BTRIM",
        "LTRIM",
        "RTRIM",
        "LENGTH",
        "CHAR_LENGTH",
        "CHARACTER_LENGTH",
        "OCTET_LENGTH",
        "SUBSTRING",
        "SUBSTR",
        "LEFT",
        "RIGHT",
        "LPAD",
        "RPAD",
        "REPLACE",
        "SPLIT_PART",
        "STARTS_WITH",
        "POSITION",
        "STRPOS",
        "CONCAT",
        "CONCAT_WS",
        "ABS",
        "MOD",
        "ROUND",
        "TRUNC",
        "CEIL",
        "CEILING",
        "FLOOR",
        "SIGN",
        "SQRT",
        "POWER",
        "NOW",
        "DATE_TRUNC",
        "DATE_PART",
        "EXTRACT",
        "AGE",
        "TO_CHAR",
        "TO_DATE",
        "TO_TIMESTAMP",
        "TO_NUMBER",
        "ARRAY_LENGTH",
        "ARRAY_POSITION",
        "CARDINALITY",
        "JSONB_EXTRACT_PATH_TEXT",
        "JSON_EXTRACT_PATH_TEXT",
        "JSONB_TYPEOF",
        "JSON_TYPEOF",
        "JSONB_ARRAY_LENGTH",
        "JSON_ARRAY_LENGTH",
        "VARCHAR",
        "CHAR",
        "CHARACTER",
        "VARYING",
        "NUMERIC",
        "DECIMAL",
        "BIT",
        "VARBIT",
        "TIMESTAMP",
        "TIMESTAMPTZ",
        "TIME",
        "TIMETZ",
        "INTERVAL",
        "VECTOR",
        "SPARSEVEC",
    }
)


def assert_safe_pg_identifier(identifier: str, label: str = "identifier") -> str:
    """Validate a PostgreSQL identifier against SQL injection (`^[A-Za-z_][A-Za-z0-9_]*$`)."""
    if not isinstance(identifier, str):
        raise ValueError(f"[pg] Unsafe SQL {label}: expected str, got {type(identifier).__name__}.")
    cleaned = identifier.strip()
    if not _IDENT_RE.fullmatch(cleaned):
        raise ValueError(
            f'[pg] Unsafe SQL {label}: "{identifier}". Must match ^[A-Za-z_][A-Za-z0-9_]*$.'
        )
    return cleaned


def build_pg_connection_string(config: dict[str, Any] | None = None) -> str:
    """
    Resolve a PostgreSQL connection URL from `config["url"]`, `DATABASE_URL`, or URI-encoded
    connection parameters while validating host characters and TCP port bounds (`1..65535`).
    """
    if config is not None and not isinstance(config, dict):
        raise ValueError(f"[pg] config must be a dict or None, got {type(config).__name__}.")

    cfg = config or {}
    direct_url = cfg.get("url")
    if isinstance(direct_url, str) and direct_url.strip():
        clean_url = direct_url.strip()
        if any(ch in clean_url for ch in ("\r", "\n", "\x00")):
            raise ValueError("[pg] Connection URL must not contain CR/LF/NUL characters.")
        return clean_url

    component_keys = ("host", "port", "user", "password", "database", "db_name", "dbname")
    has_explicit_components = any(cfg.get(k) is not None for k in component_keys)
    env_url = os.environ.get("DATABASE_URL")
    if not has_explicit_components and isinstance(env_url, str) and env_url.strip():
        clean_env_url = env_url.strip()
        if any(ch in clean_env_url for ch in ("\r", "\n", "\x00")):
            raise ValueError("[pg] DATABASE_URL must not contain CR/LF/NUL characters.")
        return clean_env_url

    raw_host_val = cfg["host"] if cfg.get("host") is not None else os.environ.get("PGHOST", "127.0.0.1")
    if not isinstance(raw_host_val, str) or not raw_host_val.strip():
        raise ValueError("[pg] PostgreSQL host must be a non-empty string.")
    raw_host = raw_host_val.strip()
    if _UNSAFE_HOST_RE.search(raw_host) or "%" in raw_host:
        raise ValueError(f'[pg] Unsafe characters in PostgreSQL host: "{raw_host_val}".')

    if ":" in raw_host or "[" in raw_host or "]" in raw_host:
        ipv6_candidate = (
            raw_host[1:-1] if raw_host.startswith("[") and raw_host.endswith("]") else raw_host
        )
        try:
            ipaddress.IPv6Address(ipv6_candidate)
        except ValueError as exc:
            raise ValueError(f'[pg] Invalid PostgreSQL host or IPv6 literal: "{raw_host_val}".') from exc
        formatted_host = f"[{ipv6_candidate}]"
    else:
        formatted_host = raw_host

    raw_port = cfg["port"] if cfg.get("port") is not None else os.environ.get("PGPORT", 5432)
    if isinstance(raw_port, bool):
        raise ValueError("[pg] PostgreSQL port must be an integer in 1..65535, got bool.")
    try:
        port_int = int(raw_port)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"[pg] Invalid PostgreSQL port: {raw_port!r}.") from exc
    if not (1 <= port_int <= 65535):
        raise ValueError(f"[pg] PostgreSQL port out of range (1..65535): {port_int}.")

    user = str(cfg["user"] if cfg.get("user") is not None else os.environ.get("PGUSER", "postgres"))
    password = str(
        cfg["password"] if cfg.get("password") is not None else os.environ.get("PGPASSWORD", "")
    )
    raw_db = (
        cfg.get("database")
        if cfg.get("database") is not None
        else cfg.get("db_name")
        if cfg.get("db_name") is not None
        else cfg.get("dbname")
        if cfg.get("dbname") is not None
        else os.environ.get("PGDATABASE", "postgres")
    )
    db_name = str(raw_db)
    if not db_name:
        raise ValueError("[pg] PostgreSQL database name must be non-empty.")

    return (
        f"postgresql://{quote(user, safe='')}:{quote(password, safe='')}"
        f"@{formatted_host}:{port_int}/{quote(db_name, safe='')}"
    )


def format_pgvector_literal(vector: Sequence[float], expected_dims: int = DEFAULT_EMBED_DIMS) -> str:
    """Validate dimensionality and finite float components (rejecting `bool`), formatting a pgvector literal."""
    if isinstance(expected_dims, bool) or not isinstance(expected_dims, int) or expected_dims <= 0:
        raise ValueError(f"[pgvector] expected_dims must be a positive int, got {expected_dims!r}.")
    if vector is None or isinstance(vector, (str, bytes, bytearray)) or not isinstance(vector, Sequence):
        raise ValueError(f"[pgvector] Expected sequence of floats, got {type(vector).__name__}.")

    for elem in vector:
        if isinstance(elem, bool) or not isinstance(elem, (int, float)):
            raise ValueError(f"[pgvector] Vector contains non-numeric element: {type(elem).__name__}.")

    validated = validate_vector_dimension(list(vector), expected_dim=expected_dims, context="pgvector")
    if validated is None:
        raise ValueError("[pgvector] Vector cannot be None.")

    formatted_vals = [f"{(0.0 if float(v) == 0.0 else float(v)):.10g}" for v in validated]
    return "[" + ",".join(formatted_vals) + "]"


def _acquire_dbapi_connection(conn_or_engine: Any, caller: str) -> tuple[Any, bool]:
    if callable(getattr(conn_or_engine, "cursor", None)):
        return conn_or_engine, False
    raw_conn_fn = getattr(conn_or_engine, "raw_connection", None)
    if callable(raw_conn_fn):
        return raw_conn_fn(), True
    raise ValueError(
        f"[{caller}] Expected DB-API2 connection (.cursor()) or SQLAlchemy Engine (.raw_connection())."
    )


def _close_quietly(resource: Any) -> None:
    close_fn = getattr(resource, "close", None)
    if callable(close_fn):
        with contextlib.suppress(Exception):
            close_fn()


def _is_ident_or_prefix_char(ch: str) -> bool:
    return bool(ch) and (ch.isalnum() or ch in ("_", "&", "$") or ord(ch) >= 0x80)


def _sanitize_where_sql(where_sql: str, *, expected_param_count: int = 0) -> str:
    if not isinstance(where_sql, str):
        raise ValueError(f"[pg.vector_search] where_sql must be a str, got {type(where_sql).__name__}.")
    if "\x00" in where_sql:
        raise ValueError("[pg.vector_search] NUL byte disallowed in where_sql.")

    raw_stripped = where_sql.strip()
    if not raw_stripped:
        if expected_param_count != 0:
            raise ValueError("[pg.vector_search] params cannot be supplied when where_sql is empty.")
        return ""

    if raw_stripped.upper() == "WHERE":
        raise ValueError("[pg.vector_search] Empty WHERE keyword in where_sql.")

    cleaned = _LEADING_WHERE_RE.sub("", raw_stripped, count=1).strip()
    if not cleaned:
        raise ValueError("[pg.vector_search] Empty WHERE predicate in where_sql.")

    in_single = False
    in_double = False
    paren_depth = 0
    placeholder_count = 0
    unquoted_chars: list[str] = []
    idx = 0
    length = len(cleaned)

    while idx < length:
        ch = cleaned[idx]
        nxt = cleaned[idx + 1] if idx + 1 < length else ""

        if in_single:
            if ch == "\\":
                raise ValueError("[pg.vector_search] Backslash escapes disallowed in where_sql literals.")
            if ch == "%":
                raise ValueError(
                    "[pg.vector_search] '%' disallowed inside quoted literals in where_sql (bind via %s params)."
                )
            if ch == "'" and nxt == "'":
                idx += 2
                continue
            if ch == "'":
                in_single = False
            idx += 1
            continue

        if in_double:
            if ch == "%":
                raise ValueError(
                    "[pg.vector_search] '%' disallowed inside quoted identifiers in where_sql."
                )
            if ch == '"' and nxt == '"':
                idx += 2
                continue
            if ch == '"':
                in_double = False
                look = idx + 1
                while look < length and cleaned[look].isspace():
                    look += 1
                if look < length and cleaned[look] == "(":
                    raise ValueError(
                        "[pg.vector_search] Disallowed double-quoted function call in where_sql."
                    )
            idx += 1
            continue

        if ch == "'":
            prev = cleaned[idx - 1] if idx > 0 else ""
            if _is_ident_or_prefix_char(prev):
                raise ValueError(
                    "[pg.vector_search] Prefixed PostgreSQL string literals disallowed in where_sql (use %s params)."
                )
            in_single = True
            unquoted_chars.append(" ")
            idx += 1
            continue

        if ch == '"':
            prev = cleaned[idx - 1] if idx > 0 else ""
            if _is_ident_or_prefix_char(prev):
                raise ValueError(
                    "[pg.vector_search] Prefixed or Unicode-escaped identifiers disallowed in where_sql."
                )
            in_double = True
            unquoted_chars.append(" _ident_ ")
            idx += 1
            continue

        if ch == "$":
            raise ValueError("[pg.vector_search] Dollar-quoting disallowed in where_sql (use %s params).")

        if ch == "%":
            prev = cleaned[idx - 1] if idx > 0 else ""
            after = cleaned[idx + 2] if idx + 2 < length else ""
            if (
                nxt != "s"
                or (prev and (prev.isalnum() or prev in ("_", "$") or ord(prev) >= 0x80))
                or (after and (after.isalnum() or after in ("_", "$") or ord(after) >= 0x80))
            ):
                raise ValueError(
                    "[pg.vector_search] Invalid '%' token in where_sql (only positional %s placeholders are allowed)."
                )
            placeholder_count += 1
            unquoted_chars.append(" __param__ ")
            idx += 2
            continue

        if (
            ch in (";", "\\")
            or (ch == "-" and nxt == "-")
            or (ch == "/" and nxt == "*")
            or (ch == "*" and nxt == "/")
        ):
            raise ValueError("[pg.vector_search] Unsafe SQL token disallowed in where_sql.")

        if ch == "(":
            paren_depth += 1
        elif ch == ")":
            paren_depth -= 1
            if paren_depth < 0:
                raise ValueError("[pg.vector_search] Unbalanced parentheses in where_sql.")

        unquoted_chars.append(ch)
        idx += 1

    if in_single or in_double or paren_depth != 0:
        raise ValueError("[pg.vector_search] Unclosed quote or unbalanced parentheses in where_sql.")

    unquoted = "".join(unquoted_chars)
    if _DISALLOWED_WHERE_KEYWORDS_RE.search(unquoted):
        raise ValueError("[pg.vector_search] Disallowed SQL keyword in where_sql.")

    if _SCHEMA_QUALIFIED_CALL_RE.search(unquoted):
        raise ValueError("[pg.vector_search] Disallowed schema-qualified function call in where_sql.")

    for call_match in _CALLABLE_TOKEN_RE.finditer(unquoted):
        fn_name = call_match.group(1).upper()
        if fn_name == "_IDENT_":
            raise ValueError("[pg.vector_search] Disallowed double-quoted function call in where_sql.")
        if fn_name not in _SAFE_WHERE_CALLABLES:
            raise ValueError(
                f'[pg.vector_search] Disallowed SQL function "{call_match.group(1)}" in where_sql.'
            )

    if placeholder_count != expected_param_count:
        raise ValueError(
            f"[pg.vector_search] Placeholder count mismatch in where_sql: "
            f"found {placeholder_count} %s placeholder(s), got {expected_param_count} param(s)."
        )

    return cleaned


def run_sql_migrations(
    conn_or_engine: Any,
    migrations: Sequence[dict[str, str]],
    *,
    table_name: str = "schema_migrations",
) -> dict[str, Any]:
    """
    Execute idempotent `{"id": ..., "sql": ...}` migrations transactionally across DB-API2
    connections or SQLAlchemy `Engine` instances and return an INV-LEGO-01 envelope.
    """
    safe_table = assert_safe_pg_identifier(table_name, "table_name")
    if isinstance(migrations, (str, bytes)) or not isinstance(migrations, Sequence):
        raise ValueError("[pg.migrate] migrations must be a sequence of {'id', 'sql'} dicts.")

    validated_migrations: list[tuple[str, str]] = []
    for item in migrations:
        if not isinstance(item, Mapping):
            raise ValueError("[pg.migrate] Each migration must be a mapping with 'id' and 'sql'.")
        raw_id = item.get("id")
        raw_sql = item.get("sql")
        if not isinstance(raw_id, str) or not raw_id.strip():
            raise ValueError("[pg.migrate] Each migration must define a non-empty string 'id'.")
        if not isinstance(raw_sql, str) or not raw_sql.strip():
            raise ValueError(f"[pg.migrate] Migration '{raw_id.strip()}' must define non-empty 'sql'.")
        validated_migrations.append((raw_id.strip(), raw_sql))

    conn, owns_conn = _acquire_dbapi_connection(conn_or_engine, "pg.migrate")
    commit_fn = getattr(conn, "commit", None)
    rollback_fn = getattr(conn, "rollback", None)
    try:
        cur = conn.cursor()
        try:
            cur.execute(
                f"CREATE TABLE IF NOT EXISTS {safe_table} ("
                "id TEXT PRIMARY KEY, "
                "applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
                ")"
            )
            cur.execute(f"SELECT id FROM {safe_table}")
            existing_rows = cur.fetchall() or []
            if callable(commit_fn):
                commit_fn()
        except Exception:
            if callable(rollback_fn):
                with contextlib.suppress(Exception):
                    rollback_fn()
            raise
        finally:
            _close_quietly(cur)

        applied_set = {
            str(row["id"] if isinstance(row, Mapping) else row[0])
            for row in existing_rows
        }

        applied: list[str] = []
        skipped: list[str] = []

        for mig_id, mig_sql in validated_migrations:
            if mig_id in applied_set:
                skipped.append(mig_id)
                continue

            mig_cur = conn.cursor()
            try:
                mig_cur.execute(mig_sql)
                mig_cur.execute(f"INSERT INTO {safe_table} (id) VALUES (%s)", (mig_id,))
                if callable(commit_fn):
                    commit_fn()
            except Exception:
                if callable(rollback_fn):
                    with contextlib.suppress(Exception):
                        rollback_fn()
                raise
            finally:
                _close_quietly(mig_cur)

            applied_set.add(mig_id)
            applied.append(mig_id)

        return ok_envelope(
            "pg.migrate",
            f"Applied {len(applied)} migration(s), skipped {len(skipped)}",
            {"applied": applied, "skipped": skipped},
        )
    finally:
        if owns_conn:
            _close_quietly(conn)


def pg_vector_search(
    conn_or_engine: Any,
    *,
    table: str,
    vector: Sequence[float],
    embedding_column: str = "embedding",
    select_columns: Sequence[str] = ("id",),
    where_sql: str = "",
    params: Sequence[Any] = (),
    limit: int = 10,
    expected_dims: int = DEFAULT_EMBED_DIMS,
) -> dict[str, Any]:
    """
    Execute a SQL-injection-guarded pgvector cosine distance (`<=>`) search via DB-API2 cursor,
    mapping `cursor.description` columns to dicts inside an INV-LEGO-01 envelope.
    """
    safe_table = assert_safe_pg_identifier(table, "table")
    safe_emb_col = assert_safe_pg_identifier(embedding_column, "embedding_column")

    if (
        isinstance(select_columns, (str, bytes))
        or not isinstance(select_columns, Sequence)
        or len(select_columns) == 0
    ):
        raise ValueError("[pg.vector_search] select_columns must be a non-empty sequence of column names.")
    safe_cols = [assert_safe_pg_identifier(col, "select_column") for col in select_columns]

    if isinstance(params, (str, bytes)) or not isinstance(params, Sequence):
        raise ValueError("[pg.vector_search] params must be a sequence of query parameter values.")
    param_tuple = tuple(params)

    cleaned_where = _sanitize_where_sql(where_sql, expected_param_count=len(param_tuple))

    if isinstance(limit, bool):
        raise ValueError("[pg.vector_search] limit must be an integer, got bool.")
    safe_limit = max(1, min(200, int(limit)))
    vec_literal = format_pgvector_literal(vector, expected_dims)

    cols_sql = ", ".join(safe_cols)
    where_clause = f" WHERE ({cleaned_where})" if cleaned_where else ""
    sql = (
        f"SELECT {cols_sql}, 1 - ({safe_emb_col} <=> %s::vector) AS similarity "
        f"FROM {safe_table}{where_clause} "
        f"ORDER BY {safe_emb_col} <=> %s::vector ASC "
        f"LIMIT %s"
    )
    bound_params = (vec_literal, *param_tuple, vec_literal, safe_limit)

    conn, owns_conn = _acquire_dbapi_connection(conn_or_engine, "pg.vector_search")
    try:
        cur = conn.cursor()
        try:
            cur.execute(sql, bound_params)
            raw_rows = cur.fetchall() or []
            description = getattr(cur, "description", None)
        finally:
            _close_quietly(cur)
    finally:
        if owns_conn:
            _close_quietly(conn)

    if description:
        col_names = [
            str(col[0] if isinstance(col, (tuple, list)) else getattr(col, "name", col[0]))
            for col in description
        ]
    else:
        col_names = [*safe_cols, "similarity"]

    rows: list[dict[str, Any]] = [
        dict(row) if isinstance(row, Mapping) else dict(zip(col_names, row, strict=False))
        for row in raw_rows
    ]

    return ok_envelope(
        "pg.vector_search",
        f"Retrieved {len(rows)} vector match(es)",
        {"rows": rows},
    )
