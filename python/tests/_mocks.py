"""Shared test-only mock helpers for krusch_toolkit (DX-01)."""


class MockResponse:
    def __init__(self, status_code: int, data: dict):
        self.status_code = status_code
        self._data = data
        self.text = str(data)

    def json(self) -> dict:
        return self._data


class MockAsyncClient:
    """Reusable mock httpx.AsyncClient for multi-hop Gemini 4 continuation tests."""

    captured_payloads: list = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, json=None, headers=None):
        self.captured_payloads.append(json)
        if len(self.captured_payloads) == 1:
            return MockResponse(
                200,
                {
                    "candidates": [
                        {
                            "content": {
                                "role": "model",
                                "parts": [{"text": "Thinking...", "thought": True}, {"text": ""}],
                            },
                            "finishReason": "CONTINUATION",
                            "continuationToken": "hop_token_1",
                        }
                    ],
                    "usageMetadata": {
                        "promptTokenCount": 500,
                        "candidatesTokenCount": 0,
                        "thoughtsTokenCount": 32768,
                        "totalTokenCount": 33268,
                    },
                },
            )
        return MockResponse(
            200,
            {
                "candidates": [
                    {
                        "content": {"role": "model", "parts": [{"text": "Final synthesized output."}]},
                        "finishReason": "STOP",
                    }
                ],
                "usageMetadata": {
                    "promptTokenCount": 33268,
                    "cachedContentTokenCount": 32000,
                    "candidatesTokenCount": 800,
                    "thoughtsTokenCount": 1200,
                    "totalTokenCount": 35268,
                },
            },
        )
