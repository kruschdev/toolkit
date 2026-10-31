import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import os from 'os';
const defaultTracePath = path.join(os.tmpdir(), 'krusch-toolkit-traces', 'traces.jsonl');
const TRACE_FILE = process.env.HALO_TRACES_PATH || defaultTracePath;

function resolveTraceFile() {
    return process.env.HALO_TRACES_PATH || TRACE_FILE;
}

function ensureTraceDir(traceFile) {
    const dir = path.dirname(traceFile);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function getIsoTimestamp() {
    return new Date().toISOString().replace('Z', '000Z');
}

export function startSpan(spanType, name, parentContext = null) {
    return {
        trace_id: parentContext?.trace_id || crypto.randomUUID().replace(/-/g, ''),
        span_id: crypto.randomUUID().replace(/-/g, '').substring(0, 16),
        parent_span_id: parentContext?.span_id || '',
        name: `${spanType}.${name}`,
        kind: spanType === 'generation' ? 'SPAN_KIND_CLIENT' : 'SPAN_KIND_INTERNAL',
        start_time: getIsoTimestamp(),
        span_type: spanType
    };
}

export function endSpan(span, attributes = {}, error = null) {
    const traceFile = resolveTraceFile();
    ensureTraceDir(traceFile);
    span.end_time = getIsoTimestamp();
    
    let status = { code: "STATUS_CODE_OK", message: "" };
    if (error) {
        status = { code: "STATUS_CODE_ERROR", message: String(error.message || error) };
    }

    const baseAttributes = {
        "inference.export.schema_version": 1,
        "inference.project_id": process.env.HALO_PROJECT_ID || "krusch-toolkit",
        "inference.observation_kind": span.span_type === "generation" ? "LLM" : (span.span_type === "function" ? "TOOL" : "SPAN")
    };

    const finalAttributes = { ...baseAttributes, ...attributes };

    const otlpLine = {
        trace_id: span.trace_id,
        span_id: span.span_id,
        parent_span_id: span.parent_span_id,
        trace_state: "",
        name: span.name,
        kind: span.kind,
        start_time: span.start_time,
        end_time: span.end_time,
        status: status,
        resource: { attributes: { "service.name": process.env.HALO_SERVICE_NAME || "krusch-agent" } },
        scope: { name: "krusch-tracing", version: "1.0.0" },
        attributes: finalAttributes
    };

    fs.appendFileSync(traceFile, JSON.stringify(otlpLine) + '\n');
}
