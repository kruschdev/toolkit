"""
Multi-provider LLM client — mirrors @krusch/toolkit/llm.

Supports Gemini (REST API), Anthropic/Claude (Messages API), and
OpenAI-compatible providers (xAI, Ollama, etc.) through a single
`chat()` interface. Switch providers via config dict.

Usage:
    from krusch_toolkit.ai import chat, chat_json, select_model

    config = {
        'provider': 'gemini',
        'api_key': 'xxx',
        'model': 'gemini-2.5-flash',
        'analysis_model': 'gemini-2.5-pro',
        'temperature': 0.7,
        'max_tokens': 2000,
    }
    answer = await chat('You are a helpful assistant.', 'Hello!', config)
    data = await chat_json('Respond in JSON.', 'List 3 colors.', config)
    model = select_model('legal_research', config, user_tier='pro')
"""

import json
import logging
from typing import Any

import httpx

from .tracing import start_span, end_span, SpanContext

logger = logging.getLogger(__name__)

GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
ANTHROPIC_API_VERSION = '2023-06-01'


def is_gemini_4_model(model_name: str | None = '') -> bool:
    """Detect whether a model identifier belongs to the Gemini 4 family (e.g. `gemini-4-argon`)."""
    if not isinstance(model_name, str):
        return False
    return model_name.strip().lower().startswith('gemini-4')


def normalize_thinking_level(level: str | None = None, model_name: str | None = '') -> str | None:
    """
    Normalize thinking_level for Gemini models.
    Gemini 4 Argon supports 'low', 'medium' (default), and 'high', and rejects 'minimal' with HTTP 400.
    """
    gemini_4 = is_gemini_4_model(model_name)
    if not level:
        return 'medium' if gemini_4 else None
    normalized = str(level).strip().lower()
    if normalized == 'minimal':
        return 'low' if gemini_4 else 'minimal'
    if normalized in ('low', 'medium', 'high'):
        return normalized
    return 'medium' if gemini_4 else None


def resolve_max_output_tokens(
    model_name: str | None,
    config: dict | None = None,
    max_tokens: int | None = None,
) -> int:
    """
    Resolve safe maxOutputTokens for the target model.
    Gemini 4 Argon shares maxOutputTokens across internal thinking + output tokens;
    a legacy 2000-token cap truncates responses during thinking.
    """
    cfg = config or {}
    gemini_4 = is_gemini_4_model(model_name)
    strict = bool(cfg.get('strict_max_tokens'))
    raw_max = max_tokens if max_tokens is not None else cfg.get('max_tokens')

    if raw_max is not None:
        if gemini_4 and not strict and raw_max <= 2000:
            return 65536
        return int(raw_max)
    return 65536 if gemini_4 else 2000


async def chat(
    system_prompt: str,
    user_message: str,
    config: dict,
    *,
    max_tokens: int | None = None,
    temperature: float | None = None,
    thinking_level: str | None = None,
    automatic_continuation: bool | None = None,
    continuation_token: str | None = None,
    use_analysis_model: bool = False,
) -> str:
    """
    Send a chat message to any supported LLM provider.

    Args:
        system_prompt: System/role instructions
        user_message: User message content
        config: Provider config dict with keys:
            - provider: 'gemini' | 'anthropic' | 'xai' | 'openai' | 'ollama'
            - api_key: API key (not needed for Ollama)
            - model: Model name
            - analysis_model: Optional heavy-duty model
            - api_url: Custom API URL (required for xai/openai)
            - temperature: Default temperature (0.7)
            - max_tokens: Default max tokens (2000, or 65536 for Gemini 4)
            - thinking_level: Optional Gemini thinking level ('low', 'medium', 'high')
            - automatic_continuation: Optional bool for Gemini 4 multi-hop long decode
        max_tokens: Per-call override
        temperature: Per-call override
        thinking_level: Per-call thinking level override
        automatic_continuation: Per-call continuation loop toggle
        continuation_token: Initial continuation token to resume a long decode
        use_analysis_model: Use analysis_model instead of model

    Returns:
        Text response from the LLM
    """
    provider = config['provider']
    resolved_model = (
        config.get('analysis_model', config['model'])
        if use_analysis_model
        else config['model']
    )
    resolved_temp = temperature if temperature is not None else config.get('temperature', 0.7)
    resolved_max = resolve_max_output_tokens(resolved_model, config, max_tokens)

    effective_config = {
        **config,
        **(
            {'thinking_level': thinking_level}
            if thinking_level is not None
            else {}
        ),
        **(
            {'automatic_continuation': automatic_continuation}
            if automatic_continuation is not None
            else {}
        ),
        **(
            {'continuation_token': continuation_token}
            if continuation_token is not None
            else {}
        ),
    }

    trace_context = config.get('trace_context')
    span = start_span('generation', resolved_model, trace_context)

    try:
        if provider == 'gemini':
            text, usage = await _chat_gemini(
                system_prompt,
                user_message,
                effective_config,
                resolved_model,
                resolved_temp,
                resolved_max,
            )
        elif provider in ('anthropic', 'claude'):
            text, usage = await _chat_anthropic(system_prompt, user_message, effective_config, resolved_model, resolved_temp, resolved_max)
        elif provider in ('xai', 'openai', 'grok'):
            text, usage = await _chat_openai_compat(system_prompt, user_message, effective_config, resolved_model, resolved_temp, resolved_max)
        elif provider == 'ollama':
            ollama_config = {**effective_config, 'api_url': config.get('api_url', 'http://localhost:11434/v1/chat/completions')}
            text, usage = await _chat_openai_compat(system_prompt, user_message, ollama_config, resolved_model, resolved_temp, resolved_max)
        else:
            raise ValueError(f"Unknown LLM provider: {provider}. Supported: gemini, anthropic, xai, openai, ollama")

        import re
        final_text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()
        
        end_span(span, {
            "llm.provider": provider,
            "inference.llm.model_name": resolved_model,
            "inference.llm.input_tokens": usage.get('input_tokens'),
            "inference.llm.output_tokens": usage.get('output_tokens'),
            "llm.input_messages": json.dumps([{"role": "system", "content": system_prompt}, {"role": "user", "content": user_message}]),
            "llm.output_messages": json.dumps([{"role": "assistant", "content": final_text}])
        })
        return final_text

    except Exception as e:
        end_span(span, {
            "llm.provider": provider,
            "inference.llm.model_name": resolved_model
        }, error=e)
        raise e


