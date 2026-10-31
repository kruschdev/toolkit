"""
Pydantic schemas governing the rigid IPC contract between the Python Brain and the Node.js Factory.
Ensures zero LLM hallucination makes it across the DB boundary.
"""
from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field

class ComponentStub(BaseModel):
    """
    Instructions required to build a physical file component.
    """
    file_path: str = Field(description="The physical path relative to project root (e.g., 'src/index.js')")
    component_type: str = Field(description="The type of logic (e.g., 'javascript', 'css', 'html')")
    global_dependencies: List[str] = Field(default_factory=list, description="Explicit globals to hook into (e.g., 'window.gameState')")
    description_constraint: str = Field(description="Strict description of what the JS factory must generate here. NO vague instructions.")

class PhaseArray(BaseModel):
    """
    A sequence of file generations representing the dependency order.
    """
    phase_order: int = Field(description="Execution sequence order (0-indexed)")
    phase_name: str = Field(description="Descriptive name of the phase")
    components: List[ComponentStub] = Field(description="Files to generate concurrently in this phase")

class ContextualConstraint(BaseModel):
    """
    Rigid global rules injected by the CCG Engine.
    """
    source_persona: str = Field(description="The AI Persona that derived this constraint")
    rule: str = Field(description="The absolute mandate (e.g., 'MUST NOT use let/const, MUST use var')")

class BlueprintState(BaseModel):
    """
    The ultimate, finalized SMLMG Graph object.
    When this passes `.model_validate()`, it represents a mathematically complete architecture blueprint.
    """
    task_goal: str = Field(description="The literal requested goal")
    global_constraints: List[ContextualConstraint] = Field(default_factory=list, description="Rules the downstream factory MUST obey globally")
    phase_graph: List[PhaseArray] = Field(description="The Directed Acyclic Graph natively ordered as sequential phases.")
    dom_skeleton_html: Optional[str] = Field(default=None, description="If applicable, the one-shot explicit DOM skeleton ID list.")

