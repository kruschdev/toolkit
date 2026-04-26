/**
 * @module holodata
 * Holodata Catalyst Prompts (Javascript Port)
 * Adapted from NeoVertex1/holodata for strict JSON schema coercion.
 */

/**
 * Wraps a target JSON schema requirement in a Holodata recursive metadata block
 * to force adherence and prevent Markdown hallucination by limiting open-ended reasoning.
 * 
 * @param {string} targetSchemaJson - The exact string representation of the strict JSON format required
 * @returns {string} The raw XML catalyst block to inject into system prompts
 */
export function generateHolodataSchemaWrapper(targetSchemaJson) {
    return `
<rules>
  <META_PROMPT1>
    Follow the prompt instructions laid out below. They contain exact schema structures.
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
${targetSchemaJson}
    </schema_target>
  </answer_operator>
</rules>
`;
}
