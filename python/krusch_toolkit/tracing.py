import os
import json
import uuid
import logging
import tempfile
from datetime import datetime, timezone
from typing import Any, Dict, Optional

TRACE_FILE = os.environ.get("HALO_TRACES_PATH", os.path.join(tempfile.gettempdir(), "krusch-toolkit-traces", "traces.jsonl"))

logger = logging.getLogger(__name__)

def _ensure_trace_dir():
    dir_name = os.path.dirname(TRACE_FILE)
    if dir_name and not os.path.exists(dir_name):
        os.makedirs(dir_name, exist_ok=True)

def _get_iso_timestamp() -> str:
    dt = datetime.now(timezone.utc)
    # Output in nanosecond precision format ending in Z
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond:06d}000Z"

class SpanContext:
    def __init__(self, trace_id: str, span_id: str):
        self.trace_id = trace_id
        self.span_id = span_id

def start_span(span_type: str, name: str, parent_context: Optional[SpanContext] = None) -> Dict[str, Any]:
    trace_id = parent_context.trace_id if parent_context else uuid.uuid4().hex
    span_id = uuid.uuid4().hex[:16]
    parent_span_id = parent_context.span_id if parent_context else ""
    
    return {
        "trace_id": trace_id,
        "span_id": span_id,
        "parent_span_id": parent_span_id,
        "name": f"{span_type}.{name}",
        "kind": "SPAN_KIND_CLIENT" if span_type == "generation" else "SPAN_KIND_INTERNAL",
        "start_time": _get_iso_timestamp(),
        "span_type": span_type
    }

def end_span(span: Dict[str, Any], attributes: Dict[str, Any] = None, error: Exception = None):
    try:
        _ensure_trace_dir()
    except Exception as e:
        logger.error(f"Failed to create trace dir: {e}")
        return

    span["end_time"] = _get_iso_timestamp()
    attributes = attributes or {}
    
    status = {"code": "STATUS_CODE_OK", "message": ""}
    if error:
        status = {"code": "STATUS_CODE_ERROR", "message": str(error)}

    base_attributes = {
        "inference.export.schema_version": 1,
        "inference.project_id": os.environ.get("HALO_PROJECT_ID", "krusch-toolkit"),
        "inference.observation_kind": "LLM" if span["span_type"] == "generation" else ("TOOL" if span["span_type"] == "function" else "SPAN")
    }
    
    final_attributes = {**base_attributes, **attributes}

    otlp_line = {
        "trace_id": span["trace_id"],
        "span_id": span["span_id"],
        "parent_span_id": span["parent_span_id"],
        "trace_state": "",
        "name": span["name"],
        "kind": span["kind"],
        "start_time": span["start_time"],
        "end_time": span["end_time"],
        "status": status,
        "resource": {"attributes": {"service.name": os.environ.get("HALO_SERVICE_NAME", "krusch-agent-py")}},
        "scope": {"name": "krusch-tracing-py", "version": "1.0.0"},
        "attributes": final_attributes
    }

    try:
        with open(TRACE_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(otlp_line, ensure_ascii=False, separators=(',', ':')) + "\n")
    except Exception as e:
        logger.error(f"Failed to write trace: {e}")