async def chat_json(
    system_prompt: str,
    user_message: str,
    config: dict,
    **kwargs,
) -> Any:
    """
    Chat and parse the response as JSON.

    Strips markdown fences and extracts the first JSON object/array.

    Args:
        Same as chat()

    Returns:
        Parsed JSON (dict or list)
    """
    text = await chat(system_prompt, user_message, config, **kwargs)
    return parse_ai_json(text)


def parse_ai_json(text: str) -> Any:
    """
    Extract and parse JSON from LLM output that may contain markdown fences.

    Handles:
        - Clean JSON
        - ```json ... ``` wrapped
        - JSON embedded in prose
    """
    # Strip markdown fences
    cleaned = text.strip()
    if cleaned.startswith('```'):
        lines = cleaned.split('\n')
        # Remove first line (```json) and last line (```)
        lines = [l for l in lines[1:] if l.strip() != '```']
        cleaned = '\n'.join(lines)

    # Try direct parse
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # Try extracting first JSON object or array
    for start_char, end_char in [('{', '}'), ('[', ']')]:
        start = cleaned.find(start_char)
        if start == -1:
            continue
        depth = 0
        for i, ch in enumerate(cleaned[start:], start):
            if ch == start_char:
                depth += 1
            elif ch == end_char:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(cleaned[start:i + 1])
                    except json.JSONDecodeError:
                        break

    raise ValueError(f"Could not parse JSON from LLM response: {text[:200]}...")


# ── Gemini (REST API) ────────────────────────────────────────────────────────


def build_gemini_payload(
    system_prompt: str,
    user_message: str,
    config: dict,
    model: str,
    temperature: float | None,
    max_tokens: int,
    continuation_token: str | None = None,
) -> dict:
    """
    Build the Gemini REST generateContent request payload.
    Omits sampling parameters (`temperature`) for Gemini 4 models per developer guide
    and attaches `thinkingConfig.thinkingLevel` when applicable.
    """
    gemini_4 = is_gemini_4_model(model)
    thinking_level = normalize_thinking_level(config.get('thinking_level'), model)

    generation_config: dict[str, Any] = {
        'maxOutputTokens': resolve_max_output_tokens(model, config, max_tokens),
    }
    if not gemini_4 and temperature is not None:
        generation_config['temperature'] = temperature
    if thinking_level:
        generation_config['thinkingConfig'] = {'thinkingLevel': thinking_level}
    if config.get('response_schema'):
        generation_config['responseMimeType'] = 'application/json'
        generation_config['responseSchema'] = config['response_schema']

    payload: dict[str, Any] = {
        'system_instruction': {'parts': [{'text': system_prompt}]},
        'contents': [{'role': 'user', 'parts': [{'text': user_message}]}],
        'generationConfig': generation_config,
    }
    if continuation_token:
        payload['continuationToken'] = continuation_token
    return payload


