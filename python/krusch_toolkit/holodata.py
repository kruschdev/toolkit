"""
Holodata Catalyst Prompts
Adapted from NeoVertex1/holodata for strict JSON schema coercion.
Extends the Hivemind prompt architecture.
"""

def generate_holodata_schema_wrapper(target_schema_json: str, custom_rules: str = "", strict_mode: bool = True) -> str:
    """
    Wraps a target JSON schema requirement in a Holodata recursive metadata block
    to force adherence and prevent Markdown hallucination by limiting open-ended reasoning.
    """
    
    custom_rules_xml = f"\n    <domain_persona>\n      {custom_rules}\n    </domain_persona>" if custom_rules else ""
    
    holodata_block = f"""
<rules>
  <META_PROMPT1>
    Follow the prompt instructions laid out below. They contain exact schema structures.{custom_rules_xml}
    1. Follow the conventions always.
    2. The main function is called answer_operator.
    3. You must output ONLY valid JSON matching the provided schema. No extraneous markdown.
  </META_PROMPT1>

  <answer_operator version="1.1.1">
    <holodata>
    Type: Schema Catalyst
    Purpose: Trigger Recursive JSON Conformance
    Paradigm: Self-Referential Validation
    Constraints: Exact Key Configuration
    Seed: "Awaken and Generate Metadata by aligning iterations to the provided JSON target."
    Output: JSON_Payload
    </holodata>
    
    <schema_target>
{target_schema_json}
    </schema_target>
  </answer_operator>
</rules>
"""
    return holodata_block
