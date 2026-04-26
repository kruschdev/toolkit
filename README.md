# @krusch/toolkit

@krusch/toolkit is a shared library built to accelerate AI-native application development. Extracted from the Krusch homelab, this toolkit is a collection of unified utilities and abstractions that standardizes common backend patterns across agentic AI platforms.

It offers drop-in solutions for LLM API management, streaming responses, data persistence, and environment configurations.

## Features

- **LLM Abstractions:** Support for Gemini, xAI, Ollama, and OpenAI-compatible providers.
- **Database Utilities:** Seamless setup and queries for SQLite/PostgreSQL.
- **Streaming:** Dual-path SSE streaming implementations.
- **Dynamic Configuration:** Robust environment variables loader.
- **Authentication:** Factory-based JWT authentication modules.

## Installation

```bash
npm install @krusch/toolkit
```

## Usage

Example LLM call:
```javascript
import { chat } from '@krusch/toolkit/llm';

const response = await chat('You are an expert...', 'Hello world', {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: process.env.GEMINI_API_KEY
});
```

Example config loading:
```javascript
import { loadProjectConfig, envOr } from '@krusch/toolkit/config';

await loadProjectConfig(process.cwd());
const dbClient = envOr('DB_CLIENT', null, 'sqlite3');
```

## License

MIT
