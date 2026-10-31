"""
Contextual Constraint Graph (CCG) Engine for Genesis Split.
Generates deterministic Persona Hub restrictions based on the task goal.
"""
import logging
from typing import List

from krusch_toolkit.ai import chat_json
from .blueprint_schema import ContextualConstraint
from .personas import get_prompt_roster

logger = logging.getLogger(__name__)

async def generate_constraints(goal: str, config: dict) -> List[ContextualConstraint]:
    """
    Synthesizes diverse architectural constraints using the Persona Hub methodology.
    
    Args:
        goal: The user's target objective
        config: The LLM provider configuration via krusch_toolkit config
        
    Returns:
        List of formal constraint models.
    """
    logger.info(f"[CCG Engine] Instantiating Persona Hub for goal: {goal}")
    
    constraints: List[ContextualConstraint] = []
    
    dynamic_personas = get_prompt_roster()
    
    system_prompt = f"""
You are the CCG Persona Hub Synthesizer.
You have access to the following expert software personas:

{dynamic_personas}

Select EXACTLY 2 of these highly diverse, diametrically opposed expert personas that relate to the user's goal.
Based on their persona, have each issue exactly one strict architectural constraint for the eventual codebase.
Output ONLY a raw JSON array of objects.
"""
    
    schema = {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "source_persona": {"type": "string", "description": "Name/Title of the expert persona"},
                "rule": {"type": "string", "description": "The absolute architectural mandate"}
            },
            "required": ["source_persona", "rule"]
        }
    }
    
    llm_config = {**config, 'response_schema': schema}
    
    try:
        # Use fast draft model
        diverse_rules = await chat_json(
            system_prompt,
            f"[GOAL]: {goal}\nProduce the 2 strict JSON constraints.",
            llm_config,
            temperature=0.8
        )
        
        if isinstance(diverse_rules, list):
            for r in diverse_rules:
                constraints.append(ContextualConstraint(**r))
                logger.info(f"[CCG Engine] Injected Hub Persona: {r.get('source_persona')} -> {r.get('rule')[:50]}...")
                
    except Exception as e:
        logger.warning(f"[CCG Engine] Persona Hub synthesis fallback triggered: {e}")
        
    return constraints
