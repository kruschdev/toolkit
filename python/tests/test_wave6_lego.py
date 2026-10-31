from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import sys
import warnings
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
import yaml

import krusch_toolkit
from krusch_toolkit.db_async import (
    DEFAULT_SQLITE_PRAGMAS,
    apply_sqlite_wal_pragmas,
    async_session_scope,
    check_async_engine_health,
    check_engine_health,
    create_managed_async_engine,
    create_managed_engine,
    redact_database_url,
    session_scope,
)
from krusch_toolkit.yaml_loader import (
    DEFAULT_YAML_LIMITS,
    dump_safe_yaml,
    load_safe_yaml_pack,
    parse_safe_yaml,
    validate_yaml_config,
)

LIB_PY_ROOT = str(Path(__file__).resolve().parents[1])
HOMELAB_ROOT = Path(__file__).resolve().parents[2]


def test_wave6_bare_stdlib_import_purity_with_optional_deps_blocked() -> None:
    """Verify yaml_loader, db_async, and root krusch_toolkit import cleanly with PyYAML & SQLAlchemy blocked."""
    script = (
        "import builtins\n"
        "_orig = builtins.__import__\n"
        "BLOCKED = {\n"
        "    'yaml', 'sqlalchemy', 'aiosqlite', 'asyncpg', 'psycopg', 'psycopg2',\n"
        "    'httpx', 'streamlit', 'fastapi', 'starlette', 'pydantic',\n"
        "}\n"
        "def _guarded(name, *args, **kwargs):\n"
        "    if name.split('.')[0] in BLOCKED:\n"
        "        raise ModuleNotFoundError(f'Blocked optional dependency: {name}')\n"
        "    return _orig(name, *args, **kwargs)\n"
        "builtins.__import__ = _guarded\n"
        "import krusch_toolkit as kt\n"
        "assert kt.__version__ == '1.6.0'\n"
        "import krusch_toolkit.yaml_loader as yl\n"
        "import krusch_toolkit.db_async as dba\n"
        "y_res = yl.parse_safe_yaml('a: 1')\n"
        "assert y_res['ok'] is False and y_res['error']['code'] == 'YAML_UNAVAILABLE'\n"
        "e_sync = dba.create_managed_engine('sqlite:///test.db')\n"
        "assert e_sync['ok'] is False and e_sync['error']['code'] == 'DB_DRIVER_UNAVAILABLE'\n"
        "e_async = dba.create_managed_async_engine('sqlite+aiosqlite:///test.db')\n"
        "assert e_async['ok'] is False and e_async['error']['code'] == 'DB_DRIVER_UNAVAILABLE'\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", script],
        env={"PYTHONPATH": LIB_PY_ROOT, "PATH": ""},
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"Bare-stdlib import failed:\nSTDOUT: {proc.stdout}\nSTDERR: {proc.stderr}"


def test_wave6_root_exports_and_immutability() -> None:
    assert krusch_toolkit.__version__ == "1.6.0"
    expected = {
        "DEFAULT_YAML_LIMITS",
        "parse_safe_yaml",
        "dump_safe_yaml",
        "validate_yaml_config",
        "load_safe_yaml_pack",
        "DEFAULT_SQLITE_PRAGMAS",
        "redact_database_url",
        "apply_sqlite_wal_pragmas",
        "create_managed_engine",
        "create_managed_async_engine",
        "session_scope",
        "async_session_scope",
        "check_engine_health",
        "check_async_engine_health",
    }
    for name in expected:
        assert hasattr(krusch_toolkit, name), f"Missing root export {name}"
        assert name in krusch_toolkit.__all__, f"Missing {name} in __all__"

    with pytest.raises(TypeError):
        DEFAULT_YAML_LIMITS["max_bytes"] = 10  # type: ignore[index]
    with pytest.raises(TypeError):
        DEFAULT_SQLITE_PRAGMAS["journal_mode"] = "DELETE"  # type: ignore[index]


