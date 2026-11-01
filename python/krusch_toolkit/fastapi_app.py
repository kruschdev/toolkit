"""
FastAPI Lego Bricks — deterministic envelopes, middleware, health/doctor probes, and SSE streaming.

Designed for zero-dependency import safety: `ok_envelope`, `error_envelope`, and
`format_sse_frame` work in bare Python 3.11+ even when `fastapi` / `starlette`
are not installed. `create_fastapi_app` and `sse_event_response` lazily import
FastAPI and raise a descriptive `RuntimeError` if missing.
"""

from __future__ import annotations

import inspect
import json
import logging
import re
import time
import uuid
from collections.abc import AsyncIterable, AsyncIterator, Callable, Iterable
from contextlib import aclosing, asynccontextmanager
from typing import Any

__all__ = [
    "ok_envelope",
    "error_envelope",
    "format_sse_frame",
    "create_fastapi_app",
    "sse_event_response",
]

_HTTP_STATUS_CODES: dict[int, str] = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    408: "REQUEST_TIMEOUT",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    422: "VALIDATION_ERROR",
    423: "LOCKED",
    424: "FAILED_DEPENDENCY",
    429: "RATE_LIMITED",
    500: "INTERNAL_ERROR",
    502: "BAD_GATEWAY",
    503: "SERVICE_UNAVAILABLE",
    504: "GATEWAY_TIMEOUT",
}


