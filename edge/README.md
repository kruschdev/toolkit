# Chrysalis Edge Swarm

The autonomous multi-agent execution layer for the kruschDev homelab. Manages infrastructure, deployment, and code iteration using physically distributed GPU inference across a heterogeneous hardware fleet.

## Architecture Pipeline

The Swarm has been explicitly optimized for "Zero-Latency PCIe Execution". By mathematically constraining the worker concurrency, both the heavy Logic Directors and the agile Edge Workers reside permanently inside GPU VRAM, entirely eliminating PCIe model eviction latency.

```text
         ┌─────────────────────┐
         │  Zed Command Center │  ← Human input via JSON / Chat
         └──────────┬──────────┘
                    │
         ┌──────────▼──────────┐
         │  Meta-Router        │  ← Director/Architect DAG Planner
         │  (director.js)      │  ← (32B CPU / 14B GPU)
         └──────────┬──────────┘
                    │
         ┌──────────▼──────────┐
         │  DAG Executor       │  ← Zero-Latency Concurrency Pool (limit=2)
         │  (daemon.js)        │
         └──────────┬──────────┘
                    │
    ┌───────────────┴───────────────┐
    │                               │
    ▼                               ▼
┌──────────────┐             ┌───────────────┐
│ RTX 3060     │             │ RTX 3050      │
│ (kruschdev)  │             │ (kruschgame)  │
├──────────────┤             ├───────────────┤
│ Director 14B │             │ Escalator 3B  │
│ Worker 1.5B  │             │ Worker 1.5B   │
│ Worker 1.5B  │             │               │
└──────────────┘             └───────────────┘
```

## Hardware Segregation Topology

- **kruschdev (RTX 3060 - 12GB)**: The central Orchestrator. Natively pinned with the `14B` Director and two `1.5B` base edge workers. The thread pool is strictly locked to `2` to guarantee the 12.5GB payload fits perfectly into the 12GB VRAM boundary without PCIe eviction.
- **kruschgame (RTX 3050 - 4GB)**: The designated `Escalation Node`. If an edge worker fails an audit iteratively, `dispatch.js` routes the intervention to this node to natively execute the `3B` Context-Aware models entirely isolated from the Orchestrator's execution threads.
- **krmac13 / kryoga**: Dedicated 14B Auditor nodes utilizing unified Apple Silicon (MPS) or standard `llama.cpp` CPU memory to physically offload logic audits from the main swarm orchestrator.

## Core Modules

| Module | Purpose |
|--------|---------|
| `daemon.js` | Zero-Latency Pipelined Execution loop. Parses DAGs and launches edge workers. |
| `director.js` | Macro-Planner. Synthesizes task requirements into physical step blocks using 14B/32B brains. |
| `dispatch.js` | Edge-router. Directly targets raw physical hardware based on strict payload constraints. Includes real-time Hallucination Regex Interception. |
| `grounding.js` | Fuses SQLite Hive Mind Cache, dynamic OS rules, and Tool Catalogs into the System Prompts. |
| `error_memory.js`| Reflexive Learning. Parses `ENOENT` or syntax failures and caches them securely via SQLite to permanently block future repetition. |

## Quick Start

```bash
# General swarm activation:
node lib/edge/cli.js "deploy pocket lawyer"

# Run a localized, context-heavy execution without triggering the 32B Cloud (Forcing local 14B)
SWARM_MODE=local node lib/edge/daemon.js
```

## Security & Reliability 

- **Flash-Lite Fallback**: All critical Swarm step failures are intercepted by a highly-agile `3B` fallback protocol.
- **Strict VRAM Concurrency**: Physical kernel PCIe swaps are eliminated by mathematically mapping payload sizes to physical GPU VRAM sizes.
- **No arbitrary shell**: `run_safe` mathematically validates every proposed command against a curated regex allowlist (`rm`, `mv`, and raw semicolons are completely restricted).

## Canonical Documentation

Full architecture spec: [`docs/chrysalis_swarm_architecture.md`](../../docs/chrysalis_swarm_architecture.md)