def test_yaml_loader_core_types_security_guards_and_global_safeloader_isolation() -> None:
    # Ensure PyYAML's global SafeLoader still parses ISO dates / YAML 1.1 booleans normally (never mutated in-place!)
    before_safe = yaml.safe_load("date: 2026-01-01\nnorway: NO\n")

    res = parse_safe_yaml(
        "country: NO\n"
        "switch_on: on\n"
        "switch_off: off\n"
        "bool_true: True\n"
        "bool_false: FALSE\n"
        "effective_date: 2026-01-01\n"
        "iso_ts: 2026-10-31T12:00:00Z\n"
        "empty_val:\n"
    )
    assert res["ok"] is True
    assert res["data"]["value"] == {
        "country": "NO",
        "switch_on": "on",
        "switch_off": "off",
        "bool_true": True,
        "bool_false": False,
        "effective_date": "2026-01-01",
        "iso_ts": "2026-10-31T12:00:00Z",
        "empty_val": None,
    }

    after_safe = yaml.safe_load("date: 2026-01-01\nnorway: NO\n")
    assert before_safe == after_safe, "_SovereignSafeLoader must not mutate global yaml.SafeLoader"

    # Option & input guards (including Python bool-is-int trap)
    assert parse_safe_yaml("a: 1", max_bytes=True)["error"]["code"] == "YAML_INVALID_OPTIONS"
    assert parse_safe_yaml("a: 1", max_depth=0)["error"]["code"] == "YAML_INVALID_OPTIONS"
    assert parse_safe_yaml("a: 1", yaml_module=False)["error"]["code"] == "YAML_UNAVAILABLE"
    assert parse_safe_yaml(12345)["error"]["code"] == "YAML_INVALID_INPUT"  # type: ignore[arg-type]
    assert parse_safe_yaml(b"\xff\xfe\xfd")["error"]["code"] == "YAML_PARSE_ERROR"
    assert parse_safe_yaml("a: 'nul\x00byte'")["error"]["code"] == "YAML_PARSE_ERROR"
    assert parse_safe_yaml("key: value_exceeding_limit", max_bytes=8)["error"]["code"] == "YAML_TOO_LARGE"

    # Explicit & arbitrary tags blocked
    for payload in (
        "exploit: !!python/object/apply:os.system ['id']",
        "custom: !include /etc/shadow",
        "bin: !!binary SGVsbG8=",
        "ts: !!timestamp 2026-01-01",
        "str_tag: !<tag:yaml.org,2002:str> hi",
        "%TAG ! !custom!\n---\na: 1",
    ):
        r = parse_safe_yaml(payload)
        assert r["ok"] is False, f"Expected tag block for {payload}"
        assert r["error"]["code"] == "YAML_FORBIDDEN_TAG"

    # Non-finite floats blocked
    for nf in ("x: .nan", "x: .NaN", "x: .inf", "x: -.inf", "x: +.INF"):
        r = parse_safe_yaml(nf)
        assert r["ok"] is False
        assert r["error"]["code"] == "YAML_NONFINITE_NUMBER"

    # Prototype keys, non-string keys, duplicate keys
    for proto in (
        "__proto__:\n  bad: 1",
        "constructor: 1",
        "prototype: 1",
        "base: &b\n  __proto__: 1\nchild:\n  <<: *b",
    ):
        assert parse_safe_yaml(proto)["error"]["code"] == "YAML_FORBIDDEN_KEY"

    assert parse_safe_yaml("123: int_key")["error"]["code"] == "YAML_INVALID_KEY"
    assert parse_safe_yaml("true: bool_key")["error"]["code"] == "YAML_INVALID_KEY"
    assert parse_safe_yaml("dup: 1\ndup: 2")["error"]["code"] == "YAML_DUPLICATE_KEY"

    # Billion-Laughs exponential alias bomb & cyclic anchors blocked pre-construction
    lol_bomb = "\n".join(
        [
            "a0: &a0 [1, 2, 3, 4]",
            "a1: &a1 [*a0, *a0, *a0, *a0]",
            "a2: &a2 [*a1, *a1, *a1, *a1]",
            "a3: &a3 [*a2, *a2, *a2, *a2]",
            "a4: &a4 [*a3, *a3, *a3, *a3]",
            "a5: [*a4, *a4, *a4, *a4]",
        ]
    )
    assert parse_safe_yaml(lol_bomb, max_alias_expansion_nodes=200)["error"]["code"] == "YAML_ALIAS_BOMB"
    assert parse_safe_yaml("cyc: &c [*c]")["error"]["code"] == "YAML_ALIAS_BOMB"
    assert parse_safe_yaml("a: &a [1]\nb: [*a, *a, *a]", max_aliases=2)["error"]["code"] == "YAML_ALIAS_BOMB"
    assert parse_safe_yaml("a:\n  b:\n    c:\n      d: 1", max_depth=3)["error"]["code"] == "YAML_MAX_DEPTH"
    assert parse_safe_yaml("items: [1, 2, 3, 4, 5, 6]", max_nodes=4)["error"]["code"] == "YAML_MAX_NODES"

    # Alias deep-clone isolation & multi-document stream handling
    cloned = parse_safe_yaml("base: &b\n  arr: [1, 2]\ncopy: *b\n")
    assert cloned["ok"] is True
    cloned["data"]["value"]["copy"]["arr"].append(99)
    assert cloned["data"]["value"]["base"]["arr"] == [1, 2]

    assert parse_safe_yaml("---\na: 1\n---\nb: 2")["error"]["code"] == "YAML_MULTIPLE_DOCUMENTS"
    multi = parse_safe_yaml("---\na: 1\n---\nb: 2", allow_multiple_documents=True)
    assert multi["ok"] is True
    assert multi["data"]["value"] == [{"a": 1}, {"b": 2}]


