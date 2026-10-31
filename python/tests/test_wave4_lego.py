"""Comprehensive Wave 4 Lego parity tests for krusch_toolkit.{schema,upload} (INV-LEGO-20)."""

from __future__ import annotations

import asyncio
import io
import subprocess
import sys
from pathlib import Path
from typing import Any

from krusch_toolkit.schema import validate_json_schema, validate_payload
from krusch_toolkit.upload import (
    read_bounded_upload,
    sanitize_upload_filename,
    sniff_mime_magic,
    verify_upload_mime,
)

LIB_PY_ROOT = str(Path(__file__).resolve().parents[1])

PNG_SAMPLE = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
PDF_SAMPLE = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"


# ---------------------------------------------------------------------------
# 0. Bare Python 3.11+ Import Purity (Zero Optional Dependencies Required)
# ---------------------------------------------------------------------------


def test_bare_python_import_safety_without_optional_frameworks() -> None:
    """Verify schema and upload import and execute cleanly when fastapi/starlette/pydantic are blocked."""
    script = (
        "import builtins\n"
        "_orig = builtins.__import__\n"
        "def _guarded(name, *args, **kwargs):\n"
        "    if name.split('.')[0] in {'fastapi', 'starlette', 'pydantic', 'psycopg2', 'sqlalchemy'}:\n"
        "        raise ModuleNotFoundError(f'Blocked optional dependency: {name}')\n"
        "    return _orig(name, *args, **kwargs)\n"
        "builtins.__import__ = _guarded\n"
        "import krusch_toolkit.schema as sc\n"
        "import krusch_toolkit.upload as up\n"
        "res = sc.validate_json_schema({'type': 'object', 'properties': {'n': {'type': 'integer'}}}, {'n': 7})\n"
        "assert res['ok'] is True and res['data'] == {'n': 7}\n"
        "assert up.sanitize_upload_filename('../../.env') == 'env'\n"
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
# 1. krusch_toolkit.schema Tests
# ---------------------------------------------------------------------------


def test_schema_valid_object_defaults_and_unknown_stripping() -> None:
    schema = {
        "type": "object",
        "required": ["name", "count"],
        "properties": {
            "name": {"type": "string", "minLength": 2, "maxLength": 32},
            "count": {"type": "integer", "minimum": 1, "maximum": 100},
            "role": {"type": "string", "default": "member"},
            "tags": {
                "type": "array",
                "items": {"type": "string", "format": "slug"},
                "minItems": 1,
                "maxItems": 5,
                "uniqueItems": True,
            },
        },
    }
    res = validate_json_schema(
        schema,
        {
            "name": "krusch",
            "count": 42,
            "tags": ["wave-4", "lego-brick"],
            "undeclaredSecret": "strip-me",
        },
    )
    assert res["ok"] is True
    assert res["tool"] == "schema.validate"
    assert res["data"] == {
        "name": "krusch",
        "count": 42,
        "role": "member",
        "tags": ["wave-4", "lego-brick"],
    }


def test_schema_strictly_rejects_bool_for_integer_and_number() -> None:
    int_schema = {"type": "integer"}
    num_schema = {"type": "number"}

    for candidate in (True, False):
        r_int = validate_json_schema(int_schema, candidate)
        assert r_int["ok"] is False
        assert r_int["error"]["code"] == "VALIDATION_ERROR"
        assert r_int["error"]["details"]["issues"][0]["code"] == "INVALID_TYPE"

        r_num = validate_json_schema(num_schema, candidate)
        assert r_num["ok"] is False
        assert r_num["error"]["code"] == "VALIDATION_ERROR"

    # Also ensure enum/const do not equate True == 1 or False == 0
    enum_res = validate_json_schema({"enum": [0, 1]}, True)
    assert enum_res["ok"] is False
    const_res = validate_json_schema({"const": 1}, True)
    assert const_res["ok"] is False


def test_schema_rejects_nan_and_infinity_on_numeric_types() -> None:
    for bad_float in (float("nan"), float("inf"), float("-inf")):
        res_num = validate_json_schema({"type": "number"}, bad_float)
        assert res_num["ok"] is False
        assert res_num["error"]["code"] == "VALIDATION_ERROR"

        res_int = validate_json_schema({"type": "integer"}, bad_float)
        assert res_int["ok"] is False
        assert res_int["error"]["code"] == "VALIDATION_ERROR"

    # Arbitrary-precision integer must not trigger float OverflowError
    big_int_res = validate_json_schema({"type": "integer"}, 10**400)
    assert big_int_res["ok"] is True
    assert big_int_res["data"] == 10**400


def test_schema_iso_date_rejects_impossible_calendar_dates() -> None:
    schema = {"type": "string", "format": "iso-date"}
    assert validate_json_schema(schema, "2026-02-28")["ok"] is True
    assert validate_json_schema(schema, "2024-02-29")["ok"] is True

    bad_feb = validate_json_schema(schema, "2026-02-30")
    assert bad_feb["ok"] is False
    assert bad_feb["error"]["code"] == "VALIDATION_ERROR"
    assert bad_feb["error"]["details"]["issues"][0]["code"] == "INVALID_FORMAT"

    # Compact ISO without hyphens must also be rejected
    assert validate_json_schema(schema, "20260228")["ok"] is False


def test_schema_formats_email_uuid_url_ipv4_slug() -> None:
    schema = {
        "type": "object",
        "required": ["email", "id", "website", "ip", "slug"],
        "properties": {
            "email": {"type": "string", "format": "email"},
            "id": {"type": "string", "format": "uuid"},
            "website": {"type": "string", "format": "url"},
            "ip": {"type": "string", "format": "ipv4"},
            "slug": {"type": "string", "format": "slug"},
        },
    }
    valid_payload = {
        "email": "kruschdev@users.noreply.github.com",
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "website": "https://krusch.dev/articles/lego",
        "ip": "127.0.0.1",
        "slug": "wave-4-lego-bricks",
    }
    assert validate_json_schema(schema, valid_payload)["ok"] is True

    bad_payload = {
        "email": "a" * 120 + "@invalid",
        "id": "not-a-valid-uuid",
        "website": "javascript:alert(1)",
        "ip": "999.0.0.1",
        "slug": "Invalid_Slug--Name",
    }
    bad_res = validate_json_schema(schema, bad_payload)
    assert bad_res["ok"] is False
    assert len(bad_res["error"]["details"]["issues"]) == 5


def test_schema_circular_reference_and_dag_reuse() -> None:
    cyclic: dict[str, Any] = {"name": "loop"}
    cyclic["self"] = cyclic
    res = validate_json_schema({"type": "object"}, cyclic)
    assert res["ok"] is False
    assert res["error"]["code"] == "SCHEMA_CIRCULAR_REF"
    assert res["error"]["details"]["issues"][0]["code"] == "SCHEMA_CIRCULAR_REF"

    # Shared non-circular DAG sibling reference MUST succeed
    shared = {"x": 1}
    dag = {"left": shared, "right": shared}
    dag_schema = {
        "type": "object",
        "properties": {
            "left": {"type": "object", "properties": {"x": {"type": "integer"}}},
            "right": {"type": "object", "properties": {"x": {"type": "integer"}}},
        },
    }
    dag_res = validate_json_schema(dag_schema, dag)
    assert dag_res["ok"] is True
    assert dag_res["data"] == {"left": {"x": 1}, "right": {"x": 1}}


def test_schema_max_depth_guard() -> None:
    deep: Any = "leaf"
    for _ in range(10):
        deep = {"child": deep}

    res = validate_json_schema({"type": "object"}, deep, max_depth=4)
    assert res["ok"] is False
    assert res["error"]["code"] == "SCHEMA_MAX_DEPTH"
    assert res["error"]["details"]["issues"][0]["code"] == "SCHEMA_MAX_DEPTH"


def test_schema_strips_prototype_keys_and_enforces_additional_properties_false() -> None:
    schema = {
        "type": "object",
        "required": ["safe"],
        "additionalProperties": False,
        "properties": {
            "safe": {"type": "string"},
        },
    }
    # Prototype pollution keys are stripped before additionalProperties check
    proto_res = validate_json_schema(
        schema,
        {
            "safe": "clean",
            "__proto__": {"polluted": True},
            "constructor": {"bad": True},
            "prototype": {"bad": True},
        },
    )
    assert proto_res["ok"] is True
    assert proto_res["data"] == {"safe": "clean"}
    assert "__proto__" not in proto_res["data"]

    # Normal undeclared keys trigger UNKNOWN_KEY when additionalProperties is False
    extra_res = validate_json_schema(schema, {"safe": "clean", "intruder": 123})
    assert extra_res["ok"] is False
    assert extra_res["error"]["code"] == "VALIDATION_ERROR"
    assert extra_res["error"]["details"]["issues"][0]["code"] == "UNKNOWN_KEY"


def test_schema_anyof_and_union_types_and_coercion() -> None:
    schema = {
        "type": "object",
        "properties": {
            "nullableNote": {"type": ["string", "null"]},
            "port": {"type": "integer"},
            "target": {
                "anyOf": [
                    {"type": "string", "format": "ipv4"},
                    {"type": "string", "format": "url"},
                ]
            },
        },
    }
    ok_res = validate_json_schema(
        schema,
        {"nullableNote": None, "port": "8080", "target": "https://example.com"},
        coerce=True,
    )
    assert ok_res["ok"] is True
    assert ok_res["data"] == {"nullableNote": None, "port": 8080, "target": "https://example.com"}

    fail_res = validate_json_schema(
        schema,
        {"nullableNote": None, "port": 8080, "target": "not-ip-or-url"},
    )
    assert fail_res["ok"] is False
    assert fail_res["error"]["details"]["issues"][0]["code"] == "ANY_OF_MISMATCH"


def test_schema_unique_items_and_bounds_constraints() -> None:
    arr_schema = {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 3, "uniqueItems": True}
    assert validate_json_schema(arr_schema, [1, 2, 3])["ok"] is True

    dup = validate_json_schema(arr_schema, [5, 5])
    assert dup["ok"] is False
    assert dup["error"]["details"]["issues"][0]["code"] == "UNIQUE_ITEMS"

    too_short = validate_json_schema(arr_schema, [1])
    assert too_short["ok"] is False
    assert too_short["error"]["details"]["issues"][0]["code"] == "MIN_ITEMS"


def test_validate_payload_duck_typed_pydantic_v2_and_v1() -> None:
    class FakePydanticValidationError(ValueError):
        def errors(self) -> list[dict[str, Any]]:
            return [{"loc": ("age",), "msg": "Input should be a valid integer", "type": "int_parsing"}]

    class FakePydanticV2Model:
        def __init__(self, data: dict[str, Any]) -> None:
            self._data = data

        @classmethod
        def model_validate(cls, obj: Any) -> FakePydanticV2Model:
            if not isinstance(obj, dict) or not isinstance(obj.get("age"), int) or isinstance(obj.get("age"), bool):
                raise FakePydanticValidationError("Invalid age")
            return cls({"age": obj["age"], "active": True})

        def model_dump(self) -> dict[str, Any]:
            return dict(self._data)

    ok_v2 = validate_payload(FakePydanticV2Model, {"age": 30, "__proto__": {"x": 1}}, tool="user.validate")
    assert ok_v2["ok"] is True
    assert ok_v2["tool"] == "user.validate"
    assert ok_v2["data"] == {"age": 30, "active": True}

    err_v2 = validate_payload(FakePydanticV2Model, {"age": "thirty"})
    assert err_v2["ok"] is False
    assert err_v2["error"]["code"] == "VALIDATION_ERROR"
    assert err_v2["error"]["details"]["issues"][0]["path"] == "$.age"

    class FakePydanticV1Model:
        def __init__(self, name: str) -> None:
            self.name = name

        @classmethod
        def parse_obj(cls, obj: Any) -> FakePydanticV1Model:
            if not isinstance(obj, dict) or not isinstance(obj.get("name"), str):
                raise ValueError("Missing name")
            return cls(obj["name"])

        def dict(self) -> dict[str, Any]:
            return {"name": self.name}

    ok_v1 = validate_payload(FakePydanticV1Model, {"name": "legacy"})
    assert ok_v1["ok"] is True
    assert ok_v1["data"] == {"name": "legacy"}

    bad_model = validate_payload(object(), {"x": 1})
    assert bad_model["ok"] is False
    assert bad_model["error"]["code"] == "INVALID_SCHEMA"


# ---------------------------------------------------------------------------
# 2. krusch_toolkit.upload Tests
# ---------------------------------------------------------------------------


def test_sanitize_upload_filename_traversal_and_dotfiles() -> None:
    assert sanitize_upload_filename("../../.env") == "env"
    assert sanitize_upload_filename("..\\..\\etc\\passwd") == "passwd"
    assert sanitize_upload_filename("../../../..") == "upload.bin"
    assert sanitize_upload_filename("   ...   ", fallback="default.txt") == "default.txt"
    assert sanitize_upload_filename("nested/dir/trailing/") == "upload.bin"


def test_sanitize_upload_filename_windows_reserved_and_truncation() -> None:
    safe_con = sanitize_upload_filename("CON.pdf")
    assert safe_con.endswith(".pdf")
    assert safe_con.split(".", 1)[0].upper() != "CON"

    for reserved in ("PRN", "aux.txt", "NUL.json", "COM1.log", "lpt9.dat"):
        out = sanitize_upload_filename(reserved)
        assert out.split(".", 1)[0].upper() not in {"CON", "PRN", "AUX", "NUL", "COM1", "LPT9"}

    long_name = "a" * 200 + ".pdf"
    truncated = sanitize_upload_filename(long_name, max_length=24)
    assert len(truncated) == 24
    assert truncated.endswith(".pdf")

    # Truncation that would slice "CONFERENCE.pdf" down to "CON.pdf" must still neutralize CON
    trunc_reserved = sanitize_upload_filename("CONFERENCE.pdf", max_length=7)
    assert len(trunc_reserved) <= 7
    assert trunc_reserved.split(".", 1)[0].upper() != "CON"


def test_sanitize_upload_filename_bidi_and_control_chars() -> None:
    # Right-to-Left Override (U+202E) extension-spoofing attack + NUL byte
    spoofed = "invoice_\u202egnp.exe\x00\r\n  ."
    cleaned = sanitize_upload_filename(spoofed)
    assert "\u202e" not in cleaned
    assert "\x00" not in cleaned
    assert not cleaned.endswith(".")
    assert cleaned == "invoice_gnp.exe"


def test_sniff_mime_magic_all_ten_canonical_formats() -> None:
    cases: list[tuple[bytes, str]] = [
        (PDF_SAMPLE, "application/pdf"),
        (PNG_SAMPLE, "image/png"),
        (b"\xff\xd8\xff\xe0\x00\x10JFIF\x00", "image/jpeg"),
        (b"GIF89a\x01\x00\x01\x00\x80\x00\x00", "image/gif"),
        (b"RIFF\x24\x00\x00\x00WEBPVP8 ", "image/webp"),
        (b"RIFF\x24\x00\x00\x00WAVEfmt ", "audio/wav"),
        (b"ID3\x04\x00\x00\x00\x00\x00\x00", "audio/mpeg"),
        (b"\xff\xfb\x90\x64\x00\x00\x00\x00", "audio/mpeg"),
        (b"OggS\x00\x02\x00\x00\x00\x00\x00\x00", "audio/ogg"),
        (b"\x1a\x45\xdf\xa3\x93\x42\x82\x84webm", "video/webm"),
        (b"PK\x03\x04\x14\x00\x00\x00\x08\x00", "application/zip"),
    ]
    for sample, expected_mime in cases:
        assert sniff_mime_magic(sample) == expected_mime
        assert sniff_mime_magic(memoryview(sample)) == expected_mime

    assert sniff_mime_magic(b"") is None
    assert sniff_mime_magic(b"plain ascii text") is None


def test_verify_upload_mime_valid_and_spoofed_png_rejection() -> None:
    ok_png = verify_upload_mime(PNG_SAMPLE, "image/png", allowed_mime_types=["image/*"])
    assert ok_png["ok"] is True
    assert ok_png["data"]["mime_type"] == "image/png"
    assert ok_png["data"]["detected_mime"] == "image/png"

    # Spoofed PDF claiming to be image/png
    spoof_pdf = verify_upload_mime(PDF_SAMPLE, "image/png", allowed_mime_types=["image/*"])
    assert spoof_pdf["ok"] is False
    assert spoof_pdf["error"]["code"] == "UPLOAD_MIME_MISMATCH"

    # Plain ASCII claiming to be image/png
    spoof_txt = verify_upload_mime(b"not really an image", "image/png", allowed_mime_types=["image/*"])
    assert spoof_txt["ok"] is False
    assert spoof_txt["error"]["code"] == "UPLOAD_MIME_MISMATCH"


def test_verify_upload_mime_blocks_svg_script_under_image_wildcard() -> None:
    xss_svg = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'

    res_svg_mime = verify_upload_mime(
        xss_svg,
        "image/svg+xml",
        allowed_mime_types=["image/*"],
        require_magic_match=True,
    )
    assert res_svg_mime["ok"] is False
    assert res_svg_mime["error"]["code"] == "UPLOAD_MIME_MISMATCH"

    res_png_disguise = verify_upload_mime(
        xss_svg,
        "image/png",
        allowed_mime_types=["image/*"],
        require_magic_match=True,
    )
    assert res_png_disguise["ok"] is False
    assert res_png_disguise["error"]["code"] == "UPLOAD_MIME_MISMATCH"


def test_verify_upload_mime_enforces_allowlist_and_text_opt_in() -> None:
    disallowed = verify_upload_mime(
        b"PK\x03\x04\x14\x00\x00\x00",
        "application/zip",
        allowed_mime_types=["application/pdf", "image/*"],
    )
    assert disallowed["ok"] is False
    assert disallowed["error"]["code"] == "UPLOAD_UNSUPPORTED_MIME"

    # Explicitly permitted text/csv passes when binary magic is not spoofed
    csv_ok = verify_upload_mime(
        b"id,name\n1,krusch\n",
        "text/csv; charset=utf-8",
        allowed_mime_types=["text/csv", "application/pdf"],
        require_magic_match=True,
    )
    assert csv_ok["ok"] is True
    assert csv_ok["data"]["mime_type"] == "text/csv"


def test_read_bounded_upload_valid_async_uploadfile_and_sync_streams() -> None:
    class FakeUploadFile:
        def __init__(self, payload: bytes, filename: str, content_type: str) -> None:
            self._stream = io.BytesIO(payload)
            self.filename = filename
            self.content_type = content_type

        async def read(self, size: int = -1) -> bytes:
            return self._stream.read(size)

    upload = FakeUploadFile(PDF_SAMPLE, "../../quarterly_report.pdf", "application/pdf")
    res = asyncio.run(
        read_bounded_upload(
            upload,
            max_bytes=4096,
            chunk_size=16,
            allowed_mime_types=["application/pdf"],
        )
    )
    assert res["ok"] is True
    assert res["data"]["filename"] == "quarterly_report.pdf"
    assert res["data"]["original_filename"] == "../../quarterly_report.pdf"
    assert res["data"]["mime_type"] == "application/pdf"
    assert res["data"]["detected_mime"] == "application/pdf"
    assert res["data"]["size"] == len(PDF_SAMPLE)
    assert res["data"]["data"] == PDF_SAMPLE

    # Sync file-like BytesIO + raw bytes
    sync_res = asyncio.run(
        read_bounded_upload(
            io.BytesIO(PNG_SAMPLE),
            filename="avatar.png",
            content_type="image/png",
            allowed_mime_types=["image/*"],
        )
    )
    assert sync_res["ok"] is True
    assert sync_res["data"]["mime_type"] == "image/png"

    raw_res = asyncio.run(
        read_bounded_upload(
            PNG_SAMPLE,
            filename="raw.png",
            content_type="image/png",
            allowed_mime_types=["image/png"],
        )
    )
    assert raw_res["ok"] is True
    assert raw_res["data"]["size"] == len(PNG_SAMPLE)


def test_read_bounded_upload_halts_immediately_on_100mb_stream_overflow() -> None:
    """Verify a 100 MiB async UploadFile stops immediately at max_bytes + chunk_size."""
    total_virtual_stream_bytes = 100 * 1024 * 1024  # 100 MiB
    max_bytes = 131_072  # 128 KiB
    chunk_size = 65_536  # 64 KiB

    class StreamingHundredMegUploadFile:
        def __init__(self) -> None:
            self.filename = "huge_video.webm"
            self.content_type = "video/webm"
            self.bytes_emitted = 0
            self.read_calls = 0

        async def read(self, size: int = -1) -> bytes:
            if self.bytes_emitted >= total_virtual_stream_bytes:
                return b""
            step = chunk_size if size < 0 else min(size, chunk_size)
            step = min(step, total_virtual_stream_bytes - self.bytes_emitted)
            self.read_calls += 1
            self.bytes_emitted += step
            if self.read_calls == 1:
                return b"\x1a\x45\xdf\xa3" + (b"\x00" * (step - 4))
            return b"\x00" * step

    giant_upload = StreamingHundredMegUploadFile()
    res = asyncio.run(
        read_bounded_upload(
            giant_upload,
            max_bytes=max_bytes,
            chunk_size=chunk_size,
            allowed_mime_types=["video/webm"],
        )
    )

    assert res["ok"] is False
    assert res["error"]["code"] == "UPLOAD_TOO_LARGE"
    assert giant_upload.read_calls == 3
    assert giant_upload.bytes_emitted == max_bytes + chunk_size
    assert giant_upload.bytes_emitted < total_virtual_stream_bytes // 500


def test_read_bounded_upload_rejects_empty_and_invalid_inputs() -> None:
    empty_res = asyncio.run(read_bounded_upload(b"", filename="empty.bin", require_magic_match=False))
    assert empty_res["ok"] is False
    assert empty_res["error"]["code"] == "UPLOAD_EMPTY"

    oversized_bytes = asyncio.run(read_bounded_upload(b"x" * 200, max_bytes=100, require_magic_match=False))
    assert oversized_bytes["ok"] is False
    assert oversized_bytes["error"]["code"] == "UPLOAD_TOO_LARGE"

    invalid_src = asyncio.run(read_bounded_upload(12345))
    assert invalid_src["ok"] is False
    assert invalid_src["error"]["code"] == "UPLOAD_INVALID_SOURCE"


def test_schema_strip_unknown_false_preserves_extra_keys_without_proto() -> None:
    schema = {
        "type": "object",
        "properties": {"id": {"type": "integer"}},
    }
    res = validate_json_schema(
        schema,
        {"id": 10, "extraMeta": {"keep": True, "__proto__": {"bad": 1}}, "prototype": "drop"},
        strip_unknown=False,
    )
    assert res["ok"] is True
    assert res["data"] == {"id": 10, "extraMeta": {"keep": True}}


def test_schema_additional_properties_subschema_validation() -> None:
    schema = {
        "type": "object",
        "properties": {"env": {"type": "string"}},
        "additionalProperties": {"type": "integer", "minimum": 0},
    }
    ok_res = validate_json_schema(schema, {"env": "prod", "workers": 4, "retries": 2})
    assert ok_res["ok"] is True
    assert ok_res["data"] == {"env": "prod", "workers": 4, "retries": 2}

    bad_res = validate_json_schema(schema, {"env": "prod", "workers": -1})
    assert bad_res["ok"] is False
    assert bad_res["error"]["details"]["issues"][0]["code"] == "MINIMUM"


def test_schema_exclusive_bounds_and_string_length_limits() -> None:
    schema = {
        "type": "object",
        "properties": {
            "ratio": {"type": "number", "exclusiveMinimum": 0.0, "exclusiveMaximum": 1.0},
            "code": {"type": "string", "minLength": 3, "maxLength": 5},
        },
    }
    assert validate_json_schema(schema, {"ratio": 0.5, "code": "WAV16"})["ok"] is True
    assert validate_json_schema(schema, {"ratio": 0.0, "code": "WAV16"})["ok"] is False
    assert validate_json_schema(schema, {"ratio": 1.0, "code": "WAV16"})["ok"] is False
    assert validate_json_schema(schema, {"ratio": 0.5, "code": "TOO_LONG"})["ok"] is False


def test_schema_iso_datetime_and_invalid_schema_guard() -> None:
    dt_schema = {"type": "string", "format": "iso-datetime"}
    assert validate_json_schema(dt_schema, "2026-10-31T05:24:55Z")["ok"] is True
    assert validate_json_schema(dt_schema, "2026-10-31")["ok"] is False

    bad_schema = validate_json_schema("not-a-dict", {"a": 1})  # type: ignore[arg-type]
    assert bad_schema["ok"] is False
    assert bad_schema["error"]["code"] == "INVALID_SCHEMA"

    bad_depth = validate_json_schema({"type": "object"}, {}, max_depth=0)
    assert bad_depth["ok"] is False
    assert bad_depth["error"]["code"] == "INVALID_SCHEMA"


def test_validate_payload_real_pydantic_basemodel() -> None:
    import pytest

    pydantic = pytest.importorskip("pydantic")

    class AudioConfigModel(pydantic.BaseModel):
        sample_rate: int
        voice: str = "af_heart"

    ok_res = validate_payload(AudioConfigModel, {"sample_rate": 16000})
    assert ok_res["ok"] is True
    assert ok_res["data"] == {"sample_rate": 16000, "voice": "af_heart"}

    bad_res = validate_payload(AudioConfigModel, {"sample_rate": "not-an-int"})
    assert bad_res["ok"] is False
    assert bad_res["error"]["code"] == "VALIDATION_ERROR"
    assert len(bad_res["error"]["details"]["issues"]) >= 1


def test_validate_payload_catches_cycles_before_model_invocation() -> None:
    called = False

    class GuardedModel:
        @classmethod
        def model_validate(cls, obj: Any) -> GuardedModel:
            nonlocal called
            called = True
            return cls()

        def model_dump(self) -> dict[str, Any]:
            return {}

    cyclic: dict[str, Any] = {}
    cyclic["loop"] = cyclic
    res = validate_payload(GuardedModel, cyclic)
    assert res["ok"] is False
    assert res["error"]["code"] == "SCHEMA_CIRCULAR_REF"
    assert called is False


def test_read_bounded_upload_async_iterable_stream_and_overflow() -> None:
    chunks_yielded = 0

    async def valid_chunks() -> Any:
        yield PNG_SAMPLE[:10]
        yield PNG_SAMPLE[10:]

    ok_res = asyncio.run(
        read_bounded_upload(
            valid_chunks(),
            filename="streamed.png",
            content_type="image/png",
            allowed_mime_types=["image/*"],
        )
    )
    assert ok_res["ok"] is True
    assert ok_res["data"]["data"] == PNG_SAMPLE

    async def infinite_chunks() -> Any:
        nonlocal chunks_yielded
        for _ in range(1000):
            chunks_yielded += 1
            yield b"A" * 512

    overflow_res = asyncio.run(
        read_bounded_upload(
            infinite_chunks(),
            max_bytes=1024,
            require_magic_match=False,
        )
    )
    assert overflow_res["ok"] is False
    assert overflow_res["error"]["code"] == "UPLOAD_TOO_LARGE"
    assert chunks_yielded == 3


def test_read_bounded_upload_rejects_spoofed_magic_and_svg_in_stream() -> None:
    svg_stream = io.BytesIO(b"<svg><script>fetch('https://evil.example')</script></svg>")
    res = asyncio.run(
        read_bounded_upload(
            svg_stream,
            filename="banner.svg",
            content_type="image/svg+xml",
            allowed_mime_types=["image/*"],
            require_magic_match=True,
        )
    )
    assert res["ok"] is False
    assert res["error"]["code"] == "UPLOAD_MIME_MISMATCH"


def test_upload_audio_webm_wildcard_and_fallback_sanitization() -> None:
    webm_opus = b"\x1a\x45\xdf\xa3\x93\x42\x82\x84webm"
    webm_ok = verify_upload_mime(
        webm_opus,
        "audio/webm; codecs=opus",
        allowed_mime_types=["audio/*"],
        require_magic_match=True,
    )
    assert webm_ok["ok"] is True
    assert webm_ok["data"]["mime_type"] == "audio/webm"
    assert webm_ok["data"]["detected_mime"] == "video/webm"

    spoof_audio = verify_upload_mime(
        b"<script>alert(1)</script>",
        "audio/flac",
        allowed_mime_types=["audio/*"],
        require_magic_match=True,
    )
    assert spoof_audio["ok"] is False
    assert spoof_audio["error"]["code"] == "UPLOAD_MIME_MISMATCH"

    missing_binary = verify_upload_mime(
        b"plain ascii without magic",
        "",
        allowed_mime_types=["application/pdf"],
        require_magic_match=True,
    )
    assert missing_binary["ok"] is False
    assert missing_binary["error"]["code"] == "UPLOAD_MIME_MISMATCH"

    assert sanitize_upload_filename("", fallback="bad:name*?.bin") == "bad_name_.bin"
    assert sanitize_upload_filename("", fallback="NUL") == "_NUL"
    assert sanitize_upload_filename("CON .txt") == "CON_.txt"
    assert sanitize_upload_filename("CON..txt") == "_CON..txt"
    assert sanitize_upload_filename("CONFERENCE.jpeg", max_length=8) == "_CO.jpeg"
    assert sanitize_upload_filename("COM1_extra.png", max_length=8) == "_COM.png"


def test_schema_pass3_pass4_regressions_iso_datetime_nan_and_pydantic_bool() -> None:
    dt_schema = {"type": "string", "format": "iso-datetime"}
    assert validate_json_schema(dt_schema, "2026-10-30T12:00:00.123456+02:00")["ok"] is True
    assert validate_json_schema(dt_schema, "2026-10-30t23:59:59z")["ok"] is True
    # Reject unbounded strings, week dates, compact dates, and timezone-naive timestamps
    assert validate_json_schema(dt_schema, "2026-10-30T" + "1" * 100_000)["ok"] is False
    assert validate_json_schema(dt_schema, "20261030T111111Z")["ok"] is False
    assert validate_json_schema(dt_schema, "2026-W44-5T12:00:00Z")["ok"] is False
    assert validate_json_schema(dt_schema, "2026-10-30T12:00:00")["ok"] is False

    # Reject NaN / Infinity in unschematized subtrees
    nan_untyped = validate_json_schema({}, {"metric": float("nan")})
    assert nan_untyped["ok"] is False
    assert nan_untyped["error"]["code"] == "VALIDATION_ERROR"

    inf_untyped = validate_json_schema({}, {"metric": float("inf")})
    assert inf_untyped["ok"] is False
    assert inf_untyped["error"]["code"] == "VALIDATION_ERROR"

    import pytest

    pydantic = pytest.importorskip("pydantic")

    class StrictMetricModel(pydantic.BaseModel):
        count: int
        gain: float = 1.0
        optional_ms: int | None = None

    # Reject bool for integer/float even when coerce=True or coerce=False, and reject NaN/Inf
    assert validate_payload(StrictMetricModel, {"count": True}, coerce=False)["ok"] is False
    assert validate_payload(StrictMetricModel, {"count": True}, coerce=True)["ok"] is False
    assert validate_payload(StrictMetricModel, {"count": 1, "gain": False}, coerce=True)["ok"] is False
    assert validate_payload(StrictMetricModel, {"count": 1, "optional_ms": True}, coerce=True)["ok"] is False
    assert validate_payload(StrictMetricModel, {"count": 1, "gain": float("nan")})["ok"] is False
    assert validate_payload(StrictMetricModel, {"count": 1, "gain": float("inf")})["ok"] is False

    # Respect coerce=False vs coerce=True for string-to-int on Pydantic v2 models
    assert validate_payload(StrictMetricModel, {"count": "42"}, coerce=False)["ok"] is False
    coerced_ok = validate_payload(StrictMetricModel, {"count": "42"}, coerce=True)
    assert coerced_ok["ok"] is True
    assert coerced_ok["data"]["count"] == 42


def test_schema_pass6_pydantic_coerce_bool_in_unions_and_optional_containers() -> None:
    import pytest

    pydantic = pytest.importorskip("pydantic")

    class BranchMetric(pydantic.BaseModel):
        tokens: int

    class BranchLabel(pydantic.BaseModel):
        label: str

    class ComplexCoerceModel(pydantic.BaseModel):
        opt_scores: list[int] | None = None
        opt_weights: dict[str, float] | None = None
        pair: tuple[int, str] = (1, "ok")
        target: BranchMetric | BranchLabel | None = None

    # Valid string-to-numeric coercion must still succeed across Optional containers, tuples, and unions
    valid_coerced = validate_payload(
        ComplexCoerceModel,
        {
            "opt_scores": ["10", 20],
            "opt_weights": {"alpha": "0.75"},
            "pair": ["9", "ready"],
            "target": {"tokens": "512"},
        },
        coerce=True,
    )
    assert valid_coerced["ok"] is True
    assert valid_coerced["data"]["opt_scores"] == [10, 20]
    assert valid_coerced["data"]["opt_weights"] == {"alpha": 0.75}
    assert valid_coerced["data"]["pair"] == (9, "ready")
    assert valid_coerced["data"]["target"] == {"tokens": 512}

    # Booleans inside Optional[list[int]], Optional[dict[str, float]], tuple[int, str], or Union[SubA, SubB] MUST fail closed
    assert validate_payload(ComplexCoerceModel, {"opt_scores": [True]}, coerce=True)["ok"] is False
    assert validate_payload(ComplexCoerceModel, {"opt_weights": {"alpha": False}}, coerce=True)["ok"] is False
    assert validate_payload(ComplexCoerceModel, {"pair": [True, "x"]}, coerce=True)["ok"] is False
    assert validate_payload(ComplexCoerceModel, {"target": {"tokens": True}}, coerce=True)["ok"] is False


def test_schema_pass7_pass8_aliases_sets_and_untyped_nan_tuple_cycles() -> None:
    from collections import deque

    import pytest

    # REF8-02: Untyped JSON Schema nodes ({} at root or property) must reject NaN/Inf and sanitize cyclic/polluted tuples
    assert validate_json_schema({}, float("nan"))["ok"] is False
    assert validate_json_schema({}, float("inf"))["ok"] is False
    assert validate_json_schema({"properties": {"metric": {}}}, {"metric": float("nan")})["ok"] is False

    cyc_dict: dict[str, Any] = {"__proto__": {"bad": 1}}
    cyc_tuple = (cyc_dict,)
    cyc_dict["t"] = cyc_tuple
    cyc_res = validate_json_schema({}, cyc_tuple)
    assert cyc_res["ok"] is False
    assert cyc_res["error"]["code"] == "SCHEMA_CIRCULAR_REF"

    clean_tuple_res = validate_json_schema({}, ({"__proto__": {"bad": 1}, "safe": 7},))
    assert clean_tuple_res["ok"] is True
    assert clean_tuple_res["data"] == ({"safe": 7},)

    # REF7-01 & REF8-01: Aliased unions, AliasChoices, AliasPath, set[int], and deque[int] under coerce=True
    pydantic = pytest.importorskip("pydantic")

    class AliasedBranchA(pydantic.BaseModel):
        count: int = pydantic.Field(alias="rawCount")

    class AliasedBranchB(pydantic.BaseModel):
        tag: str

    class AliasedUnionOuter(pydantic.BaseModel):
        target: AliasedBranchA | AliasedBranchB

    assert (
        validate_payload(AliasedUnionOuter, {"target": {"rawCount": "15"}}, coerce=True)["ok"]
        is True
    )
    assert (
        validate_payload(AliasedUnionOuter, {"target": {"rawCount": True}}, coerce=True)["ok"]
        is False
    )

    class AliasChoicesAndPathModel(pydantic.BaseModel):
        sample_rate: int = pydantic.Field(
            validation_alias=pydantic.AliasChoices("sample_rate", "sr")
        )
        nested_count: int = pydantic.Field(
            validation_alias=pydantic.AliasPath("nested", "count")
        )

    assert (
        validate_payload(
            AliasChoicesAndPathModel,
            {"sr": "16000", "nested": {"count": "4"}},
            coerce=True,
        )["ok"]
        is True
    )
    assert (
        validate_payload(
            AliasChoicesAndPathModel,
            {"sr": True, "nested": {"count": 4}},
            coerce=True,
        )["ok"]
        is False
    )
    assert (
        validate_payload(
            AliasChoicesAndPathModel,
            {"sr": 16000, "nested": {"count": False}},
            coerce=True,
        )["ok"]
        is False
    )

    class SetAndDequeUnionModel(pydantic.BaseModel):
        nums: set[int] | list[str]
        queue: deque[int] | list[str] = deque()

    assert (
        validate_payload(
            SetAndDequeUnionModel,
            {"nums": ["3", 4], "queue": ["7", 8]},
            coerce=True,
        )["ok"]
        is True
    )
    assert (
        validate_payload(SetAndDequeUnionModel, {"nums": [True]}, coerce=True)["ok"]
        is False
    )
    assert (
        validate_payload(
            SetAndDequeUnionModel,
            {"nums": [1], "queue": [False]},
            coerce=True,
        )["ok"]
        is False
    )


def test_pass10_regressions_namedtuple_hostile_mapping_and_upload_type_guards() -> None:
    """Verify REF10-01 and REF10-03 non-throwing contracts on NamedTuple, hostile Mapping, and upload args."""
    from collections import namedtuple
    from collections.abc import Iterator, Mapping

    Point = namedtuple("Point", ["x", "y"])
    nt_res = validate_json_schema({}, Point(3, 7))
    assert nt_res["ok"] is True
    assert nt_res["data"] == Point(3, 7)

    class TwoArgTuple(tuple):
        def __new__(cls, a: Any, b: Any) -> TwoArgTuple:
            return super().__new__(cls, (a, b))

    custom_tup_res = validate_json_schema({}, TwoArgTuple(10, 20))
    assert custom_tup_res["ok"] is True
    assert custom_tup_res["data"] == (10, 20)

    # Set yielding an inner list sanitizes to a list (unhashable in set/frozenset)
    class MutatingIterSet(set):
        def __iter__(self) -> Iterator[Any]:
            yield [1, 2]

    unhashable_set_res = validate_json_schema({}, MutatingIterSet())
    assert unhashable_set_res["ok"] is False
    assert unhashable_set_res["error"]["code"] == "VALIDATION_ERROR"

    class HostileMapping(Mapping[str, Any]):
        def __getitem__(self, key: str) -> Any:
            raise RuntimeError("mapping_boom")

        def __iter__(self) -> Iterator[str]:
            raise RuntimeError("iter_boom")

        def __len__(self) -> int:
            return 1

    class DummyModel:
        @classmethod
        def model_validate(cls, obj: Any, *, strict: bool = False) -> Any:
            return obj

    hostile_payload_res = validate_payload(DummyModel, HostileMapping())
    assert hostile_payload_res["ok"] is False
    assert hostile_payload_res["error"]["code"] == "VALIDATION_ERROR"

    hostile_schema_res = validate_payload(HostileMapping(), {"a": 1})
    assert hostile_schema_res["ok"] is False
    assert hostile_schema_res["error"]["code"] == "INVALID_SCHEMA"

    # REF10-03: verify_upload_mime handles non-string declared_mime and non-iterable / non-string allowed_mime_types
    bad_allow_int = verify_upload_mime(PNG_SAMPLE, 12345, allowed_mime_types=999)  # type: ignore[arg-type]
    assert bad_allow_int["ok"] is False
    assert bad_allow_int["error"]["code"] == "UPLOAD_UNSUPPORTED_MIME"

    bad_allow_mixed = verify_upload_mime(PNG_SAMPLE, None, allowed_mime_types=[None, 42, "image/png"])  # type: ignore[arg-type,list-item]
    assert bad_allow_mixed["ok"] is True
    assert bad_allow_mixed["data"]["mime_type"] == "image/png"

    bad_allow_bytes = verify_upload_mime(PNG_SAMPLE, "image/png", allowed_mime_types=b"image/png")  # type: ignore[arg-type]
    assert bad_allow_bytes["ok"] is False
    assert bad_allow_bytes["error"]["code"] == "UPLOAD_UNSUPPORTED_MIME"


def test_pass14_regressions_schema_keyword_validation_and_oneof() -> None:
    """REF14-02: Malformed JSON Schema keywords and uncompiled callables/models fail closed with INVALID_SCHEMA."""

    class EmbeddedModel:
        @classmethod
        def model_validate(cls, obj: Any, *, strict: bool = False) -> Any:
            return obj

    for bad_schema in [
        {"id": str},
        {"model": EmbeddedModel},
        {"type": "object", "properties": "not-a-dict"},
        {"type": "object", "properties": {"id": "not-a-dict"}},
        {"type": "object", "required": "id"},
        {"type": "object", "required": [123]},
        {"type": "array", "items": "string"},
        {"type": "object", "additionalProperties": "false"},
        {"enum": "admin"},
        {"anyOf": "string"},
        {"anyOf": []},
        {"oneOf": "number"},
        {"oneOf": []},
        {"type": "number", "minimum": "10"},
        {"type": "number", "maximum": float("nan")},
        {"type": "number", "minimum": True},
        {"type": "string", "minLength": -1},
        {"type": "string", "maxLength": True},
        {"type": "array", "uniqueItems": "true"},
        {"type": "string", "format": 123},
        {"type": "object", "minProperties": -1},
        {"type": "object", "maxProperties": "3"},
    ]:
        res = validate_json_schema(bad_schema, {"id": 1})  # type: ignore[arg-type]
        assert res["ok"] is False
        assert res["error"]["code"] == "INVALID_SCHEMA"

    # Verify valid `oneOf` and `minProperties`/`maxProperties` runtime evaluation
    one_of_schema = {
        "oneOf": [
            {"type": "number", "minimum": 0},
            {"type": "number", "maximum": 10},
        ]
    }
    assert validate_json_schema(one_of_schema, 20)["ok"] is True
    assert validate_json_schema(one_of_schema, -5)["ok"] is True
    both_match = validate_json_schema(one_of_schema, 5)
    assert both_match["ok"] is False
    assert both_match["error"]["code"] == "VALIDATION_ERROR"

    prop_count_schema = {"type": "object", "minProperties": 1, "maxProperties": 2}
    assert validate_json_schema(prop_count_schema, {})["ok"] is False
    assert validate_json_schema(prop_count_schema, {"a": 1})["ok"] is True
    assert validate_json_schema(prop_count_schema, {"a": 1, "b": 2, "c": 3})["ok"] is False

