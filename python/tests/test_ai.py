"""Tests for krusch_toolkit.ai — including PL-extracted select_model."""

from krusch_toolkit.ai import select_model, parse_ai_json, DEFAULT_PRO_TASKS, DEFAULT_FLASH_TASKS


# ── select_model (PL pattern) ────────────────────────────────────────────────

BASE_CONFIG = {
    'model': 'gemini-2.5-flash',
    'analysis_model': 'gemini-2.5-pro',
}


def test_select_model_pro_user_complex_task():
    """Pro users should get analysis model for complex tasks."""
    model = select_model('legal_research', BASE_CONFIG, user_tier='pro')
    assert model == 'gemini-2.5-pro'


def test_select_model_pro_user_routine_task():
    """Pro users still get flash for routine tasks."""
    model = select_model('summarization', BASE_CONFIG, user_tier='pro')
    assert model == 'gemini-2.5-flash'


def test_select_model_basic_user_complex_task():
    """Basic users don't get pro model even for complex tasks."""
    model = select_model('legal_research', BASE_CONFIG, user_tier='basic')
    assert model == 'gemini-2.5-flash'


def test_select_model_unknown_task_defaults_to_flash():
    """Unknown task types default to flash for cost efficiency."""
    model = select_model('some_random_task', BASE_CONFIG, user_tier='pro')
    assert model == 'gemini-2.5-flash'


def test_select_model_no_analysis_model():
    """Falls back to default model if analysis_model is not configured."""
    config = {'model': 'gemini-2.5-flash'}
    model = select_model('legal_research', config, user_tier='pro')
    assert model == 'gemini-2.5-flash'


def test_select_model_custom_task_sets():
    """Custom pro/flash task sets override defaults."""
    config = {
        **BASE_CONFIG,
        'pro_tasks': {'custom_analysis'},
        'flash_tasks': {'custom_routine'},
    }
    assert select_model('custom_analysis', config, user_tier='pro') == 'gemini-2.5-pro'
    assert select_model('custom_routine', config, user_tier='pro') == 'gemini-2.5-flash'
    # Default pro task not in custom set → flash
    assert select_model('legal_research', config, user_tier='pro') == 'gemini-2.5-flash'


def test_select_model_enterprise_tier():
    """Enterprise tier should behave like pro."""
    model = select_model('deep_analysis', BASE_CONFIG, user_tier='enterprise')
    assert model == 'gemini-2.5-pro'


# ── parse_ai_json ────────────────────────────────────────────────────────────

def test_parse_ai_json_clean():
    assert parse_ai_json('{"key": "value"}') == {"key": "value"}


def test_parse_ai_json_markdown_fenced():
    text = '```json\n{"key": "value"}\n```'
    assert parse_ai_json(text) == {"key": "value"}


def test_parse_ai_json_embedded_in_prose():
    text = 'Here is the result: {"key": "value"} and more text.'
    assert parse_ai_json(text) == {"key": "value"}


def test_parse_ai_json_array():
    assert parse_ai_json('[1, 2, 3]') == [1, 2, 3]


# ── Gemini 4 Argon (Developer Guide & Long Decode) ───────────────────────────

def test_gemini_4_helpers():
    from krusch_toolkit.ai import (
        is_gemini_4_model,
        normalize_thinking_level,
        resolve_max_output_tokens,
        build_gemini_payload,
        extract_gemini_text_parts,
    )

    assert is_gemini_4_model('gemini-4-argon') is True
    assert is_gemini_4_model('GEMINI-4-ARGON') is True
    assert is_gemini_4_model('gemini-2.5-pro') is False

    assert normalize_thinking_level(None, 'gemini-4-argon') == 'medium'
    assert normalize_thinking_level('HIGH', 'gemini-4-argon') == 'high'
    assert normalize_thinking_level('minimal', 'gemini-4-argon') == 'low'

    assert resolve_max_output_tokens('gemini-4-argon', {}, None) == 65536
    assert resolve_max_output_tokens('gemini-4-argon', {'max_tokens': 2000}, None) == 65536
    assert resolve_max_output_tokens('gemini-4-argon', {'max_tokens': 2000, 'strict_max_tokens': True}, None) == 2000
    assert resolve_max_output_tokens('gemini-2.5-flash', {}, None) == 2000

    payload = build_gemini_payload(
        'System prompt',
        'User prompt',
        {'thinking_level': 'high'},
        'gemini-4-argon',
        0.7,
        262144,
        continuation_token='tok_123',
    )
    assert 'temperature' not in payload['generationConfig']
    assert payload['generationConfig']['maxOutputTokens'] == 262144
    assert payload['generationConfig']['thinkingConfig'] == {'thinkingLevel': 'high'}
    assert payload['continuationToken'] == 'tok_123'

    parts = [
        {'text': 'Hidden thought trace', 'thought': True},
        {'text': 'Visible answer part 1. '},
        {'text': 'Visible answer part 2.'},
    ]
    assert extract_gemini_text_parts(parts) == 'Visible answer part 1. Visible answer part 2.'


def test_gemini_4_multihop_continuation(monkeypatch):
    import asyncio
    import httpx
    from krusch_toolkit.ai import _chat_gemini
    # MockAsyncClient relocated to tests/_mocks.py (DX-01)
    from _mocks import MockAsyncClient

    captured_payloads = []
    MockAsyncClient.captured_payloads = captured_payloads
    monkeypatch.setattr(httpx, 'AsyncClient', MockAsyncClient)

    text, usage = asyncio.run(
        _chat_gemini(
            'System',
            'Prompt',
            {'api_key': 'test-key', 'thinking_level': 'high'},
            'gemini-4-argon',
            0.7,
            262144,
        )
    )

    assert len(captured_payloads) == 2
    assert 'continuationToken' not in captured_payloads[0]
    assert captured_payloads[1]['continuationToken'] == 'hop_token_1'
    assert captured_payloads[0]['contents'] == captured_payloads[1]['contents']
    assert text == 'Final synthesized output.'
    assert usage['hops'] == 2
    assert usage['initial_prompt_tokens'] == 500
    assert usage['input_tokens'] == 33768
    assert usage['cached_tokens'] == 32000
    assert usage['output_tokens'] == 800
    assert usage['thought_tokens'] == 33968


def test_validate_nonempty_str_and_url_env(monkeypatch):
    import pytest
    from krusch_toolkit.config import validate_nonempty_str, validate_url_env

    assert validate_nonempty_str('  sqlite:///test.db  ', 'DB_URL') == 'sqlite:///test.db'
    with pytest.raises(ValueError, match='DB_URL cannot be empty'):
        validate_nonempty_str('   ', 'DB_URL')

    monkeypatch.setenv('TEST_SERVICE_URL', 'http://127.0.0.1:8085/api')
    assert validate_url_env('TEST_SERVICE_URL', 'http://localhost:8000') == 'http://127.0.0.1:8085/api'

    monkeypatch.setenv('TEST_SERVICE_URL', '   ')
    with pytest.raises(ValueError, match='TEST_SERVICE_URL cannot be empty'):
        validate_url_env('TEST_SERVICE_URL', 'http://localhost:8000')

    monkeypatch.setenv('TEST_SERVICE_URL', 'ftp://127.0.0.1:8085')
    with pytest.raises(ValueError, match='unsupported URL scheme'):
        validate_url_env('TEST_SERVICE_URL', 'http://localhost:8000')