def test_yaml_dump_validate_pack_security_and_cross_runtime_parity(tmp_path: Path) -> None:
    dumped = dump_safe_yaml({"country": "NO", "items": ("tuple_a", "tuple_b"), "count": 3})
    assert dumped["ok"] is True
    assert "!!python/tuple" not in dumped["data"]["yaml"]
    reparsed = parse_safe_yaml(dumped["data"]["yaml"])
    assert reparsed["data"]["value"] == {"country": "NO", "items": ["tuple_a", "tuple_b"], "count": 3}

    cyc: dict[str, Any] = {}
    cyc["self"] = cyc
    assert dump_safe_yaml(cyc)["error"]["code"] == "YAML_DUMP_ERROR"
    assert dump_safe_yaml(float("nan"))["error"]["code"] == "YAML_DUMP_ERROR"
    assert dump_safe_yaml({"__proto__": 1})["error"]["code"] == "YAML_FORBIDDEN_KEY"

    schema = {
        "type": "object",
        "required": ["pack_id", "port"],
        "properties": {"pack_id": {"type": "string"}, "port": {"type": "integer"}},
    }
    valid_cfg = validate_yaml_config("pack_id: ca-01\nport: 8085\n", schema)
    assert valid_cfg["ok"] is True
    assert valid_cfg["data"]["value"] == {"pack_id": "ca-01", "port": 8085}
    assert validate_yaml_config("pack_id: ca-01\nport: bad\n", schema)["ok"] is False

    # File-mode load_safe_yaml_pack: traversal, symlink escape, directory/FIFO rejection, and SHA-256 parity
    packs_dir = tmp_path / "packs"
    packs_dir.mkdir()
    outside_secret = tmp_path / "outside.yaml"
    outside_secret.write_text("pack_id: secret\n", encoding="utf-8")

    escape_link = packs_dir / "escape.yaml"
    escape_link.symlink_to(outside_secret)

    assert (
        load_safe_yaml_pack(str(packs_dir / "../outside.yaml"), base_dir=packs_dir, from_file=True)["error"]["code"]
        == "YAML_PATH_TRAVERSAL"
    )
    assert load_safe_yaml_pack(escape_link, base_dir=packs_dir)["error"]["code"] == "YAML_PATH_TRAVERSAL"
    assert load_safe_yaml_pack(packs_dir)["error"]["code"] == "YAML_INVALID_INPUT"
    assert load_safe_yaml_pack(packs_dir / "missing.yaml")["error"]["code"] == "YAML_FILE_NOT_FOUND"

    if hasattr(os, "mkfifo"):
        fifo_path = packs_dir / "pipe.yaml"
        os.mkfifo(fifo_path)
        assert load_safe_yaml_pack(fifo_path, base_dir=packs_dir)["error"]["code"] == "YAML_INVALID_INPUT"

    good_pack = packs_dir / "ca-deposit.yaml"
    raw_content = "pack_id: ca-1950-5\njurisdiction: NO\neffective_date: 2026-01-01\ndays: 21\n"
    good_pack.write_text(raw_content, encoding="utf-8")

    py_pack = load_safe_yaml_pack(
        good_pack,
        base_dir=packs_dir,
        required_keys=["pack_id", "jurisdiction", "days"],
    )
    assert py_pack["ok"] is True
    assert py_pack["data"]["sha256"] == hashlib.sha256(raw_content.encode("utf-8")).hexdigest()
    assert py_pack["data"]["source_path"] == str(good_pack.resolve())

    # Cross-runtime 1:1 parity against Node @krusch/toolkit/yaml
    yaml_js_path = (
        HOMELAB_ROOT / "yaml.js"
        if (HOMELAB_ROOT / "yaml.js").exists()
        else HOMELAB_ROOT / "lib" / "yaml.js"
    )
    node_proc = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                f"import fs from 'node:fs';\n"
                f"import {{ loadSafeYamlPack }} from {yaml_js_path.as_uri()!r};\n"
                f"const r = loadSafeYamlPack(fs.readFileSync({str(good_pack)!r}));\n"
                f"process.stdout.write(JSON.stringify(r));\n"
            ),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    js_pack = json.loads(node_proc.stdout)
    assert js_pack["ok"] is True
    assert js_pack["data"]["sha256"] == py_pack["data"]["sha256"]
    assert js_pack["data"]["pack"] == py_pack["data"]["pack"]


