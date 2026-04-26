---
description: How the Brain interacts with Pocketlawyer & HeyJb MCP Servers
---

# Legal & Marketing MCP Workflow

This workflow dictates how the 7-Tier Brain interfaces with specialized Model Context Protocol (MCP) servers like **Pocketlawyer** (Legal) and **HeyJb** (Marketing).

## The Sociocognitive Mapping

While **Ollama (Tier 1)** natively supports tool execution (e.g. `llama3.1:8b` handles OpenAI-compatible function calling flawlessly), the Brain architecture delegates external interactions structurally to avoid overloading the local VRAM context limit:

### Step 1: The Local Lobe Strategy (Ollama)
When a prompt requests a legal document (like a TOS) or marketing strategy, the Local Lobes do **not** run the generation. Instead, they use their Memory Context to dictate the *parameters* for the tools:
- **Auditor (kruschdev)**: "Ensure the TOS explicitly covers standard Homelab liability and data sovereignty given our recent GDPR concerns."
- **Challenger (kruschgame)**: "Keep the marketing ideas aggressive and oriented toward automated SaaS conversion rates."
- **Investigator (kruschserv)**: "The TOS must include clauses about open-source attribution."

### Step 2: The Orchestrator Synthesis (Gemini Pro)
Tier 3 (The Ego) distills the Ollama gut reactions into an atomic Motor Cortex command string that explicitly calls out the required MCP tool.
*Example output:* `ask_mcp Pocketlawyer "Draft a TOS including GDPR and open-source attribution clauses"`

### Step 3: The Motor Cortex Execution (OpenClaw -> MCP)
The OpenClaw Gateway acts as the MCP Client. The Motor Cortex translates the synthesized string and routes the payload to the actual running `Pocketlawyer` or `HeyJb` MCP server. The heavy lifting of the legal drafting or marketing generation happens here, completely isolated from Tier 1's memory.

## Adding Direct Ollama Tool Use (Optional Fast-Track)

If a task is small enough, Ollama can be granted direct access by injecting the MCP schema into `lib/llm.js`:
1. Parse the available tools from OpenClaw via `GET /api/v1/mcp/tools`.
2. Map the tools into the `"tools": []` array for the `fetch()` to `http://10.0.0.144:11434/v1/chat/completions`.
3. If Ollama triggers a tool, pause the intuition response, execute the MCP call locally, and feed the result back to Ollama to finish its sentence.
