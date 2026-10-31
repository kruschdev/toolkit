"""
Pre-Reasoning engine integration wrapper.
Provides low-latency, deterministic System 2 reasoning traces.
"""

from typing import Optional, Dict, Any
import logging

logger = logging.getLogger(__name__)

# Lazy imports to prevent importing torch at module level
_engine = None

def get_engine(checkpoint_path: Optional[str] = None, device: str = "auto"):
    """
    Lazy initializer for the Pre-Reasoning ReasoningEngine.
    """
    global _engine
    if _engine is not None:
        return _engine
    
    try:
        from pre_reasoning import get_engine as load_pre_reasoning
    except ImportError as e:
        logger.error("pre-reasoning is not installed. Run 'pip install -e projects/pre-reasoning'")
        raise RuntimeError("pre-reasoning package not found in current environment") from e

    try:
        _engine = load_pre_reasoning(checkpoint_path=checkpoint_path, device=device)
        return _engine
    except Exception as e:
        logger.error(f"Failed to initialize pre-reasoning engine: {e}")
        raise e

def analyze(text: str, checkpoint_path: Optional[str] = None, device: str = "auto") -> Dict[str, Any]:
    """
    Analyze natural language problem text and return a structural trace.
    """
    engine = get_engine(checkpoint_path=checkpoint_path, device=device)
    return engine.analyze(text)

def pulse(original_problem: str, response: str, checkpoint_path: Optional[str] = None, device: str = "auto") -> Dict[str, Any]:
    """
    Pulse check a draft response against detected root blockers from the problem.
    """
    engine = get_engine(checkpoint_path=checkpoint_path, device=device)
    return engine.pulse(original_problem, response)