def test_db_async_url_redaction_pragma_sqli_guards_and_sync_sqlite_wal(tmp_path: Path) -> None:
    # Credential scrubbing with @ / : / % in password + sensitive query params
    dsn = "postgresql+asyncpg://admin:p@ss:w/rd%231@db.example.test:5434/appdb?sslmode=require&password=leaked&api_key=tok123"
    redacted = redact_database_url(dsn)
    assert "p@ss" not in redacted
    assert "w/rd" not in redacted
    assert "leaked" not in redacted
    assert "tok123" not in redacted
    assert "admin:***@db.example.test:5434/appdb" in redacted

    # SQL-injection pragma whitelist guards
    fake_conn = MagicMock()
    with pytest.raises(ValueError):
        apply_sqlite_wal_pragmas(fake_conn, journal_mode="WAL; DROP TABLE users;--")
    with pytest.raises(ValueError):
        apply_sqlite_wal_pragmas(fake_conn, synchronous="NORMAL; PRAGMA writable_schema=1")
    with pytest.raises(ValueError):
        apply_sqlite_wal_pragmas(fake_conn, busy_timeout_ms=True)  # type: ignore[arg-type]

    # Option & driver mismatch validation
    assert create_managed_engine("sqlite:///x.db", pool_size=True)["error"]["code"] == "DB_INVALID_OPTIONS"
    assert create_managed_engine("sqlite:///x.db", pool_timeout=float("nan"))["error"]["code"] == "DB_INVALID_OPTIONS"
    assert create_managed_engine("", env_var="NONEXISTENT_TEST_DB_URL")["error"]["code"] == "DB_MISSING_URL"

    mismatch = create_managed_engine("postgresql+asyncpg://u:s3cr3t@127.0.0.1:5432/db")
    assert mismatch["error"]["code"] == "DB_ASYNC_DRIVER_MISMATCH"
    assert "s3cr3t" not in json.dumps(mismatch)

    # Real file-backed SQLite WAL engine + session_scope commit/rollback + health check
    db_file = tmp_path / "wal_test.db"
    eng_res = create_managed_engine(f"sqlite:///{db_file}", busy_timeout_ms=4500)
    assert eng_res["ok"] is True
    engine = eng_res["data"]["engine"]
    session_factory = eng_res["data"]["session_factory"]
    try:
        from sqlalchemy import text

        health = check_engine_health(engine)
        assert health["ok"] is True
        assert health["data"]["healthy"] is True
        assert health["data"]["dialect"] == "sqlite"
        assert health["data"]["journal_mode"] == "wal"

        with session_scope(session_factory) as session:
            session.execute(text("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)"))
            session.execute(text("INSERT INTO items (name) VALUES ('committed')"))

        with pytest.raises(RuntimeError, match="abort tx"), session_scope(session_factory) as session:
            session.execute(text("INSERT INTO items (name) VALUES ('rolled_back')"))
            raise RuntimeError("abort tx")

        with session_scope(session_factory) as session:
            rows = session.execute(text("SELECT name FROM items")).scalars().all()
            assert rows == ["committed"]
    finally:
        engine.dispose()

    # Pooled network dialect kwargs & credential scrubbing on failure via sa_module spy
    sa_spy = MagicMock()
    sa_spy.create_engine.side_effect = RuntimeError("FATAL: auth failed for postgres://u:topsecret@198.51.100.2/db")
    err_res = create_managed_engine(
        "postgresql://u:topsecret@198.51.100.2:5432/db",
        pool_size=7,
        max_overflow=14,
        pool_timeout=20.0,
        pool_recycle=900,
        sa_module=sa_spy,
    )
    assert err_res["ok"] is False
    assert err_res["error"]["code"] == "DB_ENGINE_ERROR"
    assert "topsecret" not in json.dumps(err_res)
    _, kwargs = sa_spy.create_engine.call_args
    assert kwargs["pool_size"] == 7
    assert kwargs["max_overflow"] == 14
    assert kwargs["pool_pre_ping"] is True


