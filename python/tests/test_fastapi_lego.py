"""Tests for krusch_toolkit.fastapi_app Lego bricks (INV-LEGO-01, INV-LEGO-02, INV-LEGO-03)."""

from __future__ import annotations

import importlib
import json
import sys
import uuid
from typing import Any

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from pydantic import BaseModel, field_validator

import krusch_toolkit.fastapi_app as fastapi_lego
from krusch_toolkit.fastapi_app import (
    create_fastapi_app,
    error_envelope,
    format_sse_frame,
    ok_envelope,
    sse_event_response,
)


def _parse_sse_frames(raw_body: str) -> list[tuple[str, Any]]:
    frames: list[tuple[str, Any]] = []
    for block in raw_body.strip().split("\n\n"):
        if not block.strip():
            continue
        lines = block.split("\n")
        if all(line.startswith(":") for line in lines):
            continue
        event_name = "message"
        data_lines: list[str] = []
        for line in lines:
            if line.startswith("event: "):
                event_name = line[len("event: ") :]
            elif line.startswith("data: "):
                data_lines.append(line[len("data: ") :])
        joined = "\n".join(data_lines)
        try:
            payload = json.loads(joined)
        except json.JSONDecodeError:
            payload = joined
        frames.append((event_name, payload))
    return frames


def test_ok_and_error_envelopes() -> None:
    res = ok_envelope("search", "Found 2 items", {"items": [1, 2]})
    assert res == {
        "ok": True,
        "tool": "search",
        "summary": "Found 2 items",
        "data": {"items": [1, 2]},
    }

    fallback = ok_envelope("", "", None)
    assert fallback == {
        "ok": True,
        "tool": "fastapi",
        "summary": "OK",
        "data": {},
    }

    err_minimal = error_envelope("NOT_FOUND", "Document missing")
    assert err_minimal == {
        "ok": False,
        "tool": "fastapi",
        "summary": "Document missing",
        "error": {
            "code": "NOT_FOUND",
            "message": "Document missing",
        },
    }
    assert "details" not in err_minimal["error"]

    err_detailed = error_envelope(
        "VALIDATION_ERROR",
        "Invalid payload",
        details=[{"loc": ["body", "limit"], "msg": "must be > 0"}],
        tool="nexus-api",
    )
    assert err_detailed == {
        "ok": False,
        "tool": "nexus-api",
        "summary": "Invalid payload",
        "error": {
            "code": "VALIDATION_ERROR",
            "message": "Invalid payload",
            "details": [{"loc": ["body", "limit"], "msg": "must be > 0"}],
        },
    }


def test_format_sse_frame_json_and_multiline_strings() -> None:
    dict_frame = format_sse_frame("token", {"delta": "hello"})
    assert dict_frame == 'event: token\ndata: {"delta": "hello"}\n\n'

    list_frame = format_sse_frame("batch", [1, "two"])
    assert list_frame == 'event: batch\ndata: [1, "two"]\n\n'

    multiline_frame = format_sse_frame("note\ninjected", "line one\nline two\r\nline three")
    assert multiline_frame == (
        "event: noteinjected\n"
        "data: line one\n"
        "data: line two\n"
        "data: line three\n\n"
    )


def test_health_and_doctor_ok_and_extra_metadata() -> None:
    async def check_deps() -> dict[str, Any]:
        return {"postgres": "ready", "latency_ms": 1.4}

    app = create_fastapi_app(
        title="Krusch Law API",
        version="2.1.0",
        service_name="krusch-law",
        health_check=check_deps,
    )

    with TestClient(app) as client:
        for path in ("/health", "/doctor"):
            resp = client.get(path)
            assert resp.status_code == 200
            body = resp.json()
            assert body == {
                "ok": True,
                "tool": "krusch-law",
                "summary": "Service healthy",
                "data": {
                    "service": "krusch-law",
                    "version": "2.1.0",
                    "postgres": "ready",
                    "latency_ms": 1.4,
                },
            }


