"""
krusch_toolkit — Shared Python utilities for homelab projects.

Usage:
    from krusch_toolkit.ai import chat, chat_json, select_model
    from krusch_toolkit.config import load_project_config, env_or, safe_int
    from krusch_toolkit.config import get_redis_connection, validate_config
    from krusch_toolkit.db import create_session_factory
    from krusch_toolkit.log import setup_logging
    from krusch_toolkit.system import get_liquid_temp, check_thermal_safety
    from krusch_toolkit.auth import create_flask_auth
    from krusch_toolkit.reasoning import analyze, pulse
"""

import contextlib

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
from krusch_toolkit.decide import (
    System1Decider,
    calibrate_choice_logprobs,
    decide,
    decide_batch,
    evaluate_deterministic_decision,
)
from krusch_toolkit.embeddings import (
    DEFAULT_EMBED_DIMS,
    DEFAULT_EMBED_HOST,
    DEFAULT_EMBED_MODEL,
    MODEL_PROFILES,
    calculate_centroid,
    calibrate_query_similarity,
    chunk_text_for_embedding,
    clear_embedding_cache,
    cosine_similarity,
    deterministic_token_vector,
    embed_batch,
    embed_chunked_centroid,
    embed_text,
    format_embedding_input,
    is_zero_vector,
    l2_normalize,
    resolve_embedding_profile,
    validate_vector_dimension,
)
from krusch_toolkit.fastapi_app import (
    create_fastapi_app,
    error_envelope,
    format_sse_frame,
    ok_envelope,
    sse_event_response,
)
from krusch_toolkit.http_client import (
    HttpCircuitBreaker,
    async_request_json,
    build_resilient_headers,
    compute_retry_delay,
    create_http_circuit_breaker,
    request_json,
)
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
from krusch_toolkit.raw_rag import (
    LEGAL_BOILERPLATE_STOPWORDS,
    QWEN_RERANKER_TEMPLATE,
    RAG_BASELINE_CONSTRAINTS,
    RAW_RAG_DEFAULTS,
    RawRagIndex,
    assemble_reader_evidence,
    audit_mutation_stream,
    audit_rag_baseline_config,
    build_qwen_reranker_prompt,
    chunk_conversation_windows,
    create_raw_rag_index,
    estimate_token_count,
    evaluate_conditional_path_retention,
    evaluate_coverage_and_utilization,
    normalize_append_only_write_op,
    rerank_candidate_windows,
    score_deterministic_cross_encoder,
    serialize_conversation_turn,
    should_narrow_candidate_sub_span,
    tokenize_with_offsets,
)
from krusch_toolkit.schema import (
    validate_json_schema,
    validate_payload,
)
from krusch_toolkit.security import (
    constant_time_equal,
    is_private_or_reserved_ip,
    validate_outbound_url,
    verify_bearer_token,
    verify_webhook_hmac,
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
from krusch_toolkit.upload import (
    read_bounded_upload,
    sanitize_upload_filename,
    sniff_mime_magic,
    verify_upload_mime,
)
from krusch_toolkit.yaml_loader import (
    DEFAULT_YAML_LIMITS,
    dump_safe_yaml,
    load_safe_yaml_pack,
    parse_safe_yaml,
    validate_yaml_config,
)

__version__ = "1.6.0"

# Core exports (always available; gracefully degrade if optional dotenv/requests not installed)
with contextlib.suppress(ImportError):
    from krusch_toolkit.ai import chat, chat_json, chat_sync, parse_ai_json, select_model

with contextlib.suppress(ImportError):
    from krusch_toolkit.config import (
        env_bool,
        env_int,
        env_or,
        get_redis_connection,
        load_project_config,
        safe_int,
        validate_config,
        validate_required,
    )

with contextlib.suppress(ImportError):
    from krusch_toolkit.log import setup_logging

# Heavy imports (require psycopg2 / Flask / Torch) — import from submodules directly:
#   from krusch_toolkit.db import create_engine_from_config, create_session_factory
#   from krusch_toolkit.auth import create_flask_auth, require_subscription
#   from krusch_toolkit.reasoning import analyze, pulse

__all__ = [
    "__version__",
    # FastAPI & universal envelope Lego bricks
    "ok_envelope",
    "error_envelope",
    "format_sse_frame",
    "create_fastapi_app",
    "sse_event_response",
    # Wave 3, Wave 4, Wave 5 & Wave 6 Python Lego bricks
    "define_mcp_tool",
    "ok_mcp_result",
    "error_mcp_result",
    "validate_tool_args",
    "dispatch_mcp_tool",
    "assert_safe_pg_identifier",
    "build_pg_connection_string",
    "format_pgvector_literal",
    "run_sql_migrations",
    "pg_vector_search",
    "constant_time_equal",
    "verify_webhook_hmac",
    "verify_bearer_token",
    "is_private_or_reserved_ip",
    "validate_outbound_url",
    "validate_json_schema",
    "validate_payload",
    "sanitize_upload_filename",
    "sniff_mime_magic",
    "verify_upload_mime",
    "read_bounded_upload",
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
    # Optional runtime helpers (when optional deps installed)
    "chat",
    "chat_json",
    "chat_sync",
    "parse_ai_json",
    "select_model",
    "load_project_config",
    "env_or",
    "env_int",
    "env_bool",
    "validate_required",
    "safe_int",
    "get_redis_connection",
    "validate_config",
    "setup_logging",
    # System-1 single-token logprob router
    "decide",
    "decide_batch",
    "calibrate_choice_logprobs",
    "evaluate_deterministic_decision",
    "System1Decider",
    # Sovereign embeddings
    "DEFAULT_EMBED_HOST",
    "DEFAULT_EMBED_MODEL",
    "DEFAULT_EMBED_DIMS",
    "MODEL_PROFILES",
    "resolve_embedding_profile",
    "format_embedding_input",
    "l2_normalize",
    "is_zero_vector",
    "cosine_similarity",
    "calibrate_query_similarity",
    "calculate_centroid",
    "validate_vector_dimension",
    "deterministic_token_vector",
    "chunk_text_for_embedding",
    "clear_embedding_cache",
    "embed_batch",
    "embed_text",
    "embed_chunked_centroid",
    # Source-preserving Raw-RAG (arXiv:2610.30755)
    "RAW_RAG_DEFAULTS",
    "RAG_BASELINE_CONSTRAINTS",
    "QWEN_RERANKER_TEMPLATE",
    "LEGAL_BOILERPLATE_STOPWORDS",
    "tokenize_with_offsets",
    "estimate_token_count",
    "serialize_conversation_turn",
    "chunk_conversation_windows",
    "audit_rag_baseline_config",
    "normalize_append_only_write_op",
    "audit_mutation_stream",
    "build_qwen_reranker_prompt",
    "should_narrow_candidate_sub_span",
    "score_deterministic_cross_encoder",
    "rerank_candidate_windows",
    "assemble_reader_evidence",
    "evaluate_coverage_and_utilization",
    "evaluate_conditional_path_retention",
    "RawRagIndex",
    "create_raw_rag_index",
]