def extract_gemini_text_parts(parts: list[dict] | None) -> str:
    """Extract non-thought text from an array of Gemini content parts."""
    if not isinstance(parts, list):
        return ''
    return ''.join(
        p['text']
        for p in parts
        if isinstance(p, dict) and isinstance(p.get('text'), str) and not p.get('thought')
    )


async def _chat_gemini(
    system_prompt: str,
    user_message: str,
    config: dict,
    model: str,
    temperature: float,
    max_tokens: int,
) -> tuple[str, dict]:
    api_key = config.get('api_key')
    if not api_key:
        raise ValueError('Gemini: api_key is required')

    gemini_4 = is_gemini_4_model(model)
    timeout_sec = config.get('timeout', 1200 if gemini_4 else 120)

    base_url = config.get('api_url', GEMINI_BASE_URL)
    url = f"{base_url}/models/{model}:generateContent?key={api_key}"

    automatic_continuation = config.get('automatic_continuation', True) is not False
    max_hops = int(config.get('max_continuation_hops', 32))
    token: str | None = config.get('continuation_token')

    all_parts: list[dict] = []
    initial_prompt_tokens: int | None = None
    total_input_tokens = 0
    total_cached_tokens = 0
    total_output_tokens = 0
    total_thought_tokens = 0
    total_tokens = 0
    last_candidate: dict = {}
    hops = 0

    headers = {
        'Content-Type': 'application/json',
        'x-goog-api-key': api_key,
    }

    async with httpx.AsyncClient(timeout=timeout_sec) as client:
        while hops < max_hops:
            hops += 1
            payload = build_gemini_payload(
                system_prompt,
                user_message,
                config,
                model,
                temperature,
                max_tokens,
                continuation_token=token,
            )
            res = await client.post(url, json=payload, headers=headers)

            if res.status_code != 200:
                raise RuntimeError(f"Gemini API {res.status_code}: {res.text}")

            data = res.json()
            candidates = data.get('candidates') or []
            candidate = candidates[0] if candidates else {}
            last_candidate = candidate

            parts = candidate.get('content', {}).get('parts') or []
            all_parts.extend(parts)

            usage_data = data.get('usageMetadata') or {}
            if hops == 1 and usage_data.get('promptTokenCount') is not None:
                initial_prompt_tokens = usage_data.get('promptTokenCount')
            total_input_tokens += usage_data.get('promptTokenCount') or 0
            total_cached_tokens += usage_data.get('cachedContentTokenCount') or 0
            total_output_tokens += usage_data.get('candidatesTokenCount') or 0
            total_thought_tokens += usage_data.get('thoughtsTokenCount') or 0
            total_tokens += usage_data.get('totalTokenCount') or 0

            token = candidate.get('continuationToken')
            finish_reason = candidate.get('finishReason')

            if not automatic_continuation or finish_reason != 'CONTINUATION' or not token:
                break

    text = extract_gemini_text_parts(all_parts)
    usage = {
        'initial_prompt_tokens': initial_prompt_tokens if initial_prompt_tokens is not None else total_input_tokens,
        'input_tokens': total_input_tokens,
        'cached_tokens': total_cached_tokens,
        'output_tokens': total_output_tokens,
        'thought_tokens': total_thought_tokens,
        'total_tokens': total_tokens or (total_input_tokens + total_output_tokens + total_thought_tokens),
        'hops': hops,
        'finish_reason': last_candidate.get('finishReason'),
        'continuation_token': token,
    }
    return text.strip(), usage


# ── Anthropic / Claude (Messages API) ────────────────────────────────────────

async def _chat_anthropic(
    system_prompt: str,
    user_message: str,
    config: dict,
    model: str,
    temperature: float,
    max_tokens: int,
) -> tuple[str, dict]:
    api_key = config.get('api_key')
    if not api_key:
        raise ValueError('Anthropic: api_key is required')

    base_url = config.get('api_url', ANTHROPIC_BASE_URL)
    url = f"{base_url}/messages"

    headers = {
        'Content-Type': 'application/json',
        'x-api-key': api_key,
        'anthropic-version': config.get('anthropic_version', ANTHROPIC_API_VERSION),
    }

    payload = {
        'model': model,
        'max_tokens': max_tokens,
        'system': system_prompt,
        'messages': [
            {'role': 'user', 'content': user_message},
        ],
        'temperature': temperature,
    }

    if config.get('response_schema'):
        payload['tools'] = [{
            'name': 'output_result',
            'description': 'Output the final result matching the schema.',
            'input_schema': config['response_schema']
        }]
        payload['tool_choice'] = {'type': 'tool', 'name': 'output_result'}

    async with httpx.AsyncClient(timeout=180) as client:
        res = await client.post(url, json=payload, headers=headers)

    if res.status_code != 200:
        raise RuntimeError(f"Anthropic API {res.status_code}: {res.text}")

    data = res.json()
    content_blocks = data.get('content', [])

    usage_data = data.get('usage', {})
    usage = {
        'input_tokens': usage_data.get('input_tokens'),
        'output_tokens': usage_data.get('output_tokens')
    }

    if config.get('response_schema'):
        for b in content_blocks:
            if b.get('type') == 'tool_use' and b.get('name') == 'output_result':
                return json.dumps(b.get('input', {})), usage
        return "{}", usage

    # Claude returns content as an array of content blocks for normal chat
    text_parts = [b['text'] for b in content_blocks if b.get('type') == 'text']
    return '\n'.join(text_parts).strip(), usage


