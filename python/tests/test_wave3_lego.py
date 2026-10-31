"""Comprehensive Wave 3 Lego parity tests for krusch_toolkit.{mcp,pg,security} (INV-LEGO-14)."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from krusch_toolkit.fastapi_app import error_envelope, ok_envelope
from krusch_toolkit.mcp import (
    define_mcp_tool,
    dispatch_mcp_tool,
    error_mcp_result,
    ok_mcp_result,
    validate_tool_args,
)
from krusch_toolkit.pg import (
    assert_safe_pg_identifier,
    build_pg_connection_string,
    format_pgvector_literal,
    pg_vector_search,
    run_sql_migrations,
)
from krusch_toolkit.security import (
    constant_time_equal,
    is_private_or_reserved_ip,
    validate_outbound_url,
    verify_bearer_token,
    verify_webhook_hmac,
)

LIB_PY_ROOT = str(Path(__file__).resolve().parents[1])


# ---------------------------------------------------------------------------
# Bare Python 3.11+ Import Purity (Zero Optional Dependencies Required)
# ---------------------------------------------------------------------------


def test_bare_python_import_safety_without_optional_packages() -> None:
    """Verify mcp, pg, and security import cleanly in isolated Python -S/no-site or blocked fastapi/psycopg2."""
    script = (
        "import builtins\n"
        "_orig = builtins.__import__\n"
        "def _guarded(name, *args, **kwargs):\n"
        "    if name.split('.')[0] in {'fastapi', 'starlette', 'psycopg2', 'psycopg', 'sqlalchemy'}:\n"
        "        raise ModuleNotFoundError(f'Blocked optional dependency: {name}')\n"
        "    return _orig(name, *args, **kwargs)\n"
        "builtins.__import__ = _guarded\n"
        "import krusch_toolkit.mcp as m\n"
        "import krusch_toolkit.pg as p\n"
        "import krusch_toolkit.security as s\n"
        "assert callable(m.define_mcp_tool)\n"
        "assert callable(p.pg_vector_search)\n"
        "assert callable(s.validate_outbound_url)\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", script],
        env={"PYTHONPATH": LIB_PY_ROOT, "PATH": ""},
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"Isolated import failed:\nSTDOUT: {proc.stdout}\nSTDERR: {proc.stderr}"


# ---------------------------------------------------------------------------
# 1. krusch_toolkit.mcp Tests
# ---------------------------------------------------------------------------


def test_define_mcp_tool_defaults_and_inv_stack_03_annotations() -> None:
    tool = define_mcp_tool(
        name="  search_docs  ",
        description="Search indexed documents",
        input_schema={"required": ["query"], "properties": {"query": {"type": "string"}}},
    )
    assert tool["name"] == "search_docs"
    assert tool["description"] == "Search indexed documents"
    assert tool["inputSchema"] == {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    }
    annotations = tool["annotations"]
    assert annotations == {
        "title": "search_docs",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    }
    for key in ("readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"):
        assert type(annotations[key]) is bool


def test_define_mcp_tool_explicit_false_hints_and_invalid_name() -> None:
    tool = define_mcp_tool(
        name="purge_cache",
        title="Purge Cache",
        read_only_hint=False,
        destructive_hint=True,
        idempotent_hint=False,
        open_world_hint=True,
        category="admin",
    )
    assert tool["category"] == "admin"
    assert tool["annotations"] == {
        "title": "Purge Cache",
        "readOnlyHint": False,
        "destructiveHint": True,
        "idempotentHint": False,
        "openWorldHint": True,
    }

    with pytest.raises(ValueError, match="non-empty string"):
        define_mcp_tool(name="   ")

    with pytest.raises(ValueError, match="non-empty string"):
        define_mcp_tool(name="")


def test_ok_and_error_mcp_result_envelopes() -> None:
    ok_res = ok_mcp_result("repo.lookup", "Found symbol", {"symbol": "create_fastapi_app"})
    assert "isError" not in ok_res
    assert len(ok_res["content"]) == 1
    assert ok_res["content"][0]["type"] == "text"
    parsed_ok = json.loads(ok_res["content"][0]["text"])
    assert parsed_ok == {
        "ok": True,
        "tool": "repo.lookup",
        "summary": "Found symbol",
        "data": {"symbol": "create_fastapi_app"},
    }

    err_res = error_mcp_result("repo.lookup", "NOT_FOUND", "Symbol missing", {"query": "ghost"})
    assert err_res["isError"] is True
    parsed_err = json.loads(err_res["content"][0]["text"])
    assert parsed_err == {
        "ok": False,
        "tool": "repo.lookup",
        "summary": "Symbol missing",
        "error": {
            "code": "NOT_FOUND",
            "message": "Symbol missing",
            "details": {"query": "ghost"},
        },
    }


def test_validate_tool_args_falsy_values_vs_none_and_non_dict() -> None:
    tool_def = define_mcp_tool(
        name="configure_limit",
        input_schema={
            "type": "object",
            "properties": {
                "count": {"type": "integer"},
                "enabled": {"type": "boolean"},
                "prefix": {"type": "string"},
            },
            "required": ["count", "enabled", "prefix"],
        },
    )

    # 0, False, and "" are valid values and MUST NOT be rejected
    assert validate_tool_args(tool_def, {"count": 0, "enabled": False, "prefix": ""}) == {
        "valid": True,
        "missing": [],
    }

    # Missing key and explicit None MUST be rejected
    assert validate_tool_args(tool_def, {"count": 0, "enabled": None}) == {
        "valid": False,
        "missing": ["enabled", "prefix"],
    }

    # None args or non-dict args (e.g. list/str) mark all required fields missing
    assert validate_tool_args(tool_def, None) == {
        "valid": False,
        "missing": ["count", "enabled", "prefix"],
    }
    assert validate_tool_args(tool_def, ["not", "a", "dict"]) == {  # type: ignore[arg-type]
        "valid": False,
        "missing": ["count", "enabled", "prefix"],
    }


def test_dispatch_mcp_tool_sync_async_unknown_validation_and_exception() -> None:
    tools = [
        {
            "name": "add_numbers",
            "inputSchema": {
                "type": "object",
                "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
                "required": ["a", "b"],
            },
        },
        define_mcp_tool(name="ping_sync"),
        define_mcp_tool(name="raw_mcp_passthrough"),
        define_mcp_tool(name="explode_tool"),
    ]

    async def async_handler(tool_name: str, tool_args: dict[str, Any]) -> Any:
        if tool_name == "add_numbers":
            return ok_envelope(tool_name, "Added", {"sum": tool_args["a"] + tool_args["b"]})
        if tool_name == "raw_mcp_passthrough":
            return ok_mcp_result(tool_name, "Direct MCP payload", {"passthrough": True})
        if tool_name == "explode_tool":
            raise RuntimeError("database socket closed")
        return {"unexpected": True}

    def sync_handler(tool_name: str, tool_args: dict[str, Any]) -> Any:
        if tool_name == "ping_sync":
            return {"pong": True, "echo": tool_args}
        return error_envelope("UNHANDLED", "Unhandled sync tool", tool=tool_name)

    async def _run_checks() -> None:
        # 1. Unknown tool -> UNKNOWN_TOOL
        unknown = await dispatch_mcp_tool(tools, async_handler, "nonexistent_tool", {})
        assert unknown["isError"] is True
        assert json.loads(unknown["content"][0]["text"])["error"]["code"] == "UNKNOWN_TOOL"

        # 2. Missing required argument -> INVALID_ARGUMENTS
        bad_args = await dispatch_mcp_tool(tools, async_handler, "add_numbers", {"a": 5})
        assert bad_args["isError"] is True
        bad_payload = json.loads(bad_args["content"][0]["text"])
        assert bad_payload["error"]["code"] == "INVALID_ARGUMENTS"
        assert bad_payload["error"]["details"] == {"missing": ["b"]}

        # 3. Async handler returning ok_envelope dict (including 0 required arg)
        added = await dispatch_mcp_tool(tools, async_handler, "add_numbers", {"a": 0, "b": 42})
        assert "isError" not in added
        assert json.loads(added["content"][0]["text"])["data"] == {"sum": 42}

        # 4. Sync handler returning plain dict
        pong = await dispatch_mcp_tool(tools, sync_handler, "ping_sync", {"k": "v"})
        assert json.loads(pong["content"][0]["text"])["data"] == {"pong": True, "echo": {"k": "v"}}

        # 5. Existing MCP {"content": [...]} result preserved verbatim
        passthrough = await dispatch_mcp_tool(tools, async_handler, "raw_mcp_passthrough", {})
        assert json.loads(passthrough["content"][0]["text"])["data"] == {"passthrough": True}

        # 6. Handler exception caught into TOOL_EXECUTION_ERROR
        exploded = await dispatch_mcp_tool(tools, async_handler, "explode_tool", {})
        assert exploded["isError"] is True
        exploded_err = json.loads(exploded["content"][0]["text"])
        assert exploded_err["error"]["code"] == "TOOL_EXECUTION_ERROR"
        assert "database socket closed" in exploded_err["error"]["message"]

    asyncio.run(_run_checks())


# ---------------------------------------------------------------------------
# 2. krusch_toolkit.pg Tests (Mock DB-API2 & SQLAlchemy Engine)
# ---------------------------------------------------------------------------


class MockDbCursor:
    def __init__(self, conn: MockDbConnection) -> None:
        self._conn = conn
        self.description: list[tuple[str, ...]] | None = None
        self._rows: list[tuple[Any, ...]] = []
        self.closed = False

    def execute(self, sql: str, params: tuple[Any, ...] | None = None) -> None:
        self._conn.executed.append((sql, params))
        if self._conn.fail_on_sql and self._conn.fail_on_sql in sql:
            raise RuntimeError("Simulated SQL failure")

        upper_sql = sql.strip().upper()
        if upper_sql.startswith("SELECT ID FROM "):
            self.description = [("id",)]
            self._rows = [(mid,) for mid in sorted(self._conn.committed_migrations)]
        elif upper_sql.startswith("INSERT INTO ") and params:
            self._conn.staged_migrations.append(str(params[0]))
            self.description = None
            self._rows = []
        elif "AS SIMILARITY FROM" in upper_sql:
            self.description = [(col,) for col in self._conn.search_columns]
            self._rows = list(self._conn.search_rows)
        else:
            self._conn.staged_statements.append(sql)
            self.description = None
            self._rows = []

    def fetchall(self) -> list[tuple[Any, ...]]:
        return list(self._rows)

    def close(self) -> None:
        self.closed = True


class MockDbConnection:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple[Any, ...] | None]] = []
        self.committed_migrations: set[str] = set()
        self.staged_migrations: list[str] = []
        self.staged_statements: list[str] = []
        self.commits = 0
        self.rollbacks = 0
        self.closed = False
        self.fail_on_sql: str | None = None
        self.search_columns: list[str] = ["id", "title", "similarity"]
        self.search_rows: list[tuple[Any, ...]] = [(101, "Alpha Doc", 0.9125)]

    def cursor(self) -> MockDbCursor:
        return MockDbCursor(self)

    def commit(self) -> None:
        self.commits += 1
        self.committed_migrations.update(self.staged_migrations)
        self.staged_migrations.clear()
        self.staged_statements.clear()

    def rollback(self) -> None:
        self.rollbacks += 1
        self.staged_migrations.clear()
        self.staged_statements.clear()

    def close(self) -> None:
        self.closed = True


class MockSqlAlchemyEngine:
    def __init__(self, underlying: MockDbConnection) -> None:
        self._underlying = underlying
        self.raw_connection_calls = 0

    def raw_connection(self) -> MockDbConnection:
        self.raw_connection_calls += 1
        return self._underlying


def test_assert_safe_pg_identifier() -> None:
    assert assert_safe_pg_identifier("schema_migrations") == "schema_migrations"
    assert assert_safe_pg_identifier("  _doc_chunks_v2  ") == "_doc_chunks_v2"

    for unsafe in ("", "   ", "123_bad", "users; DROP TABLE x", "public.users", 'users"id', "col-name"):
        with pytest.raises(ValueError, match="Unsafe SQL"):
            assert_safe_pg_identifier(unsafe)

    with pytest.raises(ValueError, match="Unsafe SQL"):
        assert_safe_pg_identifier(None)  # type: ignore[arg-type]


def test_build_pg_connection_string_encoding_env_and_validation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)

    uri = build_pg_connection_string(
        {
            "user": "svc:user",
            "password": "p@ss/w?rd#1%",
            "host": "db.example.test",
            "port": "5434",
            "database": "app db",
        }
    )
    assert uri == "postgresql://svc%3Auser:p%40ss%2Fw%3Frd%231%25@db.example.test:5434/app%20db"

    # Explicit url takes precedence
    assert (
        build_pg_connection_string({"url": "postgresql://localhost:5432/override"})
        == "postgresql://localhost:5432/override"
    )

    # DATABASE_URL environment fallback when no explicit components are passed
    monkeypatch.setenv("DATABASE_URL", "postgresql://envhost:5432/envdb")
    assert build_pg_connection_string() == "postgresql://envhost:5432/envdb"

    # Valid IPv6 literals (both bare and bracketed) format cleanly
    assert (
        build_pg_connection_string({"host": "::1", "port": 5432, "user": "u", "password": "p", "database": "d"})
        == "postgresql://u:p@[::1]:5432/d"
    )
    assert (
        build_pg_connection_string({"host": "[::1]", "port": 5432, "user": "u", "password": "p", "database": "d"})
        == "postgresql://u:p@[::1]:5432/d"
    )

    # Reject invalid ports & unsafe hosts (including smuggled host:port)
    for bad_port in (0, -1, 65536, "not_a_port", True):
        with pytest.raises(ValueError, match="port"):
            build_pg_connection_string({"host": "127.0.0.1", "port": bad_port})

    for bad_host in ("evil.host/path", "evil host", "host\r\ninject", "user@host", "db.internal:6543", ""):
        with pytest.raises(ValueError, match="host"):
            build_pg_connection_string({"host": bad_host, "port": 5432})


def test_format_pgvector_literal_validates_dims_nan_inf_and_bool() -> None:
    lit = format_pgvector_literal([0.25, -0.5, 0.0, 1], expected_dims=4)
    assert lit == "[0.25,-0.5,0,1]"

    # Default 1024 dimensions
    vec_1024 = [0.001 * (i % 10) for i in range(1024)]
    lit_1024 = format_pgvector_literal(vec_1024)
    assert lit_1024.startswith("[") and lit_1024.endswith("]")
    assert len(lit_1024[1:-1].split(",")) == 1024

    # Explicitly reject Python bools even though isinstance(True, int) is True!
    with pytest.raises(ValueError, match="non-numeric"):
        format_pgvector_literal([True, 0.2, 0.3, 0.4], expected_dims=4)

    with pytest.raises(ValueError, match="non-numeric"):
        format_pgvector_literal([0.1, False, 0.3, 0.4], expected_dims=4)

    # Reject NaN, Inf, and wrong dimensionality
    with pytest.raises(ValueError, match="non-finite"):
        format_pgvector_literal([math.nan, 0.1], expected_dims=2)

    with pytest.raises(ValueError, match="non-finite"):
        format_pgvector_literal([math.inf, 0.1], expected_dims=2)

    with pytest.raises(ValueError, match="Dimension mismatch"):
        format_pgvector_literal([0.1, 0.2], expected_dims=4)


def test_run_sql_migrations_idempotency_rollback_and_sqlalchemy_engine() -> None:
    conn = MockDbConnection()
    migrations = [
        {"id": "001_create_docs", "sql": "CREATE TABLE docs (id BIGSERIAL PRIMARY KEY);"},
        {"id": "002_add_idx", "sql": "CREATE INDEX idx_docs ON docs (id);"},
    ]

    first = run_sql_migrations(conn, migrations)
    assert first == {
        "ok": True,
        "tool": "pg.migrate",
        "summary": "Applied 2 migration(s), skipped 0",
        "data": {"applied": ["001_create_docs", "002_add_idx"], "skipped": []},
    }
    assert conn.closed is False  # Caller-owned DB-API2 connection remains open

    # Second run via SQLAlchemy Engine wrapper skips already-applied migrations and closes raw_connection
    engine = MockSqlAlchemyEngine(conn)
    second = run_sql_migrations(
        engine,
        [*migrations, {"id": "003_add_meta", "sql": "ALTER TABLE docs ADD COLUMN meta JSONB;"}],
    )
    assert second["data"] == {
        "applied": ["003_add_meta"],
        "skipped": ["001_create_docs", "002_add_idx"],
    }
    assert engine.raw_connection_calls == 1
    assert conn.closed is True

    # Failure rolls back cleanly without recording failed migration ID
    conn.fail_on_sql = "BROKEN SQL"
    with pytest.raises(RuntimeError, match="Simulated SQL failure"):
        run_sql_migrations(conn, [{"id": "004_broken", "sql": "BROKEN SQL"}])
    assert conn.rollbacks == 1
    assert "004_broken" not in conn.committed_migrations


def test_pg_vector_search_parameter_binding_order_clamping_and_sqli_guards() -> None:
    conn = MockDbConnection()
    res = pg_vector_search(
        conn,
        table="legal_chunks",
        vector=[0.5, -0.5, 0.25, 0.75],
        embedding_column="embedding_1024",
        select_columns=("id", "title"),
        where_sql="WHERE tenant_id = %s AND active = %s",
        params=("tenant_alpha", True),
        limit=999,  # Clamped to 200
        expected_dims=4,
    )

    assert res == {
        "ok": True,
        "tool": "pg.vector_search",
        "summary": "Retrieved 1 vector match(es)",
        "data": {"rows": [{"id": 101, "title": "Alpha Doc", "similarity": 0.9125}]},
    }

    executed_sql, executed_params = conn.executed[-1]
    assert executed_sql == (
        "SELECT id, title, 1 - (embedding_1024 <=> %s::vector) AS similarity "
        "FROM legal_chunks WHERE (tenant_id = %s AND active = %s) "
        "ORDER BY embedding_1024 <=> %s::vector ASC LIMIT %s"
    )
    # Parameter binding order MUST be: (vec_literal, *params, vec_literal, safe_limit)
    assert executed_params == (
        "[0.5,-0.5,0.25,0.75]",
        "tenant_alpha",
        True,
        "[0.5,-0.5,0.25,0.75]",
        200,
    )

    # Lower-bound limit clamping (<= 0 clamps to 1)
    pg_vector_search(conn, table="legal_chunks", vector=[1.0, 0.0], limit=-10, expected_dims=2)
    assert conn.executed[-1][1] == ("[1,0]", "[1,0]", 1)


@pytest.mark.parametrize(
    "malicious_where",
    [
        "1=1; DROP TABLE legal_chunks",
        "tenant_id = %s -- bypass",
        "tenant_id = /* comment */ %s",
        "tenant_id = %s */",
        "tenant_id = %s\x00",
        "1=1) UNION SELECT id, password, 1.0 FROM users WHERE (1=1",
        "1=1 OR pg_sleep(5) IS NOT NULL",
        '"pg_sleep"(5) IS NOT NULL',
        '"pg_read_file"(%s) IS NOT NULL',
        "pg_catalog.pg_sleep(5) IS NOT NULL",
        "query_to_xml('SELECT * FROM pg_shadow', true, true, '') IS NOT NULL",
        "E'\\x27' = %s",
        "U&'\\0027' = %s",
        "title LIKE '%search%'",
        "tenant_id = %(named)s",
        "tenant_id = $$injected$$",
        "1=1) OR (1=1",
    ],
)
def test_pg_vector_search_rejects_sqli_in_where_sql(malicious_where: str) -> None:
    conn = MockDbConnection()
    with pytest.raises(ValueError):
        pg_vector_search(
            conn,
            table="legal_chunks",
            vector=[1.0, 0.0],
            where_sql=malicious_where,
            params=("t1",) if "%s" in malicious_where and "'%s" not in malicious_where else (),
            expected_dims=2,
        )


def test_pg_vector_search_enforces_exact_placeholder_count_and_allows_safe_callables() -> None:
    conn = MockDbConnection()
    ok_res = pg_vector_search(
        conn,
        table="legal_chunks",
        vector=[1.0, 0.0],
        where_sql='LOWER(category) = LOWER(%s) AND COALESCE("org_id", %s) IS NOT NULL',
        params=("contracts", "org_1"),
        expected_dims=2,
    )
    assert ok_res["ok"] is True

    # Too many params for 0 placeholders
    with pytest.raises(ValueError, match="Placeholder count mismatch"):
        pg_vector_search(
            conn,
            table="legal_chunks",
            vector=[1.0, 0.0],
            where_sql="active = TRUE",
            params=("extra",),
            expected_dims=2,
        )

    # Too few params for 2 placeholders
    with pytest.raises(ValueError, match="Placeholder count mismatch"):
        pg_vector_search(
            conn,
            table="legal_chunks",
            vector=[1.0, 0.0],
            where_sql="tenant_id = %s AND active = %s",
            params=("only_one",),
            expected_dims=2,
        )


def test_pg_vector_search_rejects_unsafe_identifiers_and_empty_columns() -> None:
    conn = MockDbConnection()
    with pytest.raises(ValueError, match="Unsafe SQL table"):
        pg_vector_search(conn, table="chunks;DROP", vector=[1.0, 0.0], expected_dims=2)

    with pytest.raises(ValueError, match="select_columns"):
        pg_vector_search(conn, table="chunks", vector=[1.0, 0.0], select_columns=(), expected_dims=2)

    with pytest.raises(ValueError, match="select_columns"):
        pg_vector_search(conn, table="chunks", vector=[1.0, 0.0], select_columns="id", expected_dims=2)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# 3. krusch_toolkit.security Tests
# ---------------------------------------------------------------------------


def test_constant_time_equal() -> None:
    assert constant_time_equal("alpha-secret", "alpha-secret") is True
    assert constant_time_equal(b"raw-bytes", b"raw-bytes") is True
    assert constant_time_equal("alpha-secret", b"alpha-secret") is True

    # Empty, None, wrong type, and length mismatches fail closed
    assert constant_time_equal("", "") is False
    assert constant_time_equal(b"", b"") is False
    assert constant_time_equal(None, "alpha") is False
    assert constant_time_equal("alpha", None) is False
    assert constant_time_equal("short", "longer-value") is False
    assert constant_time_equal(12345, 12345) is False  # type: ignore[arg-type]


def test_verify_webhook_hmac_success_and_fail_closed_cases() -> None:
    secret = "whsec_super_secret_key"
    body = '{"event":"deploy.completed","ok":true}'
    valid_hex = hmac.new(secret.encode("utf-8"), body.encode("utf-8"), hashlib.sha256).hexdigest()

    ok_res = verify_webhook_hmac(body, f"sha256={valid_hex}", secret)
    assert ok_res["ok"] is True
    assert ok_res["tool"] == "webhooks.hmac"
    assert ok_res["data"]["verified"] is True

    # Bytes body & uppercase hex digest also verify cleanly
    ok_bytes = verify_webhook_hmac(body.encode("utf-8"), f"SHA256={valid_hex.upper()}", secret)
    assert ok_bytes["ok"] is True

    # Fail-closed: missing or whitespace secret
    missing_sec = verify_webhook_hmac(body, f"sha256={valid_hex}", "   ")
    assert missing_sec["ok"] is False
    assert missing_sec["error"]["code"] == "WEBHOOK_MISSING_SECRET"

    # Fail-closed: parsed dict instead of raw str/bytes body
    bad_body = verify_webhook_hmac({"event": "deploy"}, f"sha256={valid_hex}", secret)  # type: ignore[arg-type]
    assert bad_body["ok"] is False
    assert bad_body["error"]["code"] == "WEBHOOK_INVALID_BODY"

    # Fail-closed: malformed or tampered signatures never raise
    for bad_sig in (None, "", "sha256=not-hex", f"v0={valid_hex}", f"sha256={'0' * 64}", f"sha256={valid_hex}\r\n"):
        res = verify_webhook_hmac(body, bad_sig, secret)
        assert res["ok"] is False
        assert res["error"]["code"] == "WEBHOOK_INVALID_SIGNATURE"


def test_verify_bearer_token_length_hiding_and_header_guards() -> None:
    secret = "kr_live_987654321_very_long_secret_token_value"

    ok_res = verify_bearer_token(f"Bearer {secret}", secret)
    assert ok_res["ok"] is True
    assert ok_res["data"] == {"verified": True, "provider": "bearer"}

    # Missing secret -> AUTH_MISSING_SECRET
    assert verify_bearer_token(f"Bearer {secret}", "")["error"]["code"] == "AUTH_MISSING_SECRET"
    assert verify_bearer_token(f"Bearer {secret}", None)["error"]["code"] == "AUTH_MISSING_SECRET"

    # Different-length wrong token -> AUTH_UNAUTHORIZED (pre-hashed SHA-256 comparison)
    wrong_short = verify_bearer_token("Bearer x", secret)
    assert wrong_short["ok"] is False
    assert wrong_short["error"]["code"] == "AUTH_UNAUTHORIZED"

    # Malformed headers -> AUTH_INVALID_HEADER
    for bad_hdr in (
        None,
        "",
        "Basic dXNlcjpwYXNz",
        "Bearer",
        "Bearer tok1 tok2",
        f"Bearer {secret}\r\nX-Injected: 1",
        "Bearer " + ("a" * 5000),
    ):
        bad_res = verify_bearer_token(bad_hdr, secret)
        assert bad_res["ok"] is False
        assert bad_res["error"]["code"] == "AUTH_INVALID_HEADER"


@pytest.mark.parametrize(
    ("ip_literal", "expected_blocked"),
    [
        ("93.184.216.34", False),
        ("1.1.1.1", False),
        ("2606:4700:4700::1111", False),
        ("127.0.0.1", True),
        ("::1", True),
        ("0.0.0.0", True),
        ("::", True),
        ("169.254.169.254", True),
        ("fe80::1", True),
        ("fd00:ec2::254", True),
        ("10.1.2.3", True),
        ("172.16.5.4", True),
        ("172.16.1.2", True),
        ("fd12:3456:789a::1", True),
        ("100.64.1.2", True),
        ("::ffff:127.0.0.1", True),
        ("::ffff:169.254.169.254", True),
        ("::ffff:93.184.216.34", True),
        ("2002:7f00:0001::1", True),  # 6to4 embedding 127.0.0.1
        ("2002:a9fe:a9fe::1", True),  # 6to4 embedding 169.254.169.254
        ("2001:0000:4136:e378:8000:63bf:3fff:fdd2", True),  # Teredo
        ("224.0.0.1", True),
        ("ff02::1", True),
        ("198.18.0.1", True),
        ("203.0.113.5", True),
        ("0177.0.0.1", True),
        ("0x7f000001", True),
        ("2130706433", True),
        ("not-an-ip", True),
        ("", True),
    ],
)
def test_is_private_or_reserved_ip_matrix(ip_literal: str, expected_blocked: bool) -> None:
    assert is_private_or_reserved_ip(ip_literal) is expected_blocked


def test_is_private_or_reserved_ip_lan_and_tailscale_flags_preserve_metadata_block() -> None:
    # Private LAN toggle allows RFC1918 & ULA, but still blocks Tailscale CGNAT, loopback, and cloud metadata!
    assert is_private_or_reserved_ip("172.16.1.2", allow_private_lan=True) is False
    assert is_private_or_reserved_ip("10.1.2.3", allow_private_lan=True) is False
    assert is_private_or_reserved_ip("fd12:3456:789a::1", allow_private_lan=True) is False
    assert is_private_or_reserved_ip("100.64.1.2", allow_private_lan=True) is True
    assert is_private_or_reserved_ip("169.254.169.254", allow_private_lan=True) is True
    assert is_private_or_reserved_ip("fd00:ec2::254", allow_private_lan=True) is True
    assert is_private_or_reserved_ip("127.0.0.1", allow_private_lan=True) is True
    assert is_private_or_reserved_ip("::ffff:169.254.169.254", allow_private_lan=True) is True

    # Tailscale toggle allows 100.64.0.0/10 CGNAT, while keeping metadata & RFC1918 blocked unless opted in
    assert is_private_or_reserved_ip("100.64.1.2", allow_tailscale=True) is False
    assert is_private_or_reserved_ip("172.16.1.2", allow_tailscale=True) is True
    assert is_private_or_reserved_ip("169.254.169.254", allow_tailscale=True) is True


def test_validate_outbound_url_public_success_and_protocol_credential_guards() -> None:
    ok_res = validate_outbound_url(
        "https://api.example.com:8443/v1/webhooks?mode=live",
        allowed_hosts=["*.example.com"],
        lookup_fn=lambda host: ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
    )
    assert ok_res["ok"] is True
    assert ok_res["data"] == {
        "url": "https://api.example.com:8443/v1/webhooks?mode=live",
        "scheme": "https",
        "hostname": "api.example.com",
        "port": 8443,
        "resolved_addresses": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
    }

    # Blocked protocol
    ftp_res = validate_outbound_url("file:///etc/passwd")
    assert ftp_res["ok"] is False
    assert ftp_res["error"]["code"] == "SSRF_BLOCKED_PROTOCOL"

    # Embedded URL credentials forbidden
    cred_res = validate_outbound_url("https://admin:secret@api.example.com/v1")
    assert cred_res["ok"] is False
    assert cred_res["error"]["code"] == "SSRF_CREDENTIALS_FORBIDDEN"

    # Host allowlist enforcement
    unlisted = validate_outbound_url(
        "https://untrusted.io/hook",
        allowed_hosts=["api.example.com"],
        lookup_fn=lambda _h: ["93.184.216.34"],
    )
    assert unlisted["ok"] is False
    assert unlisted["error"]["code"] == "SSRF_HOST_NOT_ALLOWED"


def test_validate_outbound_url_blocks_metadata_even_with_allow_private_lan() -> None:
    for meta_url in (
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://metadata.google.internal./computeMetadata/v1/",
        "http://[::ffff:169.254.169.254]/latest/meta-data/",
        "http://[fd00:ec2::254]/latest/meta-data/",
        "http://localhost:8080/admin",
        "http://0x7f000001/",
        "http://2130706433/",
    ):
        res = validate_outbound_url(
            meta_url,
            allow_private_lan=True,
            allow_tailscale=True,
            lookup_fn=lambda _h: ["93.184.216.34"],
        )
        assert res["ok"] is False, f"Expected metadata/loopback URL to be blocked: {meta_url}"
        assert res["error"]["code"] == "SSRF_PRIVATE_IP"


def test_validate_outbound_url_dns_rebinding_multi_record_rejection() -> None:
    # Attacker domain returns one public IP AND one loopback/metadata IP (DNS rebinding vector)
    rebind_res = validate_outbound_url(
        "https://rebind.attacker.example/hook",
        lookup_fn=lambda _host: ["93.184.216.34", "169.254.169.254"],
    )
    assert rebind_res["ok"] is False
    assert rebind_res["error"]["code"] == "SSRF_PRIVATE_IP"
    assert rebind_res["error"]["details"]["blocked_ip"] == "169.254.169.254"

    # Empty DNS result or resolver error -> SSRF_DNS_FAILED without raising
    empty_dns = validate_outbound_url("https://nxdomain.example/hook", lookup_fn=lambda _h: [])
    assert empty_dns["ok"] is False
    assert empty_dns["error"]["code"] == "SSRF_DNS_FAILED"
