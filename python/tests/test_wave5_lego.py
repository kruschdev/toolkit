"""Comprehensive Wave 5 Lego parity tests for krusch_toolkit.{http_client,streamlit_ui} (INV-LEGO-21..22)."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import threading
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import httpx
import pytest

import krusch_toolkit
from krusch_toolkit.http_client import (
    HttpCircuitBreaker,
    async_request_json,
    build_resilient_headers,
    compute_retry_delay,
    create_http_circuit_breaker,
    request_json,
)
from krusch_toolkit.streamlit_ui import (
    AIRGAPPED_THEME_PRESETS,
    append_rag_turn,
    build_airgapped_theme_css,
    build_rag_auth_headers,
    format_citation_badges_html,
    init_rag_session_state,
    render_citation_badges,
    render_sovereign_rag_shell,
)

LIB_PY_ROOT = str(Path(__file__).resolve().parents[1])


# ---------------------------------------------------------------------------
# 0. Bare Python 3.11+ Import Purity & v1.5.0 Root Exports
# ---------------------------------------------------------------------------


def test_wave5_bare_python_import_safety_without_optional_frameworks() -> None:
    """Verify http_client, streamlit_ui, and root krusch_toolkit import cleanly with optional deps blocked."""
    script = (
        "import builtins\n"
        "_orig = builtins.__import__\n"
        "BLOCKED = {'httpx', 'streamlit', 'fastapi', 'starlette', 'pydantic', 'psycopg2', 'sqlalchemy', 'yaml'}\n"
        "def _guarded(name, *args, **kwargs):\n"
        "    if name.split('.')[0] in BLOCKED:\n"
        "        raise ModuleNotFoundError(f'Blocked optional dependency: {name}')\n"
        "    return _orig(name, *args, **kwargs)\n"
        "builtins.__import__ = _guarded\n"
        "import krusch_toolkit as kt\n"
        "assert kt.__version__ == '1.6.0'\n"
        "import krusch_toolkit.http_client as hc\n"
        "import krusch_toolkit.streamlit_ui as sui\n"
        "no_httpx = hc.request_json('https://example.com/api', lookup_fn=lambda _h: ['93.184.216.34'])\n"
        "assert no_httpx['ok'] is False and no_httpx['error']['code'] == 'HTTP_CLIENT_UNAVAILABLE'\n"
        "no_st = sui.render_sovereign_rag_shell(title='Offline Test')\n"
        "assert no_st['ok'] is False and no_st['error']['code'] == 'STREAMLIT_UNAVAILABLE'\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", script],
        env={"PYTHONPATH": LIB_PY_ROOT, "PATH": ""},
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"Isolated import failed:\nSTDOUT: {proc.stdout}\nSTDERR: {proc.stderr}"


def test_root_krusch_toolkit_v1_5_exports() -> None:
    assert krusch_toolkit.__version__ == "1.6.0"
    expected_exports = {
        "HttpCircuitBreaker",
        "create_http_circuit_breaker",
        "compute_retry_delay",
        "build_resilient_headers",
        "request_json",
        "async_request_json",
        "AIRGAPPED_THEME_PRESETS",
        "build_airgapped_theme_css",
        "build_rag_auth_headers",
        "format_citation_badges_html",
        "render_citation_badges",
        "init_rag_session_state",
        "append_rag_turn",
        "render_sovereign_rag_shell",
    }
    assert expected_exports.issubset(set(krusch_toolkit.__all__))
    for sym in expected_exports:
        assert hasattr(krusch_toolkit, sym)


# ---------------------------------------------------------------------------
# 1. krusch_toolkit.http_client Tests (INV-LEGO-21)
# ---------------------------------------------------------------------------


def test_http_circuit_breaker_single_flight_and_max_hosts_eviction() -> None:
    now = 1_000.0
    breaker = create_http_circuit_breaker(
        failure_threshold=2,
        cooldown_seconds=10.0,
        max_hosts=3,
        clock_fn=lambda: now,
    )

    # Boolean / non-positive / NaN config normalization
    weird_breaker = HttpCircuitBreaker(
        failure_threshold=True,  # type: ignore[arg-type]
        cooldown_seconds=float("nan"),
        max_hosts=-5,
    )
    assert weird_breaker.failure_threshold == 3
    assert weird_breaker.cooldown_seconds == 30.0
    assert weird_breaker.max_hosts == 1

    key = "https://api.example.com:443"
    assert breaker.can_attempt(key) == {
        "allowed": True,
        "state": "CLOSED",
        "probe": False,
        "retry_after_seconds": 0.0,
    }

    breaker.record_failure(key, "502")
    assert breaker.get_state(key)["state"] == "CLOSED"
    breaker.record_failure(key, "503")
    assert breaker.get_state(key)["state"] == "OPEN"

    blocked = breaker.can_attempt(key)
    assert blocked["allowed"] is False
    assert blocked["state"] == "OPEN"
    assert blocked["retry_after_seconds"] == 10.0

    # Advance past cooldown -> single-flight HALF_OPEN probe
    now += 10.5
    assert breaker.get_state(key)["state"] == "HALF_OPEN"
    probe_1 = breaker.can_attempt(key)
    probe_2 = breaker.can_attempt(key)
    assert probe_1 == {
        "allowed": True,
        "state": "HALF_OPEN",
        "probe": True,
        "retry_after_seconds": 0.0,
    }
    assert probe_2["allowed"] is False
    assert probe_2["state"] == "HALF_OPEN"

    # Cancellation release_probe allows immediate next probe without marking failure
    breaker.release_probe(key)
    probe_3 = breaker.can_attempt(key)
    assert probe_3["allowed"] is True
    assert probe_3["probe"] is True

    # Failed HALF_OPEN probe immediately re-opens circuit
    breaker.record_failure(key, "probe_timeout")
    assert breaker.get_state(key)["state"] == "OPEN"

    now += 11.0
    assert breaker.can_attempt(key)["allowed"] is True
    breaker.record_success(key)
    assert breaker.get_state(key)["state"] == "CLOSED"
    assert breaker.get_state(key)["failures"] == 0

    # Bounded max_hosts eviction
    for idx in range(6):
        breaker.record_failure(f"https://host-{idx}.example.com:443", "err")
    snap = breaker.snapshot()
    assert len(snap) <= 3
    breaker.reset("https://host-5.example.com:443")
    assert "https://host-5.example.com:443" not in breaker.snapshot()
    breaker.clear()
    assert breaker.snapshot() == {}


def test_compute_retry_delay_backoff_retry_after_and_adversarial_inputs() -> None:
    assert compute_retry_delay(1, base_delay=0.5, max_delay=4.0) == 0.5
    assert compute_retry_delay(2, base_delay=0.5, max_delay=4.0) == 1.0
    assert compute_retry_delay(3, base_delay=0.5, max_delay=4.0) == 2.0
    assert compute_retry_delay(10, base_delay=0.5, max_delay=4.0) == 4.0

    # Numeric Retry-After clamped to max_delay
    assert compute_retry_delay(1, max_delay=5.0, retry_after_header="2.5") == 2.5
    assert compute_retry_delay(1, max_delay=5.0, retry_after_header="99") == 5.0

    # HTTP-date Retry-After
    future_http_date = format_datetime(datetime.now(UTC) + timedelta(seconds=3), usegmt=True)
    delay_from_date = compute_retry_delay(1, max_delay=10.0, retry_after_header=future_http_date)
    assert 0.0 <= delay_from_date <= 10.0

    # Jitter & bool/NaN/Inf resilience
    jittered = compute_retry_delay(2, base_delay=1.0, max_delay=10.0, jitter_ratio=0.5, rng_fn=lambda: 0.0)
    assert jittered == 1.0
    assert compute_retry_delay(True, base_delay=float("nan"), max_delay=float("inf")) == 0.25  # type: ignore[arg-type]


def test_build_resilient_headers_injection_guards_and_case_preservation() -> None:
    ok_res = build_resilient_headers(
        {"x-request-id": "req-custom-42", "X-Custom": "alpha"},
        api_key="k_live_123",
        bearer_token="tok_xyz",
    )
    assert ok_res["ok"] is True
    hdrs = ok_res["data"]["headers"]
    assert ok_res["data"]["request_id"] == "req-custom-42"
    assert hdrs["x-request-id"] == "req-custom-42"
    assert "X-Request-ID" not in hdrs
    assert hdrs["Accept"] == "application/json"
    assert hdrs["X-API-Key"] == "k_live_123"
    assert hdrs["Authorization"] == "Bearer tok_xyz"

    for bad_kwargs in (
        {"headers": {"Bad\r\nHeader": "val"}},
        {"headers": {"X-Test": "line1\r\nInjected: evil"}},
        {"headers": {"X-Null": "abc\x00def"}},
        {"headers": {"Invalid Space": "val"}},
        {"headers": {"X-Int": 123}},  # type: ignore[dict-item]
        {"api_key": "secret\ninjected"},
        {"bearer_token": "tok\r\ninjected"},
        {"request_id": "id\x00bad"},
    ):
        err = build_resilient_headers(**bad_kwargs)  # type: ignore[arg-type]
        assert err["ok"] is False
        assert err["error"]["code"] == "HTTP_INVALID_HEADER"


def test_request_json_retries_post_idempotency_ssrf_redirects_and_bounds() -> None:
    public_lookup = lambda _host: ["93.184.216.34"]  # noqa: E731
    sleeps: list[float] = []

    # 1. Transient 503 -> 200 retry on GET, plus json_body=None vs omitted body
    attempts = 0

    def flaky_handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(503, headers={"Retry-After": "0.1"}, json={"error": "busy"})
        return httpx.Response(200, json={"ok_echo": True, "req_id": request.headers.get("X-Request-ID")})

    with httpx.Client(transport=httpx.MockTransport(flaky_handler)) as mock_client:
        res = request_json(
            "https://api.example.com/v1/status",
            max_retries=2,
            lookup_fn=public_lookup,
            client=mock_client,
            sleep_fn=sleeps.append,
        )
    assert res["ok"] is True
    assert res["data"]["status"] == 200
    assert res["data"]["attempts"] == 2
    assert res["data"]["body"]["ok_echo"] is True
    assert len(sleeps) == 1

    # 2. POST does NOT retry on 503 by default unless retry_on_post=True; json_body=None serializes b"null"
    post_calls = 0
    seen_post_bodies: list[bytes] = []

    def post_handler(request: httpx.Request) -> httpx.Response:
        nonlocal post_calls
        post_calls += 1
        seen_post_bodies.append(request.read())
        return httpx.Response(503, json={"error": "overloaded"})

    with httpx.Client(transport=httpx.MockTransport(post_handler)) as post_client:
        no_retry_post = request_json(
            "https://api.example.com/v1/mutate",
            method="POST",
            json_body=None,
            max_retries=3,
            lookup_fn=public_lookup,
            client=post_client,
            sleep_fn=lambda _d: None,
        )
        assert no_retry_post["ok"] is False
        assert no_retry_post["error"]["code"] == "HTTP_UPSTREAM_ERROR"
        assert post_calls == 1
        assert seen_post_bodies[0] == b"null"

        opt_in_retry_post = request_json(
            "https://api.example.com/v1/mutate",
            method="POST",
            json_body={"action": "ping"},
            max_retries=2,
            retry_on_post=True,
            lookup_fn=public_lookup,
            client=post_client,
            sleep_fn=lambda _d: None,
        )
        assert opt_in_retry_post["ok"] is False
        assert post_calls == 4  # 1 + (1 initial + 2 retries)

    # 3. Cross-origin redirect strips Authorization/Cookie/X-API-Key & rewrites 303 POST -> bodyless GET
    hop_requests: list[httpx.Request] = []

    def redirect_handler(request: httpx.Request) -> httpx.Response:
        hop_requests.append(request)
        if str(request.url) == "https://origin-a.example.com/login":
            return httpx.Response(303, headers={"Location": "https://origin-b.example.com/final"})
        return httpx.Response(200, json={"landed": True})

    with httpx.Client(transport=httpx.MockTransport(redirect_handler)) as redir_client:
        built_hdrs = build_resilient_headers(
            {"Cookie": "sid=secret"},
            api_key="k_secret",
            bearer_token="jwt_secret",
        )["data"]["headers"]
        redir_res = request_json(
            "https://origin-a.example.com/login",
            method="POST",
            headers=built_hdrs,
            json_body={"u": "krusch"},
            lookup_fn=public_lookup,
            client=redir_client,
        )
    assert redir_res["ok"] is True
    assert redir_res["data"]["redirected"] is True
    assert len(hop_requests) == 2
    assert hop_requests[0].method == "POST"
    assert hop_requests[0].headers.get("authorization") == "Bearer jwt_secret"
    assert hop_requests[1].method == "GET"
    assert hop_requests[1].read() == b""
    assert hop_requests[1].headers.get("authorization") is None
    assert hop_requests[1].headers.get("cookie") is None
    assert hop_requests[1].headers.get("x-api-key") is None

    # 4. Redirect to AWS metadata 169.254.169.254 is blocked BEFORE connecting
    def evil_redirect_handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"Location": "http://169.254.169.254/latest/meta-data/"})

    with httpx.Client(transport=httpx.MockTransport(evil_redirect_handler)) as evil_client:
        ssrf_redir = request_json(
            "https://origin-a.example.com/start",
            allow_loopback=True,
            lookup_fn=public_lookup,
            client=evil_client,
        )
    assert ssrf_redir["ok"] is False
    assert ssrf_redir["error"]["code"] == "SSRF_PRIVATE_IP"

    # 5. allow_loopback=True permits 127.0.0.1/localhost (honoring allowed_hosts) while blocking 0.0.0.0 & metadata
    for blocked_url in (
        "http://0.0.0.0:8080/health",
        "http://169.254.169.254/latest/meta-data",
        "http://[fd00:ec2::254]/latest",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://[::ffff:127.0.0.1]:8080/health",
    ):
        blocked = request_json(blocked_url, allow_loopback=True)
        assert blocked["ok"] is False
        assert blocked["error"]["code"].startswith("SSRF_"), f"Failed blocking {blocked_url}: {blocked}"

    disallowed_host = request_json(
        "http://127.0.0.1:8085/health",
        allow_loopback=True,
        allowed_hosts=["api.krusch.dev"],
    )
    assert disallowed_host["ok"] is False
    assert disallowed_host["error"]["code"] == "SSRF_HOST_NOT_ALLOWED"

    # 6. max_response_bytes streaming overflow + NaN/Infinity JSON body & response rejection
    nan_req = request_json("https://api.example.com/v1", method="POST", json_body={"x": float("nan")})
    assert nan_req["ok"] is False
    assert nan_req["error"]["code"] == "HTTP_INVALID_JSON_BODY"

    with httpx.Client(
        transport=httpx.MockTransport(lambda _r: httpx.Response(200, content=b"x" * 256))
    ) as big_client:
        too_big = request_json(
            "https://api.example.com/big",
            max_response_bytes=64,
            lookup_fn=public_lookup,
            client=big_client,
        )
    assert too_big["ok"] is False
    assert too_big["error"]["code"] == "HTTP_RESPONSE_TOO_LARGE"

    with httpx.Client(
        transport=httpx.MockTransport(lambda _r: httpx.Response(200, content=b'{"score": NaN}'))
    ) as nan_client:
        bad_json = request_json(
            "https://api.example.com/nan",
            lookup_fn=public_lookup,
            client=nan_client,
        )
    assert bad_json["ok"] is False
    assert bad_json["error"]["code"] == "HTTP_INVALID_JSON"


def test_async_request_json_cancelled_half_open_probe_and_live_loopback_pinning() -> None:
    async def _run() -> None:
        now = 500.0
        breaker = create_http_circuit_breaker(failure_threshold=1, cooldown_seconds=5.0, clock_fn=lambda: now)
        key = "https://api.example.com:443"
        breaker.record_failure(key, "boom")
        assert breaker.get_state(key)["state"] == "OPEN"

        # Advance into HALF_OPEN and cancel in-flight probe mid-await
        now += 6.0
        entered_event = asyncio.Event()

        async def slow_send(*_args: Any) -> dict[str, Any]:
            entered_event.set()
            await asyncio.sleep(30.0)
            return {"status": 200, "headers": {}, "body": b'{"ok":true}'}

        task = asyncio.create_task(
            async_request_json(
                "https://api.example.com/probe",
                lookup_fn=lambda _h: ["93.184.216.34"],
                breaker=breaker,
                send_fn=slow_send,
            )
        )
        await entered_event.wait()
        # While task is in-flight, concurrent caller sees HALF_OPEN blocked
        assert breaker.can_attempt(key)["allowed"] is False

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        # Probe MUST be released cleanly so subsequent caller is NOT permanently wedged!
        recovered = await async_request_json(
            "https://api.example.com/probe",
            lookup_fn=lambda _h: ["93.184.216.34"],
            breaker=breaker,
            send_fn=lambda *_a: {"status": 200, "headers": {}, "body": b'{"recovered":true}'},
        )
        assert recovered["ok"] is True
        assert recovered["data"]["body"] == {"recovered": True}
        assert breaker.get_state(key)["state"] == "CLOSED"

    asyncio.run(_run())

    # Live loopback HTTPServer roundtrip exercising default lazy httpx + connect-time IP pinning
    class _LoopbackHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            payload = json.dumps({"host_header": self.headers.get("Host"), "status": "live"}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    server = HTTPServer(("127.0.0.1", 0), _LoopbackHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        sync_live = request_json(f"http://localhost:{port}/health", allow_loopback=True)
        assert sync_live["ok"] is True
        assert sync_live["data"]["body"]["status"] == "live"
        assert sync_live["data"]["body"]["host_header"] == f"localhost:{port}"

        async_live = asyncio.run(async_request_json(f"http://127.0.0.1:{port}/health", allow_loopback=True))
        assert async_live["ok"] is True
        assert async_live["data"]["body"]["status"] == "live"
    finally:
        server.shutdown()
        server.server_close()


# ---------------------------------------------------------------------------
# 2. krusch_toolkit.streamlit_ui Tests (INV-LEGO-22)
# ---------------------------------------------------------------------------


def test_streamlit_airgapped_css_and_auth_header_guards() -> None:
    with pytest.raises(TypeError):
        AIRGAPPED_THEME_PRESETS["sky"] = {}  # type: ignore[index]

    for accent in ("sky", "gold", "emerald", "#a855f7", "red; } body { background: url(https://evil.test) }"):
        css = build_airgapped_theme_css(accent)
        assert css.startswith("<style>") and css.endswith("</style>")
        assert "http://" not in css
        assert "https://" not in css
        assert "@import" not in css
        assert "evil.test" not in css

    custom_hex_css = build_airgapped_theme_css("#12ab34")
    assert "#12ab34" in custom_hex_css
    assert "rgba(18, 171, 52, 0.35)" in custom_hex_css

    auth_ok = build_rag_auth_headers(
        {"api_key": " key_from_state ", "tenant_id": "krusch-law"},
        bearer_token="tok_99",
    )
    assert auth_ok["ok"] is True
    assert auth_ok["data"]["headers"] == {
        "X-API-Key": "key_from_state",
        "X-Tenant-ID": "krusch-law",
        "Authorization": "Bearer tok_99",
    }

    for bad_state in (
        {"api_key": "bad\r\nheader"},
        {"tenant_id": "bad\x00null"},
        {"bearer_token": 12345},
    ):
        bad_res = build_rag_auth_headers(bad_state)
        assert bad_res["ok"] is False
        assert bad_res["error"]["code"] == "STREAMLIT_INVALID_HEADER"


def test_streamlit_citation_xss_neutralization_session_bounds_and_shell() -> None:
    class StreamlitAPIException(Exception):
        pass

    class _MockStreamlit:
        def __init__(self, *, raise_dup_config: bool = False, raise_unexpected: bool = False) -> None:
            self.session_state: dict[str, Any] = {}
            self.markdown_calls: list[tuple[str, bool]] = []
            self.page_configs: list[dict[str, Any]] = []
            self._raise_dup = raise_dup_config
            self._raise_unexpected = raise_unexpected

        def set_page_config(self, **kwargs: Any) -> None:
            if self._raise_dup:
                raise StreamlitAPIException("set_page_config() can only be called once")
            if self._raise_unexpected:
                raise RuntimeError("disk I/O boom")
            self.page_configs.append(kwargs)

        def markdown(self, body: str, *, unsafe_allow_html: bool = False) -> None:
            self.markdown_calls.append((body, unsafe_allow_html))

    citations = [
        {
            "source": '<script>alert("xss")</script>Cal. Civ. Code',
            "section": '§ 1950.5" onmouseover="evil()',
            "score": 0.942,
            "span": "Security deposit return within 21 calendar days " * 5,
            "url": "https://leginfo.legislature.ca.gov/faces/codes.xhtml",
        },
        {
            "source": "Adversarial Link",
            "confidence": 88,
            "url": "javascript:alert(document.cookie)",
        },
        {
            "source": "Data URI Payload",
            "score": True,  # bool must NOT format as 100%!
            "url": "data:text/html,<script>alert(1)</script>",
        },
    ]

    html_out = format_citation_badges_html(citations, max_span_chars=60)
    assert "<script>" not in html_out
    assert "&lt;script&gt;" in html_out
    assert "javascript:" not in html_out
    assert "data:text/html" not in html_out
    assert 'onmouseover="evil()"' not in html_out
    assert "94%" in html_out
    assert "88%" in html_out
    assert "100%" not in html_out
    assert 'target="_blank" rel="noopener noreferrer"' in html_out
    assert html_out.count("<a ") == 1
    assert html_out.count('<span class="krusch-citation-badge">') == 2

    mock_st = _MockStreamlit(raise_dup_config=True)
    badge_res = render_citation_badges(citations, st_module=mock_st)
    assert badge_res["ok"] is True
    assert badge_res["data"]["rendered_count"] == 3
    assert len(mock_st.markdown_calls) == 1

    # Shell tolerates duplicate StreamlitAPIException and escapes banner/health XSS
    shell_res = render_sovereign_rag_shell(
        title='KruschLaw <img src=x onerror=alert(1)>',
        subtitle="California Statutory Corpus",
        disclaimer="Not legal advice & confidential",
        accent="gold",
        health_status="healthy",
        max_turns=3,
        st_module=mock_st,
    )
    assert shell_res["ok"] is True
    assert "<img src=x" not in shell_res["data"]["html"]
    assert "&lt;img src=x onerror=alert(1)&gt;" in shell_res["data"]["html"]
    assert "krusch-rag-pill--healthy" in shell_res["data"]["html"]
    assert mock_st.session_state["messages"] == []

    # Unexpected runtime error in set_page_config surfaces STREAMLIT_RENDER_ERROR
    broken_st = _MockStreamlit(raise_unexpected=True)
    broken_shell = render_sovereign_rag_shell(title="KruschBiz", st_module=broken_st)
    assert broken_shell["ok"] is False
    assert broken_shell["error"]["code"] == "STREAMLIT_RENDER_ERROR"

    # Session state validation, cycle guard, and FIFO max_turns trimming
    cyclic_default: dict[str, Any] = {}
    cyclic_default["self"] = cyclic_default
    assert (
        init_rag_session_state({}, defaults={"bad": cyclic_default})["error"]["code"]
        == "STREAMLIT_INVALID_OPTIONS"
    )
    assert init_rag_session_state({}, messages_key="__proto__")["error"]["code"] == "STREAMLIT_INVALID_OPTIONS"
    assert init_rag_session_state({}, max_turns=True)["error"]["code"] == "STREAMLIT_INVALID_OPTIONS"  # type: ignore[arg-type]

    state: dict[str, Any] = {}
    assert append_rag_turn(state, "hacker", "hi")["error"]["code"] == "STREAMLIT_INVALID_ROLE"
    assert append_rag_turn(state, "user", "   ")["error"]["code"] == "STREAMLIT_EMPTY_CONTENT"

    for idx in range(5):
        turn_res = append_rag_turn(
            state,
            "user" if idx % 2 == 0 else "assistant",
            f"Turn {idx}",
            citations=[{"source": "Doc", "url": "javascript:evil()"}],
            max_turns=3,
        )
        assert turn_res["ok"] is True
    assert len(state["messages"]) == 3
    assert [m["content"] for m in state["messages"]] == ["Turn 2", "Turn 3", "Turn 4"]
    assert "url" not in state["messages"][0]["citations"][0]


def test_referee_pass1_regressions_cross_origin_tls_pool_and_malformed_urls(monkeypatch: Any) -> None:
    import krusch_toolkit.http_client as hc

    # REF-02: Malformed IPv6 brackets, invalid IDNA labels, and malformed redirect Location never raise
    malformed_urls = [
        "http://[::1/api",
        "http://ex]ample.com/api",
        "https://a..b.com/api",
        f"https://{'a' * 64}.example.com/api",
        "https://.leading-dot.example.com/api",
    ]
    for bad_url in malformed_urls:
        sync_bad = request_json(bad_url, allow_loopback=True)
        assert sync_bad["ok"] is False
        assert sync_bad["error"]["code"] == "SSRF_INVALID_URL", f"Unexpected sync result for {bad_url}: {sync_bad}"

        async_bad = asyncio.run(async_request_json(bad_url, allow_loopback=True))
        assert async_bad["ok"] is False
        assert async_bad["error"]["code"] == "SSRF_INVALID_URL", f"Unexpected async result for {bad_url}: {async_bad}"

    # Malformed redirect Location header with unclosed IPv6 bracket returns SSRF_INVALID_URL cleanly
    bad_redir_sync = request_json(
        "https://origin-a.example.com/start",
        lookup_fn=lambda _h: ["93.184.216.34"],
        send_fn=lambda *_a: {"status": 302, "headers": {"Location": "http://[::1/broken"}, "body": b""},
    )
    assert bad_redir_sync["ok"] is False
    assert bad_redir_sync["error"]["code"] == "SSRF_INVALID_URL"

    bad_redir_async = asyncio.run(
        async_request_json(
            "https://origin-a.example.com/start",
            lookup_fn=lambda _h: ["93.184.216.34"],
            send_fn=lambda *_a: {"status": 302, "headers": {"Location": "http://[::1/broken"}, "body": b""},
        )
    )
    assert bad_redir_async["ok"] is False
    assert bad_redir_async["error"]["code"] == "SSRF_INVALID_URL"

    # REF-01: Default owned_client MUST close & recreate across cross-origin redirects sharing a pinned IP
    # so httpcore never reuses Hop 1's TLS stream with stale SNI / skipped cert verification on Hop 2,
    # while preserving keep-alive reuse for same-origin redirects!
    created_sync_clients: list[Any] = []
    created_async_clients: list[Any] = []

    class _FakeStreamResp:
        def __init__(self, status_code: int, headers: dict[str, str], body: bytes) -> None:
            self.status_code = status_code
            self.headers = headers
            self._body = body

        def __enter__(self) -> _FakeStreamResp:
            return self

        def __exit__(self, *_exc: Any) -> None:
            return None

        def iter_bytes(self, _chunk_size: int | None = None) -> Any:
            if self._body:
                yield self._body

        async def __aenter__(self) -> _FakeStreamResp:
            return self

        async def __aexit__(self, *_exc: Any) -> None:
            return None

        async def aiter_bytes(self, _chunk_size: int | None = None) -> Any:
            if self._body:
                yield self._body

    class _FakeSyncClient:
        def __init__(self, **kwargs: Any) -> None:
            self.kwargs = kwargs
            self.closed = False
            self.calls: list[tuple[str, dict[str, str], Any]] = []
            created_sync_clients.append(self)

        def stream(
            self,
            _method: str,
            url: str,
            *,
            headers: dict[str, str],
            content: Any = None,
            timeout: Any = None,
            extensions: Any = None,
            **_extra: Any,
        ) -> _FakeStreamResp:
            _ = (content, timeout, _extra)
            self.calls.append((url, dict(headers), extensions))
            host_hdr = headers.get("Host", "")
            if host_hdr == "host-a.example.com" and url.endswith("/cross"):
                return _FakeStreamResp(302, {"Location": "https://host-b.example.com/final"}, b"")
            if host_hdr == "host-a.example.com" and url.endswith("/same"):
                return _FakeStreamResp(302, {"Location": "https://host-a.example.com/done"}, b"")
            return _FakeStreamResp(200, {"Content-Type": "application/json"}, b'{"verified":true}')

        def close(self) -> None:
            self.closed = True

    class _FakeAsyncClient(_FakeSyncClient):
        def __init__(self, **kwargs: Any) -> None:
            self.kwargs = kwargs
            self.closed = False
            self.calls = []
            created_async_clients.append(self)

        async def aclose(self) -> None:
            self.closed = True

    class _FakeHttpxMod:
        Client = _FakeSyncClient
        AsyncClient = _FakeAsyncClient

    monkeypatch.setattr(hc, "_load_httpx", lambda: _FakeHttpxMod)

    # Cross-origin redirect sharing identical pinned IP 93.184.216.34 -> 2 distinct clients, both closed!
    cross_sync = request_json(
        "https://host-a.example.com/cross",
        lookup_fn=lambda _h: ["93.184.216.34"],
    )
    assert cross_sync["ok"] is True
    assert len(created_sync_clients) == 2
    assert created_sync_clients[0].closed is True
    assert created_sync_clients[1].closed is True
    assert created_sync_clients[0].calls[0][2] == {"sni_hostname": "host-a.example.com"}
    assert created_sync_clients[1].calls[0][2] == {"sni_hostname": "host-b.example.com"}

    # Same-origin redirect -> reuses single client!
    created_sync_clients.clear()
    same_sync = request_json(
        "https://host-a.example.com/same",
        lookup_fn=lambda _h: ["93.184.216.34"],
    )
    assert same_sync["ok"] is True
    assert len(created_sync_clients) == 1
    assert created_sync_clients[0].closed is True
    assert len(created_sync_clients[0].calls) == 2

    # Async cross-origin redirect sharing identical pinned IP -> 2 distinct AsyncClients, both aclosed!
    cross_async = asyncio.run(
        async_request_json(
            "https://host-a.example.com/cross",
            lookup_fn=lambda _h: ["93.184.216.34"],
        )
    )
    assert cross_async["ok"] is True
    assert len(created_async_clients) == 2
    assert created_async_clients[0].closed is True
    assert created_async_clients[1].closed is True
    assert created_async_clients[0].calls[0][2] == {"sni_hostname": "host-a.example.com"}
    assert created_async_clients[1].calls[0][2] == {"sni_hostname": "host-b.example.com"}


def test_referee_pass3_regressions_unicode_idna_ssrf_and_huge_int_overflow() -> None:
    import httpx

    # REF-P3-01a: Unicode IDNA separators & fullwidth homographs MUST NOT bypass SSRF host/IP blocklists
    unicode_ssrf_urls = [
        "http://metadata\u3002google\u3002internal/computeMetadata/v1/",
        "http://\uff4d\uff45\uff54\uff41\uff44\uff41\uff54\uff41.google.internal/computeMetadata/v1/",
        "http://\uff4c\uff4f\uff43\uff41\uff4c\uff48\uff4f\uff53\uff54:8080/admin",
        "http://sub\u3002localhost/admin",
        "http://127\u30020\u30020\u30021:8080/health",
        "http://\uff11\uff12\uff17\u3002\uff10\u3002\uff10\u3002\uff11:8080/health",
        "http://0177\u30020\u30020\u30021/health",
    ]
    for evil_url in unicode_ssrf_urls:
        blocked_sync = request_json(
            evil_url,
            allow_private_lan=True,
            allow_tailscale=True,
            allow_loopback=True,
            lookup_fn=lambda _h: ["93.184.216.34"],
            send_fn=lambda *_a: {"status": 200, "headers": {}, "body": b'{"ok":true}'},
        )
        assert blocked_sync["ok"] is False, f"Unicode SSRF URL bypassed sync guard: {evil_url}"
        assert blocked_sync["error"]["code"] == "SSRF_PRIVATE_IP"

        blocked_async = asyncio.run(
            async_request_json(
                evil_url,
                allow_private_lan=True,
                allow_tailscale=True,
                allow_loopback=True,
                lookup_fn=lambda _h: ["93.184.216.34"],
                send_fn=lambda *_a: {"status": 200, "headers": {}, "body": b'{"ok":true}'},
            )
        )
        assert blocked_async["ok"] is False, f"Unicode SSRF URL bypassed async guard: {evil_url}"
        assert blocked_async["error"]["code"] == "SSRF_PRIVATE_IP"

    # REF-P3-01b: Legitimate IDN domain canonicalizes to ASCII punycode for DNS, allowed_hosts, and httpx.Headers!
    seen_wire_headers: list[httpx.Headers] = []
    seen_lookup_hosts: list[str] = []

    def check_ascii_headers(_method: str, _url: str, hdrs: dict[str, str], *_rest: Any) -> dict[str, Any]:
        # httpx.Headers strictly enforces ASCII header values and raises UnicodeEncodeError on raw UTF-8!
        seen_wire_headers.append(httpx.Headers(hdrs))
        return {"status": 200, "headers": {"Content-Type": "application/json"}, "body": b'{"idn":true}'}

    from krusch_toolkit.http_client import _build_hop_wire_target

    idn_res = request_json(
        "https://b\u00fccher.example.com:8443/catalog?q=1",
        allowed_hosts=["b\u00fccher.example.com"],
        lookup_fn=lambda h: (seen_lookup_hosts.append(h) or ["93.184.216.34"]),
        send_fn=check_ascii_headers,
    )
    assert idn_res["ok"] is True
    assert seen_lookup_hosts == ["xn--bcher-kva.example.com"]
    assert len(seen_wire_headers) == 1

    # Verify DNS-pinned wire target emits strictly ASCII Host header accepted by httpx.Headers
    pinned_url, pinned_hdrs, pinned_ext = _build_hop_wire_target(
        {
            "url": "https://xn--bcher-kva.example.com:8443/catalog?q=1",
            "scheme": "https",
            "hostname": "xn--bcher-kva.example.com",
            "port": 8443,
            "explicit_port": 8443,
            "resolved_addresses": ["93.184.216.34"],
        },
        {},
        use_dns_pinning=True,
    )
    assert pinned_url == "https://93.184.216.34:8443/catalog?q=1"
    validated_httpx_headers = httpx.Headers(pinned_hdrs)
    assert validated_httpx_headers["host"] == "xn--bcher-kva.example.com:8443"
    assert pinned_ext == {"sni_hostname": "xn--bcher-kva.example.com"}

    # REF-P3-02: Huge Python ints (>= 2**1024) never raise OverflowError in float() conversions
    huge_int = 10**400
    b = HttpCircuitBreaker(failure_threshold=huge_int, cooldown_seconds=huge_int, max_hosts=huge_int)
    assert b.failure_threshold == 3
    assert b.cooldown_seconds == 30.0
    assert b.max_hosts == 64

    assert compute_retry_delay(huge_int, base_delay=huge_int, max_delay=huge_int) >= 0.0

    sync_huge = request_json("https://api.example.com/v1", timeout_seconds=huge_int)
    assert sync_huge["ok"] is False
    assert sync_huge["error"]["code"] == "HTTP_INVALID_OPTIONS"

    async_huge = asyncio.run(async_request_json("https://api.example.com/v1", base_delay=huge_int))
    assert async_huge["ok"] is False
    assert async_huge["error"]["code"] == "HTTP_INVALID_OPTIONS"


