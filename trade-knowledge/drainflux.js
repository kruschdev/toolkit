/**
 * DrainFlux (Plumbing) — Trade-specific best practices, safety alerts, and code requirements.
 */

const yearBefore = (v, cutoff) => { const n = parseInt(v); return !isNaN(n) && n < cutoff; };
const textMatch = (v, pattern) => v && pattern.test(String(v));

export default [
  // ── Safety Alerts ──────────────────────────────────────
  {
    id: 'pre-1970-pipes',
    category: 'safety',
    condition: (ctx) => yearBefore(ctx.buildingAge, 1970),
    title: 'Pre-1970 Piping Hazards',
    content: `Buildings from before 1970 commonly have:
• Galvanized steel supply lines — internal corrosion restricts flow, zinc leaches into water
• Lead solder joints on copper (banned 1986) — test water for lead levels
• Cast iron DWV — check for internal scale buildup and bellied sections
• Clay sewer laterals — prone to root intrusion and joint separation
• Drum traps — not code-compliant, replace with P-traps
Recommend scoping the sewer lateral and pressure-testing supply lines before quoting major work.`,
  },
  {
    id: 'lead-solder',
    category: 'safety',
    condition: (ctx) => yearBefore(ctx.buildingAge, 1986) || textMatch(ctx.pipeType, /copper/i),
    title: 'Lead Solder Risk (Pre-1986 Copper)',
    content: `Lead solder was banned by the Safe Drinking Water Act in 1986:
• All copper joints in pre-1986 homes should be assumed to contain 50/50 lead-tin solder
• When cutting into existing copper, note solder appearance (dull gray = likely lead)
• Water testing is recommended, especially if young children or pregnant women occupy the home
• When re-soldering, use only lead-free solder (95/5 tin-antimony or similar).`,
  },

  // ── Code Requirements ──────────────────────────────────
  {
    id: 'fixture-unit-sizing',
    category: 'code',
    condition: (ctx) => textMatch(ctx.fixtureTypes, /toilet|water closet|lavatory|sink|tub|shower|washer|dishwasher/i),
    title: 'Fixture Unit Sizing Requirements',
    content: `Drain and supply sizing MUST be calculated from fixture unit values:
• **IPC**: Uses DFU (Drainage Fixture Units) per IPC Table 709.1
• **UPC**: Uses DFU values per UPC Table 702.1 — values differ from IPC
• Water closet (floor): 4 DFU (IPC) vs 4 DFU (UPC)
• Lavatory: 1 DFU both codes
• Kitchen sink: 2 DFU (IPC) vs 1.5 DFU (UPC)
• Water supply sizing: WSFU from IPC Table 604.3 or UPC Table 610.4
Never add fixtures without verifying the existing drain/vent/supply can handle the additional load.`,
  },
  {
    id: 'venting-requirements',
    category: 'code',
    condition: (ctx) => textMatch(ctx.ventType, /aav|air admittance|cheater|studor/i) ||
                        textMatch(ctx.additionalNotes, /vent|no vent|missing vent/i),
    title: 'Venting Requirements',
    content: `Every fixture trap must be vented to prevent siphonage:
• Individual, common, and circuit venting per IPC 904-911 or UPC 901-906
• AAVs (Air Admittance Valves) are allowed by IPC 917 but prohibited by some jurisdictions
• AAVs cannot serve as the ONLY vent in a building — at least one vent must extend through the roof
• Maximum developed length from trap to vent depends on pipe diameter (IPC Table 906.1)
• Wet venting is allowed under specific conditions — requires careful sizing
Check local amendments — many western states under UPC have stricter AAV restrictions.`,
  },
  {
    id: 'backflow-prevention',
    category: 'code',
    condition: (ctx) => textMatch(ctx.additionalNotes, /backflow|irrigation|boiler|cross.?connect/i) ||
                        textMatch(ctx.waterHeaterType, /tankless|boiler/i),
    title: 'Backflow Prevention',
    content: `Cross-connection control is a critical health/safety requirement:
• Atmospheric vacuum breakers (AVB) for hose bibbs and irrigation
• Reduced pressure zone (RPZ) assemblies for high-hazard connections
• Water heater expansion tanks required when backflow preventers are installed (closed system)
• Local water authority may require annual testing of backflow assemblies
• Commercial installations typically require RPZ or double-check assemblies.`,
  },

  // ── Best Practices ─────────────────────────────────────
  {
    id: 'water-heater-installation',
    category: 'practice',
    condition: (ctx) => textMatch(ctx.waterHeaterType, /./) || textMatch(ctx.additionalNotes, /water heater|hot water/i),
    title: 'Water Heater Installation Standards',
    content: `Common water heater installation requirements:
• Expansion tank required if any backflow preventer creates a closed system
• Seismic strapping required in zones 3+ (and recommended everywhere)
• T&P relief valve discharge: terminate 6" above floor, cannot be threaded/capped/reduced
• Gas water heaters: verify BTU rating matches gas line capacity
• Tankless: verify gas line capacity — often requires upsizing from 1/2" to 3/4"
• Platform requirement for garage installations (18" above floor for gas units)
• Pan and drain required for indoor/attic installations per most jurisdictions.`,
  },
  {
    id: 'camera-scope-recommendation',
    category: 'practice',
    condition: (ctx) => textMatch(ctx.drainType, /sewer|main|lateral/i) ||
                        textMatch(ctx.additionalNotes, /slow drain|backup|root|sewer/i),
    title: 'Sewer Camera Scope Recommended',
    content: `Before quoting sewer-related work:
• Camera the sewer lateral to identify the actual problem (roots, bellied sections, offset joints, breaks)
• Locate the cleanout — note if one needs to be installed (code requires accessible cleanouts)
• Check the connection type at the main (clay to PVC transitions are common failure points)
• Measure the footage to the main for accurate quoting
• Document findings with video for the customer — builds trust and justifies the repair scope.`,
  },
];