def test_health_and_doctor_unhealthy_dict_and_exception() -> None:
    app_false = create_fastapi_app(
        title="Degraded App",
        health_check=lambda: {"ok": False, "summary": "Primary DB offline", "db": "down"},
    )
    with TestClient(app_false) as client:
        for path in ("/health", "/doctor"):
            resp = client.get(path)
            assert resp.status_code == 503
            body = resp.json()
            assert body["ok"] is False
            assert body["tool"] == "degraded-app"
            assert body["error"]["code"] == "UNHEALTHY"
            assert "Primary DB offline" in body["summary"]
            assert body["error"]["details"]["db"] == "down"

    async def broken_check() -> dict[str, Any]:
        raise ConnectionError("pgvector pool exhausted")

    app_raises = create_fastapi_app(title="Broken App", health_check=broken_check)
    with TestClient(app_raises) as client:
        resp = client.get("/health")
        assert resp.status_code == 503
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "UNHEALTHY"
        assert "pgvector pool exhausted" in body["error"]["message"]


def test_request_context_headers_and_cors() -> None:
    app = create_fastapi_app(
        title="Header Test",
        cors_origins=["https://krusch.dev"],
    )

    @app.get("/whoami")
    async def whoami(request: Request) -> dict[str, Any]:
        return ok_envelope("whoami", "Resolved context", {"request_id": request.state.request_id})

    with TestClient(app) as client:
        # Auto-generated UUID when no X-Request-ID sent
        r1 = client.get("/whoami")
        assert r1.status_code == 200
        generated_id = r1.headers["X-Request-ID"]
        uuid.UUID(generated_id)
        assert float(r1.headers["X-Response-Time-Ms"]) >= 0.0
        assert r1.headers["X-Content-Type-Options"] == "nosniff"
        assert r1.json()["data"]["request_id"] == generated_id

        # Caller-provided X-Request-ID preserved end-to-end
        r2 = client.get("/whoami", headers={"X-Request-ID": "trace-custom-99"})
        assert r2.headers["X-Request-ID"] == "trace-custom-99"
        assert r2.json()["data"]["request_id"] == "trace-custom-99"

        # CORS preflight honors explicit origin + credentials
        preflight = client.options(
            "/whoami",
            headers={
                "Origin": "https://krusch.dev",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert preflight.headers.get("access-control-allow-origin") == "https://krusch.dev"
        assert preflight.headers.get("access-control-allow-credentials") == "true"


def test_lifespan_startup_and_shutdown_hooks() -> None:
    events: list[str] = []

    def sync_start() -> None:
        events.append("sync_start")

    async def async_start() -> None:
        events.append("async_start")

    def sync_stop() -> None:
        events.append("sync_stop")

    async def async_stop() -> None:
        events.append("async_stop")

    app = create_fastapi_app(
        title="Lifespan Service",
        startup_hooks=[sync_start, async_start],
        shutdown_hooks=[sync_stop, async_stop],
    )

    assert events == []
    with TestClient(app) as client:
        assert events == ["sync_start", "async_start"]
        resp = client.get("/health")
        assert resp.status_code == 200

    assert events == ["sync_start", "async_start", "sync_stop", "async_stop"]


def test_http_404_validation_422_and_unhandled_500_envelopes() -> None:
    app = create_fastapi_app(title="Error Contract API", service_name="err-api")

    class QueryPayload(BaseModel):
        query: str
        limit: int

        @field_validator("limit")
        @classmethod
        def _positive_limit(cls, val: int) -> int:
            if val <= 0:
                raise ValueError("limit must be positive")
            return val

    @app.get("/items/{item_id}")
    async def get_item(item_id: int) -> dict[str, Any]:
        if item_id == 404:
            raise HTTPException(status_code=404, detail="Item 404 does not exist")
        return ok_envelope("items.get", "Found item", {"item_id": item_id})

    @app.post("/search")
    async def search_route(payload: QueryPayload) -> dict[str, Any]:
        return ok_envelope("search", "Executed", payload.model_dump())

    @app.get("/explode")
    async def explode() -> dict[str, Any]:
        raise RuntimeError("unexpected boom")

    with TestClient(app, raise_server_exceptions=False) as client:
        # Custom route success envelope
        ok_resp = client.get("/items/7")
        assert ok_resp.status_code == 200
        assert ok_resp.json() == {
            "ok": True,
            "tool": "items.get",
            "summary": "Found item",
            "data": {"item_id": 7},
        }

        # Explicit HTTPException(404)
        missing_item = client.get("/items/404")
        assert missing_item.status_code == 404
        assert missing_item.json() == {
            "ok": False,
            "tool": "err-api",
            "summary": "Item 404 does not exist",
            "error": {
                "code": "NOT_FOUND",
                "message": "Item 404 does not exist",
            },
        }
        assert missing_item.headers["X-Content-Type-Options"] == "nosniff"

        # Unmatched route 404
        unmatched = client.get("/nonexistent-route")
        assert unmatched.status_code == 404
        assert unmatched.json()["ok"] is False
        assert unmatched.json()["error"]["code"] == "NOT_FOUND"

        # RequestValidationError(422) including custom ValueError validator
        invalid_body = client.post("/search", json={"query": "hello", "limit": 0})
        assert invalid_body.status_code == 422
        val_json = invalid_body.json()
        assert val_json["ok"] is False
        assert val_json["tool"] == "err-api"
        assert val_json["error"]["code"] == "VALIDATION_ERROR"
        assert isinstance(val_json["error"]["details"], list)
        assert len(val_json["error"]["details"]) >= 1

        # Unhandled RuntimeError -> JSON 500 INTERNAL_ERROR (never HTML)
        crash = client.get("/explode", headers={"X-Request-ID": "req-crash-500"})
        assert crash.status_code == 500
        assert crash.headers["content-type"].startswith("application/json")
        assert crash.headers["X-Request-ID"] == "req-crash-500"
        assert crash.headers["X-Content-Type-Options"] == "nosniff"
        assert crash.json() == {
            "ok": False,
            "tool": "err-api",
            "summary": "Internal server error",
            "error": {
                "code": "INTERNAL_ERROR",
                "message": "Internal server error",
            },
        }


def test_sse_event_response_streaming_disconnect_and_errors() -> None:
    app = create_fastapi_app(title="SSE Service")
    cleanup_tracker = {"closed": False, "emitted_count": 0}

    @app.get("/stream")
    async def stream_tokens(request: Request) -> Any:
        async def token_gen():
            yield "Hel"
            yield "lo"
            yield ("meta", {"tokens": 2})
            yield {"event": "progress", "data": {"pct": 100}}

        return sse_event_response(token_gen(), request=request)

    @app.get("/stream-error")
    async def stream_failure() -> Any:
        def broken_gen():
            yield "partial"
            raise ValueError("upstream stream interrupted")

        return sse_event_response(broken_gen())

    @app.get("/stream-disconnect")
    async def stream_disconnect() -> Any:
        class DisconnectAfterFirstRequest:
            def __init__(self) -> None:
                self.calls = 0

            async def is_disconnected(self) -> bool:
                self.calls += 1
                # Calls: 1 (initial), 2 (before item 1), 3 (after item 1 -> disconnect!)
                return self.calls >= 3

        async def infinite_gen():
            try:
                for idx in range(10):
                    cleanup_tracker["emitted_count"] += 1
                    yield f"chunk-{idx}"
            finally:
                cleanup_tracker["closed"] = True

        return sse_event_response(infinite_gen(), request=DisconnectAfterFirstRequest())

    with TestClient(app) as client:
        resp = client.get("/stream")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        assert resp.headers["X-Accel-Buffering"] == "no"
        assert resp.headers["Cache-Control"] == "no-cache, no-transform"

        frames = _parse_sse_frames(resp.text)
        assert frames == [
            ("token", {"delta": "Hel"}),
            ("token", {"delta": "lo"}),
            ("meta", {"tokens": 2}),
            ("progress", {"pct": 100}),
            ("done", {"ok": True, "tool": "sse", "summary": "Stream complete", "data": {}}),
        ]

        err_resp = client.get("/stream-error")
        err_frames = _parse_sse_frames(err_resp.text)
        assert err_frames[0] == ("token", {"delta": "partial"})
        assert err_frames[1][0] == "error"
        assert err_frames[1][1]["ok"] is False
        assert err_frames[1][1]["error"]["code"] == "STREAM_ERROR"
        assert "upstream stream interrupted" in err_frames[1][1]["error"]["message"]

        disc_resp = client.get("/stream-disconnect")
        disc_frames = _parse_sse_frames(disc_resp.text)
        assert disc_frames == [("token", {"delta": "chunk-0"})]
        assert cleanup_tracker["emitted_count"] == 1
        assert cleanup_tracker["closed"] is True


def test_graceful_error_when_fastapi_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "fastapi", None)

    reloaded = importlib.reload(fastapi_lego)
    assert reloaded.ok_envelope("ping", "Still works", {"bare": True}) == {
        "ok": True,
        "tool": "ping",
        "summary": "Still works",
        "data": {"bare": True},
    }
    assert reloaded.error_envelope("NO_DEPS", "Pure stdlib")["ok"] is False
    assert reloaded.format_sse_frame("token", {"delta": "ok"}).startswith("event: token\n")

    with pytest.raises(
        RuntimeError,
        match=r"FastAPI is required for create_fastapi_app; install krusch-toolkit\[fastapi\]",
    ):
        reloaded.create_fastapi_app()

    with pytest.raises(
        RuntimeError,
        match=r"FastAPI is required for sse_event_response; install krusch-toolkit\[fastapi\]",
    ):
        reloaded.sse_event_response(["chunk"])


def test_sse_custom_done_frame_not_duplicated() -> None:
    app = create_fastapi_app(title="Custom Done SSE")

    @app.get("/custom-done")
    async def custom_done_route() -> Any:
        def gen():
            yield "step-1"
            yield ("done", ok_envelope("custom-sse", "Finished early", {"steps": 1}))

        return sse_event_response(gen())

    with TestClient(app) as client:
        resp = client.get("/custom-done")
        assert resp.status_code == 200
        frames = _parse_sse_frames(resp.text)
        assert len(frames) == 2
        assert frames[0] == ("token", {"delta": "step-1"})
        assert frames[1] == (
            "done",
            {"ok": True, "tool": "custom-sse", "summary": "Finished early", "data": {"steps": 1}},
        )
        assert resp.text.startswith(": ping\n\n")


def test_sse_heartbeat_comment_sanitizes_crlf() -> None:
    app = create_fastapi_app(title="Heartbeat Sanitizer SSE")

    @app.get("/hb")
    async def hb_route() -> Any:
        return sse_event_response(["ok"], heartbeat_comment="keepalive\r\nevent: injected")

    with TestClient(app) as client:
        resp = client.get("/hb")
        assert resp.status_code == 200
        assert resp.text.startswith(": keepaliveevent: injected\n\n")
        frames = _parse_sse_frames(resp.text)
        assert frames[0] == ("token", {"delta": "ok"})


def test_sse_disconnect_acloses_retained_async_generator() -> None:
    app = create_fastapi_app(title="Retained AsyncGen SSE")
    retained_refs: list[Any] = []
    state = {"closed": False}

    @app.get("/retained-disconnect")
    async def retained_disconnect() -> Any:
        class DisconnectAfterFirstChunk:
            def __init__(self) -> None:
                self.calls = 0

            async def is_disconnected(self) -> bool:
                self.calls += 1
                return self.calls >= 3

        async def upstream_stream():
            try:
                yield "first"
                yield "second"
            finally:
                state["closed"] = True

        gen = upstream_stream()
        # Hold strong reference so GC cannot mask missing await aiter.aclose()
        retained_refs.append(gen)
        return sse_event_response(gen, request=DisconnectAfterFirstChunk())

    with TestClient(app) as client:
        resp = client.get("/retained-disconnect")
        assert resp.status_code == 200
        assert state["closed"] is True
        assert len(retained_refs) == 1


def test_empty_cors_origins_list_disables_wildcard_cors_and_immediate_sse_disconnect_closes_gen() -> None:
    app = create_fastapi_app(title="Locked CORS Service", cors_origins=[])
    retained_refs: list[Any] = []
    state = {"resource_closed": False}

    class ImmediatelyDisconnected:
        async def is_disconnected(self) -> bool:
            return True

    class PreOpenedAsyncStream:
        def __aiter__(self):
            return self

        async def __anext__(self) -> str:
            raise StopAsyncIteration

        async def aclose(self) -> None:
            state["resource_closed"] = True

    @app.get("/early-disconnect-gen")
    async def early_disconnect_gen() -> Any:
        async def upstream_stream():
            yield "never-sent"

        gen = upstream_stream()
        assert gen.ag_frame is not None
        retained_refs.append(gen)
        return sse_event_response(gen, request=ImmediatelyDisconnected())

    @app.get("/early-disconnect-resource")
    async def early_disconnect_resource() -> Any:
        stream = PreOpenedAsyncStream()
        retained_refs.append(stream)
        return sse_event_response(stream, request=ImmediatelyDisconnected())

    with TestClient(app) as client:
        cors_resp = client.get("/health", headers={"Origin": "https://untrusted.example"})
        assert cors_resp.status_code == 200
        assert "access-control-allow-origin" not in cors_resp.headers

        sse_gen = client.get("/early-disconnect-gen")
        assert sse_gen.status_code == 200
        assert sse_gen.text == ""
        assert retained_refs[0].ag_frame is None

        sse_res = client.get("/early-disconnect-resource")
        assert sse_res.status_code == 200
        assert sse_res.text == ""
        assert state["resource_closed"] is True
        assert len(retained_refs) == 2


def test_sse_midstream_disconnect_deterministically_awaits_aclosing_before_iterator_returns() -> None:
    import asyncio

    state = {"gen_closed": False, "wrapper_closed": False}

    class DisconnectAfterFirstYield:
        def __init__(self) -> None:
            self.calls = 0

        async def is_disconnected(self) -> bool:
            self.calls += 1
            # 1: pre-entry False, 2: before chunk 1 False, 3: after chunk 1 True -> break
            return self.calls >= 3

    class WrappedAsyncSource:
        def __aiter__(self):
            async def _inner():
                try:
                    yield "chunk-1"
                    yield "chunk-2"
                finally:
                    state["gen_closed"] = True

            return _inner()

        async def aclose(self) -> None:
            state["wrapper_closed"] = True

    async def _consume() -> list[str]:
        source = WrappedAsyncSource()
        resp = sse_event_response(source, request=DisconnectAfterFirstYield())
        chunks: list[str] = []
        async for chunk in resp.body_iterator:
            chunks.append(chunk if isinstance(chunk, str) else chunk.decode("utf-8"))
        # Must ALREADY be closed synchronously upon _stream() exit without waiting for GC or extra loop turns
        assert state["gen_closed"] is True
        assert state["wrapper_closed"] is True
        return chunks

    emitted = asyncio.run(_consume())
    assert len(emitted) == 2  # initial ": ping\n\n" + first "token" frame, no "done" frame
    assert "chunk-1" in emitted[1]


def test_lifespan_shutdown_hook_error_never_masks_startup_or_cancelled_exception() -> None:
    import asyncio

    stop_log: list[str] = []

    def failing_startup() -> None:
        raise ConnectionRefusedError("postgres unreachable")

    def failing_shutdown_1() -> None:
        stop_log.append("stop1")
        raise AttributeError("db handle was never initialized")

    def succeeding_shutdown_2() -> None:
        stop_log.append("stop2")

    app_startup_fail = create_fastapi_app(
        title="Startup Failure App",
        startup_hooks=[failing_startup],
        shutdown_hooks=[failing_shutdown_1, succeeding_shutdown_2],
    )

    with pytest.raises(ConnectionRefusedError, match="postgres unreachable"), TestClient(app_startup_fail):
        pass
    assert stop_log == ["stop1", "stop2"]

    # Also verify asyncio.CancelledError propagating out of yield is not masked by shutdown hook Exception
    cancel_log: list[str] = []
    app_cancel = create_fastapi_app(
        title="Cancelled Lifespan App",
        shutdown_hooks=[
            lambda: (cancel_log.append("s1"), (_ for _ in ()).throw(RuntimeError("stop boom"))),
            lambda: cancel_log.append("s2"),
        ],
    )

    async def _run_cancelled_lifespan() -> None:
        async with app_cancel.router.lifespan_context(app_cancel):
            raise asyncio.CancelledError("uvicorn shutdown cancel")

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(_run_cancelled_lifespan())
    assert cancel_log == ["s1", "s2"]


def test_unhandled_500_preserves_cors_and_rejects_null_or_crlf_origins() -> None:
    # 1. Default wildcard CORS preserves Access-Control-Allow-Origin: * on unhandled 500
    wildcard_app = create_fastapi_app(title="Wildcard Crash API")

    @wildcard_app.get("/boom")
    async def wildcard_boom() -> dict[str, Any]:
        raise RuntimeError("wildcard crash")

    with TestClient(wildcard_app, raise_server_exceptions=False) as client:
        resp_500 = client.get("/boom", headers={"Origin": "https://anywhere.example"})
        assert resp_500.status_code == 500
        assert resp_500.headers.get("access-control-allow-origin") == "*"
        assert resp_500.json()["ok"] is False
        assert resp_500.json()["error"]["code"] == "INTERNAL_ERROR"

    # 2. Explicit allowlist strips "null"/"false"/CRLF entries, reflects trusted origin on 500, and rejects Origin: null
    strict_app = create_fastapi_app(
        title="Strict CORS Crash API",
        cors_origins=[
            "  https://krusch.dev  ",
            "null",
            "false",
            "https://bad.example\r\nX-Injected: 1",
        ],
    )

    @strict_app.get("/boom")
    async def strict_boom() -> dict[str, Any]:
        raise RuntimeError("strict crash")

    with TestClient(strict_app, raise_server_exceptions=False) as client:
        allowed_500 = client.get("/boom", headers={"Origin": "https://krusch.dev"})
        assert allowed_500.status_code == 500
        assert allowed_500.headers.get("access-control-allow-origin") == "https://krusch.dev"
        assert allowed_500.headers.get("access-control-allow-credentials") == "true"
        assert "origin" in (allowed_500.headers.get("vary") or "").lower()

        null_500 = client.get("/boom", headers={"Origin": "null"})
        assert null_500.status_code == 500
        assert null_500.headers.get("access-control-allow-origin") is None

        evil_500 = client.get("/boom", headers={"Origin": "https://evil.example"})
        assert evil_500.status_code == 500
        assert evil_500.headers.get("access-control-allow-origin") is None


def test_brownfield_lifespan_request_health_flatten_and_legacy_detail() -> None:
    from contextlib import asynccontextmanager

    lifecycle_events: list[str] = []

    @asynccontextmanager
    async def custom_lifespan(app_instance: Any):
        lifecycle_events.append("lifespan_enter")
        app_instance.state.domain_ready = True
        try:
            yield
        finally:
            lifecycle_events.append("lifespan_exit")

    def request_aware_health(request: Request) -> dict[str, Any]:
        return {
            "status": "healthy",
            "domain_ready": getattr(request.app.state, "domain_ready", False),
            "client_host": request.client.host if request.client else "unknown",
        }

    app = create_fastapi_app(
        title="Brownfield API",
        description="Brownfield compatibility test",
        version="0.8.0",
        docs_url="/docs",
        redoc_url="/redoc",
        service_name="brownfield-api",
        cors_origins=["*"],
        allow_credentials=True,  # Must clamp to False when "*" is in origins
        lifespan=custom_lifespan,
        health_check=request_aware_health,
        flatten_health_payload=True,
        legacy_error_detail=True,
        startup_hooks=[lambda: lifecycle_events.append("hook_start")],
        shutdown_hooks=[lambda: lifecycle_events.append("hook_stop")],
    )

    class HoldPayload(BaseModel):
        as_of_date: str

    @app.delete("/cases/{case_id}")
    async def purge_case(case_id: int) -> dict[str, Any]:
        if case_id == 1:
            raise HTTPException(status_code=423, detail="Cannot purge matter under active legal hold")
        return ok_envelope("purge", "Deleted", {"id": case_id})

    @app.post("/join")
    async def run_join(payload: HoldPayload) -> dict[str, Any]:
        return ok_envelope("join", "OK", {"as_of_date": payload.as_of_date})

    with TestClient(app) as client:
        assert lifecycle_events == ["hook_start", "lifespan_enter"]

        # /health flattens domain keys while keeping immutable INV-LEGO-01 envelope fields
        h_resp = client.get("/health")
        assert h_resp.status_code == 200
        h_json = h_resp.json()
        assert h_json["ok"] is True
        assert h_json["tool"] == "brownfield-api"
        assert h_json["status"] == "healthy"
        assert h_json["service"] == "brownfield-api"
        assert h_json["domain_ready"] is True
        assert h_json["data"]["domain_ready"] is True

        # /doctor remains strict INV-LEGO-01 envelope without top-level domain flattening
        d_resp = client.get("/doctor")
        assert d_resp.status_code == 200
        d_json = d_resp.json()
        assert set(d_json.keys()) == {"ok", "tool", "summary", "data"}
        assert d_json["data"]["status"] == "healthy"

        # 423 LOCKED carries both INV-LEGO-01 error and legacy detail
        locked = client.delete("/cases/1", headers={"Origin": "https://anywhere.example"})
        assert locked.status_code == 423
        locked_json = locked.json()
        assert locked_json["ok"] is False
        assert locked_json["error"]["code"] == "LOCKED"
        assert "active legal hold" in locked_json["detail"]
        assert locked.headers.get("access-control-allow-origin") == "*"
        assert locked.headers.get("access-control-allow-credentials") is None

        # 422 RequestValidationError carries both error.details and top-level detail list
        bad_join = client.post("/join", json={})
        assert bad_join.status_code == 422
        bad_json = bad_join.json()
        assert bad_json["ok"] is False
        assert bad_json["error"]["code"] == "VALIDATION_ERROR"
        assert isinstance(bad_json["detail"], list)

    assert lifecycle_events == ["hook_start", "lifespan_enter", "lifespan_exit", "hook_stop"]


def test_sse_event_response_passthrough_openai_and_bytes_cleanup() -> None:
    app = create_fastapi_app(title="OpenAI Proxy SSE")
    closed_state = {"bytes_closed": False}

    @app.get("/v1/chat/stream")
    async def openai_stream() -> Any:
        async def _gen():
            yield 'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"Hi"}}]}\n\n'
            yield "data: [DONE]\n\n"

        return sse_event_response(_gen(), passthrough=True, heartbeat_comment="")

    @app.get("/v1/proxy/bytes")
    async def bytes_stream() -> Any:
        async def _bytes_gen():
            try:
                yield b'data: {"chunk":1}\n\n'
                yield b"data: [DONE]\n\n"
            finally:
                closed_state["bytes_closed"] = True

        return sse_event_response(_bytes_gen(), passthrough=True, heartbeat_comment=None)

    with TestClient(app) as client:
        r1 = client.get("/v1/chat/stream")
        assert r1.status_code == 200
        assert r1.headers["content-type"].startswith("text/event-stream")
        assert r1.headers["X-Accel-Buffering"] == "no"
        assert r1.headers["Cache-Control"] == "no-cache, no-transform"
        assert (
            r1.text
            == 'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n'
        )
        assert "event: done" not in r1.text

        r2 = client.get("/v1/proxy/bytes")
        assert r2.status_code == 200
        assert r2.text == 'data: {"chunk":1}\n\ndata: [DONE]\n\n'
        assert closed_state["bytes_closed"] is True

