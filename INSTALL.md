# Install `@krusch/toolkit` & `krusch_toolkit`

These are instructions for a coding agent (Claude Code, Codex, Cursor, Windsurf, or Antigravity) that a person asked to install and configure `toolkit` (`@krusch/toolkit` v1.8.1 for Node.js, TypeScript, and Cloudflare Workers, plus `krusch_toolkit` v1.6.0 for Python 3.11+) on their machine or inside their project.

`@krusch/toolkit` provides 40 pre-tested application runtime bricks (`http`, `streaming`, `mcp`, `pg`, `sqlite`, `security`, `idempotency`, `audit-log`, `rbac`, `pagination`, `brick-exchange`, `schema`, `yaml`, `upload`, `cascade`, `react`, `edge`, `cli`, and agentic governance modules), 7 zero-LLM project blueprints, and 16 sub-millisecond `krusch-lego` static security and boilerplate detectors.

## 1. Check Prerequisites First (All at Once)

Run a single read-only check before installing anything so nothing fails halfway through:

```bash
id -u
node -v 2>/dev/null || echo "MISSING: node"
npm -v 2>/dev/null || echo "MISSING: npm"
git --version 2>/dev/null || echo "MISSING: git"
python3 --version 2>/dev/null || echo "OPTIONAL_MISSING: python3"
```

Evaluate the output:
1. **User check**: If `id -u` prints `0` (root), stop and ask the person to run you under a normal non-root developer account.
2. **Node.js `>= 22.0.0`**: Required for native `node:sqlite` (`DatabaseSync`), `--permission` sandboxes, and zero-build ESM/TypeScript bricks. If Node.js is missing or older than `v22.0.0`, ask the person before upgrading via `nvm install 22` / `fnm use 22` or their OS package manager.
3. **Python `>= 3.11` (Optional)**: Only needed if the person also wants the Python `krusch_toolkit` package (`./python`). If they only work in JavaScript/TypeScript, skip the Python step cleanly.

## 2. Choose the Right Setup Mode

Pick the mode that matches what the person asked for:
- **Mode A: Standalone Toolkit Checkout + `krusch-lego` CLI (Default when asked to "set up toolkit on this machine")**: Clones `https://github.com/kruschdev/toolkit.git`, installs JS dependencies without downloading Chrome (`PUPPETEER_SKIP_DOWNLOAD=true`), verifies all tests and zero-leak checks, and optionally links `krusch-lego` into user-local `~/.local/bin` (never `/usr/local/bin` via `sudo`).
- **Mode B: Add `@krusch/toolkit` into an Existing Node/TS Project**: Installs `github:kruschdev/toolkit` into the current repository's `package.json` so imports like `@krusch/toolkit/http`, `@krusch/toolkit/mcp`, and `@krusch/toolkit/security` resolve natively.
- **Mode C: Add `krusch_toolkit` into a Python 3.11+ Virtual Environment**: Installs `./python` inside an isolated `.venv` (never system-wide `pip install`).

## 3. Install & Verify

### Mode A: Standalone Checkout & CLI Verification (Default)

Clone into the current directory (or `~/src/toolkit` if the current directory is `$HOME` or another unrelated repo; check with `pwd` first):

```bash
git clone https://github.com/kruschdev/toolkit.git
cd toolkit
PUPPETEER_SKIP_DOWNLOAD=true npm install
```

Create `.env` from `.env.example` only if `.env` does not already exist:

```bash
[ -f .env ] || cp .env.example .env
```

Run the full Node.js verification suite, CLI catalog check, and Zero-Leak security scanner:

```bash
npm test
npm run verify:zero-leaks
node ./bin/krusch-lego.js list
```

If the person also wants `krusch-lego` available from any terminal without `sudo` and `~/.local/bin` is on (or can be added to) their `PATH`:

```bash
mkdir -p "$HOME/.local/bin"
ln -sf "$(pwd)/bin/krusch-lego.js" "$HOME/.local/bin/krusch-lego"
```

### Mode B: Install into an Existing Node.js / TypeScript Repository

Inside the target Node 22+ project:

```bash
PUPPETEER_SKIP_DOWNLOAD=true npm install github:kruschdev/toolkit
npx krusch-lego audit .
```

*(Only omit `PUPPETEER_SKIP_DOWNLOAD=true` if the person explicitly asks for `@krusch/toolkit/browser` headless Chrome screenshot or CDP features.)*

### Mode C: Python 3.11+ `krusch_toolkit` (Optional)

Inside the `toolkit` checkout, always use a virtual environment:

```bash
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -e "./python[dev,fastapi,streamlit]"
.venv/bin/pytest python/tests -q
```

## 4. Optional: Stamp a Starter Blueprint or Start the Brick Exchange MCP Server

- **List the 7 zero-LLM project blueprints** (`node-api-sqlite`, `node-ts-service`, `node-rag-pgvector`, `mcp-stdio-server`, `fullstack-react-vite`, `python-fastapi-service`, `cloudflare-worker`):
  ```bash
  node ./bin/krusch-lego.js inspect
  ```
- **Stamp a new service in `<50ms`** (only when the person asks to scaffold a new app):
  ```bash
  node ./bin/krusch-lego.js stamp node-api-sqlite ./my-new-service
  ```
- **Attach the Validated Brick Exchange MCP Server** (only if the person asks to expose the 10-tool Brick Exchange over MCP; merge into existing config without overwriting other servers):
  ```json
  {
    "mcpServers": {
      "krusch-brick-exchange": {
        "command": "node",
        "args": ["/absolute/path/to/toolkit/bin/krusch-lego.js", "mcp"]
      }
    }
  }
  ```
  *(Replace `/absolute/path/to/toolkit` with the real path returned by `pwd`.)*

## Never

- **Never run `npm`, `pip`, or `ln` with `sudo` or as `root`**.
- **Never run global `pip install`** outside a Python virtual environment (`.venv`).
- **Never invent or populate API keys** (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`) or database passwords in `.env`; leave them empty unless the person provides them or prefers setting them manually.
- **Never overwrite an existing `.env` or wipe existing entries in an IDE MCP config file**; always read and merge JSON keys non-destructively.
- **Never download Chromium automatically** unless the person needs `@krusch/toolkit/browser`; pass `PUPPETEER_SKIP_DOWNLOAD=true` by default to keep install fast and lightweight.

## Tell the Person After

Report a concise summary covering:
1. **Where `toolkit` was installed** and which runtimes were verified (Node.js `npm test` + `verify:zero-leaks`, plus Python `pytest` if enabled).
2. **CLI readiness**: How to run `krusch-lego list`, `krusch-lego audit <dir>`, or `krusch-lego stamp <archetype> <dir>`.
3. **Optional environment keys**: Note that all 40 core bricks, SQLite FTS5/RRF, schema/YAML/security guards, and CLI blueprints work offline at `$0.00` with zero API keys, and mention `.env` only if they later want Ollama (`http://127.0.0.1:11434`) or cloud LLM helpers (`@krusch/toolkit/llm`).
