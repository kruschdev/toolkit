/**
 * Spark (Electrical) — Trade-specific best practices, safety alerts, and code requirements.
 * Rules are evaluated against job context fields; matching rules are injected into the RAG prompt.
 */

/** @param {string|number} v */
const yearBefore = (v, cutoff) => {
  const n = parseInt(v);
  return !isNaN(n) && n < cutoff;
};

const textMatch = (v, pattern) => v && pattern.test(String(v));

export default [
  // ── Safety Alerts ──────────────────────────────────────
  {
    id: 'pre-1978-wiring',
    category: 'safety',
    condition: (ctx) => yearBefore(ctx.buildingAge, 1978),
    title: 'Pre-1978 Wiring Hazards',
    content: `Buildings from before 1978 commonly have:
• Cloth-wrapped NM cable (brittle insulation, exposed conductors)
• Ungrounded 2-wire circuits — bootleg grounds are a common illegal "fix"
• Potential aluminum branch-circuit wiring (1965-1975 era) — requires approved AL/CU connectors or COPALUM repairs
• Federal Pacific Stab-Lok or Zinsco panels — known fire hazards, recommend full panel replacement
Always inspect panel brand and conductor type before quoting any work.`,
  },
  {
    id: 'aluminum-wiring',
    category: 'safety',
    condition: (ctx) => textMatch(ctx.wireTypes, /aluminum|al\b/i) || textMatch(ctx.panelInfo, /aluminum/i),
    title: 'Aluminum Branch Wiring',
    content: `Aluminum branch wiring requires special handling per NEC 110.14:
• Use only CO/ALR or AL/CU rated devices and connectors
• COPALUM crimp connections are the gold standard repair
• AlumiConn connectors are an acceptable alternative
• Never use wire nuts rated only for copper on aluminum conductors
• Check for signs of overheating at ALL connections (discoloration, melting)
• Each connection point is a potential failure — quote thorough inspection time.`,
  },
  {
    id: 'federal-pacific-zinsco',
    category: 'safety',
    condition: (ctx) => textMatch(ctx.panelInfo, /federal\s*pacific|stab.?lok|zinsco|sylvania/i),
    title: 'Recalled/Hazardous Panel',
    content: `Federal Pacific Stab-Lok and Zinsco panels have documented failure rates of 25-60% — breakers fail to trip under overcurrent.
• Recommend FULL panel replacement to customer — not just breaker swaps
• Cannot install any new circuits in these panels per most AHJ interpretations
• Document the panel condition with photos for the customer's insurance
• Some insurers will not cover homes with these panels.`,
  },

  // ── Code Requirements ──────────────────────────────────
  {
    id: 'afci-gfci-requirements',
    category: 'code',
    condition: (ctx) => textMatch(ctx.equipmentNoted, /kitchen|bath|garage|laundry|outdoor|basement|crawl/i) ||
                        textMatch(ctx.additionalNotes, /kitchen|bath|garage|laundry|outdoor|basement/i),
    title: 'AFCI/GFCI Requirements (NEC 2023)',
    content: `NEC 2023 significantly expanded protection requirements:
• **GFCI (210.8)**: All 125V-250V, 50A or less receptacles in kitchens, bathrooms, garages, outdoors, basements, crawl spaces, laundry, boathouses, bathtubs/showers, sinks
• **AFCI (210.12)**: Required for ALL 120V 15A/20A branch circuits in dwelling units (kitchens, family rooms, dining rooms, living rooms, bedrooms, sun rooms, closets, hallways, laundry, similar)
• Dual-function AFCI/GFCI breakers simplify compliance for new circuits
Check with the local AHJ — some jurisdictions lag behind the latest NEC cycle.`,
  },
  {
    id: 'service-upgrade-load-calc',
    category: 'code',
    condition: (ctx) => textMatch(ctx.serviceSize, /upgrade|100|60|change/i) ||
                        textMatch(ctx.additionalNotes, /service upgrade|panel upgrade|ev charger|car charger|heat pump/i),
    title: 'Service Upgrade — Load Calculation Required',
    content: `Service upgrades and heavy-load additions require NEC Article 220 load calculations:
• NEC 220.82 (Optional method) or 220.83 (Existing dwelling) for residential
• Standard method: 220.40-220.55 for itemized calculations
• EV charger loads: typically 40A-60A (Level 2), must be factored into service capacity
• Heat pump loads: verify air handler + compressor combined draw
• Document the calculation — AHJs increasingly require written load calcs on permits
• 200A service is the current residential standard — recommend upgrading from 100A/150A when practical.`,
  },
  {
    id: 'grounding-bonding',
    category: 'practice',
    condition: (ctx) => textMatch(ctx.additionalNotes, /ground|bond|electrode|rod|water pipe/i) ||
                        textMatch(ctx.panelInfo, /sub.?panel|sub\s*panel/i),
    title: 'Grounding & Bonding Best Practices',
    content: `Common grounding issues to verify:
• Main bonding jumper installed at service equipment (NEC 250.28)
• Grounding electrode system: two ground rods minimum 6' apart, or ground rod + water pipe (NEC 250.52)
• Metallic water pipe bond within 5' of entry (NEC 250.52(A)(1))
• Sub-panels: neutral and ground MUST be separated (NEC 250.32)
• CSST gas line bonding per manufacturer specs and NEC 250.104(B)
• Verify bonding at all metallic piping systems.`,
  },

  // ── Best Practices ─────────────────────────────────────
  {
    id: 'photo-documentation',
    category: 'practice',
    condition: () => true, // Always applicable
    title: 'Documentation Best Practices',
    content: `Professional documentation protects the contractor:
• Photo BEFORE opening any walls/ceilings — document existing conditions
• Photo all rough-in work BEFORE covering — proof of code compliance
• Photo panel schedules and wire labeling
• Keep a copy of the load calculation with the job file
• Note any existing code violations found — even if not part of the scope.`,
  },
];
