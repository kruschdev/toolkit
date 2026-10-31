"""
The Main Director for the Swarm Blueprint Engine.
Provides a deterministic agentic flow taking a goal and pushing an unyielding architectural blueprint
into the swarm_blueprints database.
"""
import sys
import uuid
import asyncio
import logging

from krusch_toolkit.config import load_project_config
from krusch_toolkit.log import setup_logging
from .db_bridge import db_bridge
from .ccg_engine import generate_constraints
from .architect import draft_architecture

logger = logging.getLogger(__name__)

async def run_swarm_lifecycle(goal: str, test_mode: bool = False):
    """
    Executes the strict determinisitc pipeline.
    """
    logger.info("==================================================")
    logger.info(f"[Director] Initiating Swarm Blueprint pipeline for: {goal}")
    logger.info("==================================================")
    
    # 1. Boot Environment
    config = load_project_config()
    
    # Ensure LLM default provider is set
    llm_config = {
        'provider': config.get('ai_provider', 'ollama'),
        'api_url': config.get('ai_api_url', 'http://127.0.0.1:11434/v1/chat/completions'),
        'model': config.get('ai_model', 'qwen3-coder-30b-moe:latest'),
        'api_key': config.get('ai_api_key', '')
    }
    
    # 2. Initialize Database if necessary
    try:
        db_bridge.init_db()
    except Exception as e:
        logger.error(f"[Director] Failed to initialize DB bridge. Make sure Postgres is running: {e}")
        if not test_mode:
            return False
        logger.warning("[Director] Proceeding in dry-run mode since this might be a test.")
        
    # 3. CCG Extraction (Persona Constraints)
    constraints = await generate_constraints(goal, llm_config)
    
    # 4. Architect Pipeline (Drafting & PSDD Verification)
    blueprint = await draft_architecture(goal, constraints, llm_config)
    
    if not blueprint:
        logger.critical("[Director] Swarm Terminated. Failed to mathematically verify architecture safety.")
        return False
        
    logger.info("[Director] Architecture Verified. Formatting Blueprint State...")
    blueprint_json = blueprint.model_dump_json(indent=2)
    
    if test_mode:
        logger.info(f"[Director] TEST MODE Output:\n{blueprint_json}")
        return True
        
    # 5. IPC Handoff
    task_id = f"v0_task_{uuid.uuid4().hex[:8]}"
    success = db_bridge.commit_blueprint(task_id, blueprint_json)
    
    if success:
        logger.info(f"[Director] Swarm complete. Sent task {task_id} to DB IPC.")
    else:
        logger.error("[Director] Failed to commit to DB.")
        
    return success

if __name__ == "__main__":
    setup_logging("swarm_blueprints", level=logging.INFO)
    test_goal = "Synthesize an Asteroids Arcade Clone using generic JS classes."
    if len(sys.argv) > 1:
        test_goal = " ".join(sys.argv[1:])
    asyncio.run(run_swarm_lifecycle(test_goal, test_mode=False))