def ok_envelope(tool: str, summary: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    """Build a deterministic INV-LEGO-01 success envelope."""
    return {
        "ok": True,
        "tool": str(tool or "fastapi"),
        "summary": str(summary or "OK"),
        "data": {} if data is None else data,
    }


def error_envelope(
    code: str,
    message: str,
    details: Any = None,
    tool: str = "fastapi",
) -> dict[str, Any]:
    """Build a deterministic INV-LEGO-01 error envelope."""
    resolved_code = str(code or "INTERNAL_ERROR")
    resolved_message = str(message or "Request failed")
    return {
        "ok": False,
        "tool": str(tool or "fastapi"),
        "summary": str(message or code or "Request failed"),
        "error": {
            "code": resolved_code,
            "message": resolved_message,
            **({"details": details} if details is not None else {}),
        },
    }


def format_sse_frame(event: str, data: Any) -> str:
    """Serialize dicts/lists via JSON and multi-line strings into a valid SSE frame."""
    clean_event = str(event or "message").replace("\r", "").replace("\n", "").strip() or "message"
    raw_text = data if isinstance(data, str) else json.dumps(data, default=str)
    normalized = raw_text.replace("\r\n", "\n").replace("\r", "\n")
    data_lines = "\n".join(f"data: {line}" for line in normalized.split("\n"))
    return f"event: {clean_event}\n{data_lines}\n\n"


def _load_fastapi(caller: str) -> dict[str, Any]:
    """Lazily import FastAPI and Starlette components, raising RuntimeError if unavailable."""
    try:
        import fastapi
        import starlette

        if fastapi is None or starlette is None:  # pragma: no cover - defensive guard
            raise ModuleNotFoundError("FastAPI or Starlette module is disabled")

        from fastapi import FastAPI, Request
        from fastapi.encoders import jsonable_encoder
        from fastapi.exceptions import RequestValidationError
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import JSONResponse, StreamingResponse
        from starlette.exceptions import HTTPException as StarletteHTTPException
    except ImportError as exc:
        raise RuntimeError(
            f"FastAPI is required for {caller}; install krusch-toolkit[fastapi]"
        ) from exc

    return {
        "FastAPI": FastAPI,
        "Request": Request,
        "jsonable_encoder": jsonable_encoder,
        "RequestValidationError": RequestValidationError,
        "CORSMiddleware": CORSMiddleware,
        "JSONResponse": JSONResponse,
        "StreamingResponse": StreamingResponse,
        "StarletteHTTPException": StarletteHTTPException,
    }


def _resolve_service_name(title: str, service_name: str | None) -> str:
    if service_name and service_name.strip():
        return service_name.strip()
    slug = re.sub(r"[^a-z0-9]+", "-", (title or "krusch-service").lower()).strip("-")
    return slug or "krusch-service"


def _sanitize_header_token(raw: str | None) -> str:
    if not raw:
        return ""
    return raw.replace("\r", "").replace("\n", "").strip()


def _normalize_allowed_origins(cors_origins: list[str] | None) -> list[str]:
    if cors_origins is None:
        return ["*"]
    cleaned: list[str] = []
    for raw in cors_origins:
        if not isinstance(raw, str):
            continue
        if "\r" in raw or "\n" in raw:
            continue
        token = raw.strip()
        if not token or token.lower() in ("null", "false"):
            continue
        cleaned.append(token)
    return cleaned


def _accepts_positional_arg(fn: Callable[..., Any]) -> bool:
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return False
    return any(
        param.kind
        in (
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.VAR_POSITIONAL,
        )
        for param in sig.parameters.values()
    )


def _attach_cors_fallback_headers(
    request: Any,
    response: Any,
    resolved_origins: list[str],
    allow_credentials: bool,
) -> None:
    if not resolved_origins:
        return
    if "access-control-allow-origin" in response.headers:
        return

    if "*" in resolved_origins:
        response.headers["Access-Control-Allow-Origin"] = "*"
        return

    existing_vary = response.headers.get("vary", "")
    vary_tokens = [v.strip().lower() for v in existing_vary.split(",") if v.strip()]
    if "origin" not in vary_tokens:
        response.headers["Vary"] = f"{existing_vary}, Origin" if existing_vary else "Origin"

    raw_origin = request.headers.get("origin")
    if not isinstance(raw_origin, str) or "\r" in raw_origin or "\n" in raw_origin:
        return
    clean_origin = raw_origin.strip()
    if not clean_origin or clean_origin.lower() in ("null", "false"):
        return
    if clean_origin in resolved_origins:
        response.headers["Access-Control-Allow-Origin"] = clean_origin
        if allow_credentials:
            response.headers["Access-Control-Allow-Credentials"] = "true"


def _attach_standard_headers(request: Any, response: Any) -> None:
    state = getattr(request, "state", None)
    request_id = getattr(state, "request_id", None)
    if not request_id:
        incoming = _sanitize_header_token(request.headers.get("x-request-id"))
        request_id = incoming or str(uuid.uuid4())
        if state is not None:
            state.request_id = request_id

    start_time = getattr(state, "request_start_time", None)
    elapsed_ms = max(0.0, (time.perf_counter() - start_time) * 1000.0) if start_time is not None else 0.0

    response.headers["X-Request-ID"] = str(request_id)
    response.headers["X-Response-Time-Ms"] = f"{elapsed_ms:.2f}"
    response.headers["X-Content-Type-Options"] = "nosniff"


def create_fastapi_app(
    title: str = "Krusch Service",
    version: str = "1.0.0",
    *,
    description: str = "",
    docs_url: str | None = "/docs",
    redoc_url: str | None = "/redoc",
    service_name: str | None = None,
    cors_origins: list[str] | None = None,
    allow_credentials: bool | None = None,
    lifespan: Callable[[Any], Any] | None = None,
    health_check: Callable[..., Any] | None = None,
    flatten_health_payload: bool = False,
    legacy_error_detail: bool = False,
    startup_hooks: list[Callable[[], Any]] | None = None,
    shutdown_hooks: list[Callable[[], Any]] | None = None,
    logger: Any = None,
) -> Any:
    """Create a production-hardened FastAPI application with INV-LEGO-01 envelopes."""
    deps = _load_fastapi("create_fastapi_app")
    FastAPI = deps["FastAPI"]
    Request = deps["Request"]
    CORSMiddleware = deps["CORSMiddleware"]
    JSONResponse = deps["JSONResponse"]
    RequestValidationError = deps["RequestValidationError"]
    StarletteHTTPException = deps["StarletteHTTPException"]
    jsonable_encoder = deps["jsonable_encoder"]

    resolved_name = _resolve_service_name(title, service_name)
    active_logger = logger or logging.getLogger(resolved_name)
    start_list = list(startup_hooks or [])
    stop_list = list(shutdown_hooks or [])
    custom_lifespan = lifespan

    @asynccontextmanager
    async def _composed_lifespan(app_instance: Any) -> AsyncIterator[None]:
        primary_exc: BaseException | None = None
        try:
            for hook in start_list:
                maybe_awaitable = hook()
                if inspect.isawaitable(maybe_awaitable):
                    await maybe_awaitable
            if custom_lifespan is not None:
                async with custom_lifespan(app_instance):
                    yield
            else:
                yield
        except BaseException as exc:
            primary_exc = exc
            raise
        finally:
            first_error: Exception | None = None
            for hook in stop_list:
                try:
                    maybe_awaitable = hook()
                    if inspect.isawaitable(maybe_awaitable):
                        await maybe_awaitable
                except Exception as exc:
                    active_logger.exception("Shutdown hook failed in %s", resolved_name)
                    if first_error is None:
                        first_error = exc
            if first_error is not None and primary_exc is None:
                raise first_error

    app = FastAPI(
        title=title,
        description=description,
        version=version,
        docs_url=docs_url,
        redoc_url=redoc_url,
        lifespan=_composed_lifespan,
    )

    resolved_origins = _normalize_allowed_origins(cors_origins)
    safe_for_credentials = len(resolved_origins) > 0 and "*" not in resolved_origins
    resolved_allow_credentials = (
        safe_for_credentials
        if allow_credentials is None
        else (bool(allow_credentials) and safe_for_credentials)
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_origins,
        allow_credentials=resolved_allow_credentials,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def _request_context_middleware(request: Any, call_next: Callable[[Any], Any]) -> Any:
        incoming_id = _sanitize_header_token(request.headers.get("x-request-id"))
        request.state.request_id = incoming_id or str(uuid.uuid4())
        request.state.request_start_time = time.perf_counter()
        response = await call_next(request)
        _attach_standard_headers(request, response)
        return response

    @app.exception_handler(StarletteHTTPException)
    async def _http_exception_handler(request: Any, exc: Any) -> Any:
        status_code = int(getattr(exc, "status_code", 500) or 500)
        code = _HTTP_STATUS_CODES.get(status_code, f"HTTP_{status_code}")
        raw_detail = getattr(exc, "detail", None)
        details: Any = None
        if isinstance(raw_detail, str):
            message = raw_detail
        elif isinstance(raw_detail, dict):
            code = str(raw_detail.get("code") or code)
            message = str(raw_detail.get("message") or raw_detail.get("detail") or f"HTTP {status_code}")
            details = raw_detail.get("details", raw_detail)
        elif raw_detail is not None:
            message = f"HTTP {status_code}"
            details = jsonable_encoder(raw_detail)
        else:
            message = f"HTTP {status_code}"

        exc_headers = dict(getattr(exc, "headers", None) or {})
        err_content = error_envelope(code, message, details=details, tool=resolved_name)
        if legacy_error_detail:
            err_content["detail"] = jsonable_encoder(raw_detail) if raw_detail is not None else message
        response = JSONResponse(
            status_code=status_code,
            content=err_content,
            headers=exc_headers,
        )
        _attach_standard_headers(request, response)
        _attach_cors_fallback_headers(request, response, resolved_origins, resolved_allow_credentials)
        return response

    @app.exception_handler(RequestValidationError)
    async def _validation_exception_handler(request: Any, exc: Any) -> Any:
        encoded_errors = jsonable_encoder(exc.errors())
        err_content = error_envelope(
            "VALIDATION_ERROR",
            "Request validation failed",
            details=encoded_errors,
            tool=resolved_name,
        )
        if legacy_error_detail:
            err_content["detail"] = encoded_errors
        response = JSONResponse(
            status_code=422,
            content=err_content,
        )
        _attach_standard_headers(request, response)
        _attach_cors_fallback_headers(request, response, resolved_origins, resolved_allow_credentials)
        return response

    @app.exception_handler(Exception)
    async def _unhandled_exception_handler(request: Any, _exc: Exception) -> Any:
        active_logger.exception(
            "Unhandled exception in %s on %s %s",
            resolved_name,
            getattr(request, "method", "UNKNOWN"),
            getattr(getattr(request, "url", None), "path", "/"),
        )
        response = JSONResponse(
            status_code=500,
            content=error_envelope("INTERNAL_ERROR", "Internal server error", tool=resolved_name),
        )
        _attach_standard_headers(request, response)
        _attach_cors_fallback_headers(request, response, resolved_origins, resolved_allow_credentials)
        return response

    health_accepts_request = _accepts_positional_arg(health_check) if health_check is not None else False

    async def _evaluate_health(request: Any, *, flatten: bool) -> Any:
        extra: Any = None
        if health_check is not None:
            try:
                extra = health_check(request) if health_accepts_request else health_check()
                if inspect.isawaitable(extra):
                    extra = await extra
            except Exception as exc:
                active_logger.warning("Health check failed in %s: %s", resolved_name, exc)
                msg = str(exc) or "Service unhealthy"
                err_body = error_envelope("UNHEALTHY", msg, tool=resolved_name)
                if legacy_error_detail:
                    err_body["detail"] = msg
                return JSONResponse(status_code=503, content=err_body)

            if extra is False or (isinstance(extra, dict) and extra.get("ok") is False):
                msg = (
                    str(extra.get("summary") or extra.get("message") or "Service unhealthy")
                    if isinstance(extra, dict)
                    else "Service unhealthy"
                )
                details = extra if isinstance(extra, dict) else None
                err_body = error_envelope("UNHEALTHY", msg, details=details, tool=resolved_name)
                if legacy_error_detail:
                    err_body["detail"] = msg
                return JSONResponse(status_code=503, content=err_body)

        payload = {
            "service": resolved_name,
            "version": version,
            **(extra if isinstance(extra, dict) else {}),
        }
        env = ok_envelope(resolved_name, "Service healthy", payload)
        body = {**payload, **env} if flatten else env
        return JSONResponse(status_code=200, content=body)

    async def _probe_health(request: Any) -> Any:
        return await _evaluate_health(request, flatten=bool(flatten_health_payload))

    async def _probe_doctor(request: Any) -> Any:
        return await _evaluate_health(request, flatten=False)

    _probe_health.__annotations__ = {"request": Request, "return": Any}
    _probe_doctor.__annotations__ = {"request": Request, "return": Any}

    app.add_api_route("/health", _probe_health, methods=["GET"], tags=["ops"])
    app.add_api_route("/doctor", _probe_doctor, methods=["GET"], tags=["ops"])

    return app


async def _is_request_disconnected(request: Any) -> bool:
    if request is None:
        return False
    checker = getattr(request, "is_disconnected", None)
    if not callable(checker):
        return False
    result = checker()
    if inspect.isawaitable(result):
        return bool(await result)
    return bool(result)


async def _iterate_sse_source(source: AsyncIterable[Any] | Iterable[Any]) -> AsyncIterator[Any]:
    if isinstance(source, AsyncIterable) or hasattr(source, "__aiter__"):
        aiter = source.__aiter__()  # type: ignore[union-attr]
        aclose = getattr(aiter, "aclose", None)
        try:
            async for item in aiter:
                yield item
        finally:
            if callable(aclose):
                close_res = aclose()
                if inspect.isawaitable(close_res):
                    await close_res
            if source is not aiter:
                await _close_sse_source(source)
    else:
        it = iter(source)  # type: ignore[arg-type]
        close_fn = getattr(it, "close", None)
        try:
            for item in it:
                yield item
        finally:
            if callable(close_fn):
                close_fn()
            if source is not it:
                src_close = getattr(source, "close", None)
                if callable(src_close):
                    src_close()


async def _close_sse_source(source: Any) -> None:
    aclose = getattr(source, "aclose", None)
    if callable(aclose):
        close_res = aclose()
        if inspect.isawaitable(close_res):
            await close_res
        return
    close_fn = getattr(source, "close", None)
    if callable(close_fn):
        close_fn()


def sse_event_response(
    event_generator: AsyncIterable[Any] | Iterable[Any],
    request: Any = None,
    *,
    default_event: str = "token",
    heartbeat_comment: str | None = "ping",
    passthrough: bool = False,
) -> Any:
    """Wrap a sync or async iterable into an INV-LEGO-03 disconnect-aware SSE StreamingResponse."""
    deps = _load_fastapi("sse_event_response")
    StreamingResponse = deps["StreamingResponse"]
    clean_hb = _sanitize_header_token(heartbeat_comment) if heartbeat_comment else ""

    async def _stream() -> AsyncIterator[str | bytes]:
        emitted_done = False
        disconnected = False
        entered_source = False
        try:
            if await _is_request_disconnected(request):
                return

            if clean_hb:
                yield f": {clean_hb}\n\n"

            entered_source = True
            async with aclosing(_iterate_sse_source(event_generator)) as source_iter:
                async for item in source_iter:
                    if await _is_request_disconnected(request):
                        disconnected = True
                        break

                    if passthrough:
                        if isinstance(item, (str, bytes)):
                            yield item
                        elif isinstance(item, (bytearray, memoryview)):
                            yield bytes(item)
                        else:
                            yield str(item)
                    elif isinstance(item, tuple) and len(item) == 2:
                        ev_name, payload = item
                        if str(ev_name) == "done":
                            emitted_done = True
                        yield format_sse_frame(str(ev_name), payload)
                    elif isinstance(item, dict) and "event" in item and "data" in item:
                        ev_name = str(item["event"])
                        if ev_name == "done":
                            emitted_done = True
                        yield format_sse_frame(ev_name, item["data"])
                    else:
                        yield format_sse_frame(default_event, {"delta": str(item)})

                    if await _is_request_disconnected(request):
                        disconnected = True
                        break

            if not passthrough and not disconnected and not emitted_done:
                yield format_sse_frame("done", ok_envelope("sse", "Stream complete", {}))
        except Exception as exc:
            if passthrough:
                err_payload = json.dumps(error_envelope("STREAM_ERROR", str(exc)), ensure_ascii=False)
                yield f"data: {err_payload}\n\n"
            else:
                yield format_sse_frame("error", error_envelope("STREAM_ERROR", str(exc)))
        finally:
            if not entered_source:
                await _close_sse_source(event_generator)

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