# ── OpenAI-Compatible (xAI, Ollama, etc.) ────────────────────────────────────

async def _chat_openai_compat(
    system_prompt: str,
    user_message: str,
    config: dict,
    model: str,
    temperature: float,
    max_tokens: int,
) -> tuple[str, dict]:
    url = config.get('api_url')
    if not url:
        raise ValueError(f"{config['provider']}: api_url is required")

    headers = {'Content-Type': 'application/json'}
    if config.get('api_key'):
        headers['Authorization'] = f"Bearer {config['api_key']}"

    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': user_message},
        ],
        'stream': False,
        'temperature': temperature,
        'max_tokens': max_tokens,
    }
    if config.get('provider') == 'ollama':
        payload['keep_alive'] = -1

    schema = config.get('response_schema')
    if schema:
        payload['response_format'] = {
            'type': 'json_schema',
            'json_schema': {
                'name': 'output',
                'strict': True,
                'schema': schema
            }
        }

    async with httpx.AsyncClient(timeout=120) as client:
        res = await client.post(url, json=payload, headers=headers)

    if res.status_code != 200:
        raise RuntimeError(f"{config['provider']} API {res.status_code}: {res.text}")

    data = res.json()
    usage_data = data.get('usage', {})
    usage = {
        'input_tokens': usage_data.get('prompt_tokens'),
        'output_tokens': usage_data.get('completion_tokens')
    }
    return data['choices'][0]['message']['content'].strip(), usage


# ── Sync wrappers for non-async code ─────────────────────────────────────────

def chat_sync(system_prompt: str, user_message: str, config: dict, **kwargs) -> str:
    """Synchronous wrapper for chat(). Uses httpx sync client internally."""
    import asyncio
    try:
        loop = asyncio.get_running_loop()
        # Already in async context — can't use asyncio.run
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            return pool.submit(asyncio.run, chat(system_prompt, user_message, config, **kwargs)).result()
    except RuntimeError:
        return asyncio.run(chat(system_prompt, user_message, config, **kwargs))


# ── Tiered model selection (extracted from Pocket Lawyer) ────────────────────

# Default task classifications — override via config['pro_tasks'] / config['flash_tasks']
DEFAULT_PRO_TASKS = {
    'legal_research',
    'brief_writing',
    'case_strategy',
    'deep_analysis',
    'complex_reasoning',
}

DEFAULT_FLASH_TASKS = {
    'document_generation',
    'summarization',
    'formatting',
    'classification',
    'extraction',
    'intake',
}


def select_model(
    task_type: str,
    config: dict,
    *,
    user_tier: str = 'basic',
) -> str:
    """
    Select the appropriate model based on task complexity and user tier.

    Routes routine/cheap tasks to the fast model and complex analysis
    to the more capable (and expensive) model.

    Args:
        task_type: Type of task being performed (e.g., 'legal_research', 'summarization')
        config: Provider config dict with keys:
            - model: Default/fast model name
            - analysis_model: Optional heavy-duty model (falls back to model)
            - pro_tasks: Optional set of task types requiring pro model
            - flash_tasks: Optional set of task types for flash model
        user_tier: User subscription tier (e.g., 'free', 'basic', 'pro')

    Returns:
        Model name to use for the given task
    """
    pro_tasks = config.get('pro_tasks', DEFAULT_PRO_TASKS)
    flash_tasks = config.get('flash_tasks', DEFAULT_FLASH_TASKS)
    analysis_model = config.get('analysis_model', config['model'])

    # Premium users get the analysis model for complex tasks
    if user_tier in ('pro', 'professional', 'premium', 'firm', 'enterprise'):
        if task_type in pro_tasks:
            return analysis_model

    # Flash tasks always get the fast model
    if task_type in flash_tasks:
        return config['model']

    # Default to the fast model for cost efficiency
    return config['model']