def test_db_async_engine_and_cancelled_error_shielded_rollback() -> None:
    # Sync URL passed to async engine fails closed with redacted URL
    sync_mismatch = create_managed_async_engine("postgresql://u:my_secret@127.0.0.1:5432/db")
    assert sync_mismatch["error"]["code"] == "DB_ASYNC_DRIVER_MISMATCH"
    assert "my_secret" not in json.dumps(sync_mismatch)

    # Custom async_engine_factory + async_session_scope commit, exception rollback, and CancelledError shielded rollback
    events: list[str] = []

    class FakeAsyncConn:
        async def __aenter__(self) -> FakeAsyncConn:
            return self

        async def __aexit__(self, *_: Any) -> None:
            return None

        async def execute(self, stmt: Any) -> Any:
            s = str(stmt)
            res = MagicMock()
            if "journal_mode" in s.lower():
                res.scalar.return_value = "wal"
            else:
                res.scalar.return_value = 1
            return res

    class FakeAsyncSession:
        def __init__(self, fail_rollback: bool = False) -> None:
            self.fail_rollback = fail_rollback

        async def commit(self) -> None:
            events.append("commit")

        async def rollback(self) -> None:
            await asyncio.sleep(0)
            events.append("rollback")
            if self.fail_rollback:
                raise RuntimeError("connection lost during shielded rollback")

        async def close(self) -> None:
            await asyncio.sleep(0)
            events.append("close")

    class FakeAsyncEngine:
        dialect = MagicMock(name="sqlite")

        def __init__(self) -> None:
            self.dialect.name = "sqlite"
            self.sync_engine = None

        def connect(self) -> FakeAsyncConn:
            return FakeAsyncConn()

        def session_factory(self) -> FakeAsyncSession:
            return FakeAsyncSession()

    async def _run_checks() -> None:
        async_res = create_managed_async_engine(
            "sqlite+aiosqlite:///test.db",
            async_engine_factory=lambda *_a, **_kw: FakeAsyncEngine(),
        )
        assert async_res["ok"] is True
        assert async_res["data"]["is_async"] is True
        eng = async_res["data"]["engine"]
        sf = async_res["data"]["session_factory"]

        health = await check_async_engine_health(eng)
        assert health["ok"] is True
        assert health["data"]["journal_mode"] == "wal"

        async with async_session_scope(sf):
            events.append("work_ok")
        assert events == ["work_ok", "commit", "close"]
        events.clear()

        # CancelledError inside async_session_scope (even when shielded rollback rejects!)
        async def _cancelled_worker() -> None:
            async with async_session_scope(lambda: FakeAsyncSession(fail_rollback=True)):
                events.append("started")
                await asyncio.sleep(10)

        with warnings.catch_warnings(record=True) as caught_warnings:
            warnings.simplefilter("always")
            task = asyncio.create_task(_cancelled_worker())
            await asyncio.sleep(0.01)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            await asyncio.sleep(0.02)
            assert not any("never retrieved" in str(w.message) for w in caught_warnings)

        assert "rollback" in events
        assert "close" in events

        # Unhealthy engine scrubs credentials
        class BrokenAsyncEngine:
            def connect(self) -> Any:
                raise RuntimeError("connect failed for postgresql+asyncpg://user:super_secret@198.51.100.5/db")

        bad_health = await check_async_engine_health(BrokenAsyncEngine())
        assert bad_health["ok"] is False
        assert bad_health["error"]["code"] == "DB_UNHEALTHY"
        assert "super_secret" not in json.dumps(bad_health)

    asyncio.run(_run_checks())


