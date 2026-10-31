"""
The Architectural Generative Engine powered by OpenAI Agents pattern.
Combines Contextual Constraints with the Goal to build the final BlueprintState.
Evaluates the State via PSDD Spectral Math before returning.
"""
import json
import logging
import os
from typing import Optional, List
from pydantic import ValidationError

from openai import AsyncOpenAI

from krusch_toolkit.config import load_project_config
from .blueprint_schema import BlueprintState, ContextualConstraint
from .psdd import psdd_engine
from .db_bridge import db_bridge

logger = logging.getLogger(__name__)

async def draft_architecture(goal: str, constraints: List[ContextualConstraint], config: dict, max_retries: int = 5) -> Optional[BlueprintState]:
    """
    Stateful Agent orchestrator that loops until the PSDD math constraint passes.
    """
    logger.info(f"[Architect] Instantiating Agent for: {goal}")
    
    constraint_text = "\n".join([f"- [{c.source_persona}]: {c.rule}" for c in constraints])
    
    system_prompt = (
         "You are the Principal Systems Architect. "
         "Your job is to read the user target and generate a BlueprintState.\n"
         "You have access to a tool named `evaluate_and_commit_blueprint`. "
         "You MUST use this tool to submit your design. If the tool returns a PSDD error, "
         "you must self-correct your graph to reduce entropy and try again.\n\n"
         f"MANDATORY CONSTRAINTS:\n{constraint_text}"
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"[GOAL]: {goal}"}
    ]

    # Route to OpenAI-compatible inference endpoint (local Ollama by default)
    base_url = config.get("agent_base_url", os.environ.get("OLLAMA_OPENAI_URL", "http://127.0.0.1:11434/v1"))
    api_key = config.get("agent_api_key", os.environ.get("AGENT_API_KEY", "ollama"))
    model_name = config.get("model", "qwen3-coder-30b-moe:latest")
    
    logger.info(f"[Architect] Initializing OpenAI Client via VRAM Pool: {base_url} ({model_name})")
    
    client = AsyncOpenAI(base_url=base_url, api_key=api_key)

    tools = [
        {
            "type": "function",
            "function": {
                "name": "evaluate_and_commit_blueprint",
                "description": "Submits a full SMLMG Blueprint for PSDD spectral check and database commitment.",
                "parameters": BlueprintState.model_json_schema()
            }
        }
    ]

    for attempt in range(max_retries):
        try:
            logger.info(f"[Architect] Executing Agent turn (Loop {attempt + 1}/{max_retries})")
            
            response = await client.chat.completions.create(
                model=model_name,
                messages=messages,
                tools=tools,
                tool_choice={"type": "function", "function": {"name": "evaluate_and_commit_blueprint"}}, 
                temperature=0.1
            )

            message = response.choices[0].message
            messages.append(message)

            args = None
            if message.tool_calls:
                try:
                    args = json.loads(message.tool_calls[0].function.arguments)
                except Exception as e:
                    logger.warning(f"Error parsing tool calls argument json: {e}")
            elif message.content:
                try:
                    import re
                    json_str = message.content
                    match = re.search(r'```(?:json)?\s*(.*?)\s*```', message.content, re.DOTALL)
                    if match:
                        json_str = match.group(1)
                    
                    parsed = json.loads(json_str)
                    if "arguments" in parsed:
                        args = parsed["arguments"]
                        if isinstance(args, str):
                            args = json.loads(args)
                    elif "phase_graph" in parsed:
                        args = parsed
                except Exception as e:
                    logger.warning(f"[Architect] Attempted to parse raw text as tool call but failed: {e}")
                    
            if args:
                try:
                    # Re-inject constraints since they are globally mandated upstream
                    args['global_constraints'] = [c.model_dump() for c in constraints]
                    blueprint = BlueprintState(**args)
                except ValidationError as ve:
                    logger.warning(f"[Architect] Schema Error: {ve}")
                    messages.append({
                        "role": "user",
                        "content": f"Schema Validation Error: {str(ve)}. Ensure your JSON matches exactly."
                    })
                    continue

                # Evaluate the syntactical bounds via PSDD spectral math
                eval_result = psdd_engine.evaluate_blueprint(blueprint)
                
                if eval_result['status'] == 'SAFE':
                    logger.info(f"[Architect] Mathematical Trajectory verified SAFE. Committing to DB.")
                    
                    task_id_hash = str(hash(goal))[-8:]
                    blueprint_json = blueprint.model_dump_json()
                    db_bridge.commit_blueprint(f"task_{task_id_hash}", blueprint_json)
                    
                    return blueprint
                else:
                    error_msg = f"PSDD Spectral Limits Exceeded: {eval_result['total_entropy']}. Flatten the phase graph and reduce inter-file dependencies!"
                    logger.warning(f"[Architect] PSDD TRIPPED! Requesting Agent correction.")
                    messages.append({
                        "role": "user",
                        "content": error_msg
                    })
            else:
                 # If the model breaks constraints and responds with text, force it to use the tool
                 logger.warning(f"[Architect] Model responded with raw text instead of tool call: {message.content}")
                 messages.append({
                     "role": "user",
                     "content": "You MUST submit your response using the `evaluate_and_commit_blueprint` tool. Do not converse."
                 })
                 
        except Exception as e:
            logger.error(f"[Architect] Agent execution error: {str(e)}")
            break

    logger.critical("[Architect] Failed to converge on a stable graph after Max Retries.")
    return None