def test_wave6_referee_regressions_yaml_roundtrip_dirfd_and_db_url_hardening(tmp_path: Path) -> None:
    # 1. W6-R2-01: dump_safe_yaml quotes YAML 1.2 numeric/marker/control strings for lossless round-trip
    edge_payload = {
        "octal_str": "0o7",
        "hex_str": "0x10",
        "lead_zero": "010",
        "sci_str": "1e5",
        "overflow_sci": "1e54321",
        "dot_float": "+.5",
        "neg_dot_float": "-.5",
        "plus_nan": "+.nan",
        "minus_nan": "-.nan",
        "doc_end": "... trailing",
        "doc_start": "--- leading",
        "merge_key_val": "<<",
        "nel_char": "a\x85b",
        "ctrl_char": "\x01",
        "line_sep": "a\u2028b",
    }
    dumped = dump_safe_yaml(edge_payload)
    assert dumped["ok"] is True
    reparsed = parse_safe_yaml(dumped["data"]["yaml"])
    assert reparsed["ok"] is True, f"Round-trip parse failed: {reparsed}"
    assert reparsed["data"]["value"] == edge_payload

    # 2. W6-REF1-04: Intermediate-directory symlink inside base_dir blocked via dir_fd + O_NOFOLLOW
    packs_dir = tmp_path / "confined_packs"
    packs_dir.mkdir()
    outside_dir = tmp_path / "outside_dir"
    outside_dir.mkdir()
    secret_file = outside_dir / "secret.yaml"
    secret_file.write_text("pack_id: escaped\n", encoding="utf-8")

    subdir_symlink = packs_dir / "linked_sub"
    subdir_symlink.symlink_to(outside_dir, target_is_directory=True)
    traversal_res = load_safe_yaml_pack(subdir_symlink / "secret.yaml", base_dir=packs_dir)
    assert traversal_res["ok"] is False
    assert traversal_res["error"]["code"] == "YAML_PATH_TRAVERSAL"

    # Hostile PathLike raising non-TypeError inside __fspath__ returns YAML_INVALID_INPUT envelope
    class BrokenPathLike:
        def __fspath__(self) -> str:
            raise RuntimeError("fspath failure")

    fspath_res = load_safe_yaml_pack(BrokenPathLike())  # type: ignore[arg-type]
    assert fspath_res["ok"] is False
    assert fspath_res["error"]["code"] == "YAML_INVALID_INPUT"

    # Validator returning non-dict fails closed with YAML_INVALID_PACK
    class ListCoercingModel:
        @staticmethod
        def model_validate(_v: Any) -> list[str]:
            return ["not_a_dict"]

    non_dict_pack = load_safe_yaml_pack("pack_id: ok\n", schema=ListCoercingModel)
    assert non_dict_pack["ok"] is False
    assert non_dict_pack["error"]["code"] == "YAML_INVALID_PACK"

    # 3. W6-REF1-01: redact_database_url scrubs passwords containing '/' after digits & empty usernames
    slash_pw = "postgresql://admin:1234/secret?x=1#frag@db.internal:5432/prod"
    redacted_slash = redact_database_url(slash_pw)
    assert "1234" not in redacted_slash
    assert "secret" not in redacted_slash
    assert "admin:***@db.internal:5432/prod" in redacted_slash

    empty_user_sqlite = "sqlite:///:sqlite_secret@localhost/db"
    redacted_empty_user = redact_database_url(empty_user_sqlite)
    assert "sqlite_secret" not in redacted_empty_user

    # 4. W6-R2-04 & W6-REF1-06: postgres+<driver>:// normalization + engine.dispose() on post-create error
    captured_async_urls: list[str] = []

    class DummyAsyncEngine:
        dialect = MagicMock(name="postgresql")
        sync_engine = None

        def connect(self) -> Any:
            return None

    norm_async = create_managed_async_engine(
        "postgres+asyncpg://u:pw_secret@db.example.test:5432/app",
        async_engine_factory=lambda u, **_kw: (captured_async_urls.append(u), DummyAsyncEngine())[1],
    )
    assert norm_async["ok"] is True
    assert captured_async_urls == ["postgresql+asyncpg://u:pw_secret@db.example.test:5432/app"]
    assert norm_async["data"]["dialect"] == "postgresql"
    assert "pw_secret" not in norm_async["data"]["redacted_url"]

    disposed_calls: list[bool] = []
    mock_created_engine = MagicMock()
    mock_created_engine.sync_engine = None
    mock_created_engine.dispose.side_effect = lambda: disposed_calls.append(True)
    sa_fail_after_create = MagicMock()
    sa_fail_after_create.create_engine.return_value = mock_created_engine
    sa_fail_after_create.event.listens_for.side_effect = RuntimeError("event hook failed")

    setup_err = create_managed_engine("sqlite:///tmp_fail.db", sa_module=sa_fail_after_create)
    assert setup_err["ok"] is False
    assert setup_err["error"]["code"] == "DB_ENGINE_ERROR"
    assert disposed_calls == [True]

    # 5. W6-REF4-02: Oversized 0x/0o integers and lone-surrogate/NUL mapping keys fail closed
    huge_hex = parse_safe_yaml("v: 0x" + ("f" * 4000) + "\n")
    assert huge_hex["ok"] is False
    assert huge_hex["error"]["code"] == "YAML_PARSE_ERROR"

    huge_oct = parse_safe_yaml("v: 0o" + ("7" * 5000) + "\n")
    assert huge_oct["ok"] is False
    assert huge_oct["error"]["code"] == "YAML_PARSE_ERROR"

    huge_dump = dump_safe_yaml({"v": 1 << 20000})
    assert huge_dump["ok"] is False
    assert huge_dump["error"]["code"] == "YAML_DUMP_ERROR"

    surrogate_key_dump = dump_safe_yaml({"bad\ud800key": 1})
    assert surrogate_key_dump["ok"] is False
    assert surrogate_key_dump["error"]["code"] == "YAML_DUMP_ERROR"

    nul_key_dump = dump_safe_yaml({"bad\x00key": 1})
    assert nul_key_dump["ok"] is False
    assert nul_key_dump["error"]["code"] == "YAML_DUMP_ERROR"

    # 6. W6-R3-01: redact_database_url preserves @ in query/path while scrubbing secrets
    r3_vectors = [
        (
            "postgresql://127.0.0.1/appdb?password=SUPER_SECRET&options=a:b&app=worker@app",
            "postgresql://127.0.0.1/appdb?password=***&options=a:b&app=worker@app",
            "SUPER_SECRET",
        ),
        (
            "postgresql://admin@127.0.0.1/appdb?token=MY_SECRET_TOKEN&tz=UTC:00&app=worker@app",
            "postgresql://admin@127.0.0.1/appdb?token=***&tz=UTC:00&app=worker@app",
            "MY_SECRET_TOKEN",
        ),
        (
            "postgresql+asyncpg://admin:s3cr3t@127.0.0.1:5432/appdb?application_name=worker@app",
            "postgresql+asyncpg://admin:***@127.0.0.1:5432/appdb?application_name=worker@app",
            "s3cr3t",
        ),
        (
            "postgresql+asyncpg://127.0.0.1:5432/appdb?application_name=worker@app",
            "postgresql+asyncpg://127.0.0.1:5432/appdb?application_name=worker@app",
            None,
        ),
        (
            "postgresql://db-host.internal:5434/appdb?application_name=worker@app",
            "postgresql://db-host.internal:5434/appdb?application_name=worker@app",
            None,
        ),
        (
            "postgresql://admin:s3cr3t@db.internal:5432/path/with@at",
            "postgresql://admin:***@db.internal:5432/path/with@at",
            "s3cr3t",
        ),
        (
            "sqlite:///path/to/file.db?password=SUPER_SECRET&options=a:b&app=worker@app",
            "sqlite:///path/to/file.db?password=***&options=a:b&app=worker@app",
            "SUPER_SECRET",
        ),
    ]
    for raw_u, expected_u, forbidden_tok in r3_vectors:
        actual_u = redact_database_url(raw_u)
        assert actual_u == expected_u, f"Mismatch for {raw_u!r}: got {actual_u!r}, expected {expected_u!r}"
        if forbidden_tok is not None:
            assert forbidden_tok not in actual_u

    embedded_err = redact_database_url(
        "Connect error: postgresql://127.0.0.1/appdb?password=SUPER_SECRET&app=worker@app password='kv_pw'"
    )
    assert "SUPER_SECRET" not in embedded_err
    assert "kv_pw" not in embedded_err
    assert "postgresql://127.0.0.1/appdb?password=***&app=worker@app" in embedded_err

    # 7. SRE-W6-02: JSON-superset UTF-16 surrogate pairs decode to astral code points while lone escapes fail closed
    json_surrogate_pair = parse_safe_yaml('{"a": "\\ud83d\\ude80", "\\ud83d\\udee1": "shield"}')
    assert json_surrogate_pair["ok"] is True
    assert json_surrogate_pair["data"]["value"] == {"a": "🚀", "🛡": "shield"}
    assert dump_safe_yaml(json_surrogate_pair["data"]["value"])["ok"] is True

    for bad_surrogate_yaml in [
        'a: "\\uD800"\n',
        'a: "\\uDFFF"\n',
        '{"\\uD800": 1}\n',
        'a: "\\uDC00\\uD800"\n',
    ]:
        bad_sur = parse_safe_yaml(bad_surrogate_yaml)
        assert bad_sur["ok"] is False, f"Expected YAML_PARSE_ERROR for {bad_surrogate_yaml!r}"
        assert bad_sur["error"]["code"] == "YAML_PARSE_ERROR"




