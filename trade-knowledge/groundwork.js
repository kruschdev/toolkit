/**
 * GroundWork (Landscaping) — Trade-specific best practices, safety alerts, and code requirements.
 */

const textMatch = (v, pattern) => v && pattern.test(String(v));

export default [
  // ── Safety Alerts ──────────────────────────────────────
  {
    id: 'utility-locate',
    category: 'safety',
    condition: (ctx) => textMatch(ctx.projectType, /excavat|dig|trench|grade|patio|fence|drain/i) ||
                        textMatch(ctx.additionalNotes, /dig|trench|excavat|underground|utilities|bore/i),
    title: 'Utility Locating (Call 811)',
    content: `All excavation work requires utility locating — no exceptions:
• **Call 811** minimum 48-72 hours before any digging (state-specific timing)
• Utility marks are valid for 10-30 days (jurisdiction-dependent)
• Tolerance zone: typically 18-24" on each side of markings — hand-dig within this zone
• Private utilities (sprinkler lines, low-voltage lighting, septic) are NOT marked by 811
• Use a private utility locator for properties with known private underground systems
• Hitting a gas line is a life-threatening emergency — hitting fiber optic costs thousands
• Document the locate ticket number in the job file — proof of compliance.`,
  },
  {
    id: 'trench-safety',
    category: 'safety',
    condition: (ctx) => textMatch(ctx.projectType, /drain|french.*drain|trench|retaining|excavat/i) ||
                        textMatch(ctx.additionalNotes, /trench|excavat|deep|5.*feet|6.*feet/i),
    title: 'Trench & Excavation Safety (OSHA)',
    content: `OSHA 29 CFR 1926.650-652 — trench safety requirements:
• Trenches 5+ feet deep: require sloping, shoring, or trench box
• Trenches 20+ feet: require engineered sloping/shoring design
• Competent person: must inspect trenches daily and after any rain event
• No heavy equipment within 2 feet of trench edge
• Spoil pile: minimum 2 feet back from the trench edge
• Egress: ladder or ramp within 25 feet of all workers in trenches 4+ feet deep
• Residential landscape trenches (irrigation, drainage) are typically shallow, but NEVER assume.`,
  },

  // ── Code Requirements ──────────────────────────────────
  {
    id: 'grading-drainage',
    category: 'code',
    condition: (ctx) => textMatch(ctx.gradeCondition, /.+/) ||
                        textMatch(ctx.additionalNotes, /grade|drain|slope|water|flood|wet.*yard|standing/i),
    title: 'Grading & Drainage Requirements (IRC R401.3)',
    content: `Proper grading is a code requirement to protect structures:
• Minimum 6" fall in the first 10 feet away from the foundation (1/2" per foot)
• Where lot lines or site conditions don't allow: 5% slope minimum for the first 10 feet via swales or drains
• Impervious surfaces (patios, walkways): must slope AWAY from the structure (min 1/4" per foot)
• Downspout discharge: minimum 6 feet from foundation (10 feet preferred)
• French drains: 1% minimum slope (1/8" per foot), filter fabric around gravel, perforated pipe at bottom
• Never direct water toward neighboring properties — liability issue
• Document pre-work and post-work drainage conditions with photos.`,
  },
  {
    id: 'retaining-wall-engineering',
    category: 'code',
    condition: (ctx) => textMatch(ctx.projectType, /retaining|wall|terrace/i) ||
                        textMatch(ctx.additionalNotes, /retaining|wall.*height|4.*feet|surcharge/i),
    title: 'Retaining Wall Requirements',
    content: `Retaining walls have structural and permit requirements:
• **Under 4 feet (exposed height)**: typically permit-exempt, but follow manufacturer engineered designs
• **4 feet or more**: structural engineering and building permit required in most jurisdictions
• Surcharge loads (driveways, structures above the wall) reduce the height threshold — engineering may be required even under 4 feet
• Segmental retaining walls: follow NCMA (National Concrete Masonry Association) design guides
• Geogrid reinforcement: required for walls over manufacturer's gravity wall height limit
• Drainage: gravel backfill + perforated drain pipe at the base — CRITICAL for wall longevity
• Global stability analysis: required for walls near slopes, structures, or property lines.`,
  },

  // ── Best Practices ─────────────────────────────────────
  {
    id: 'irrigation-backflow',
    category: 'practice',
    condition: (ctx) => textMatch(ctx.irrigationType, /.+/) ||
                        textMatch(ctx.additionalNotes, /irrigat|sprinkler|drip|water.*system/i),
    title: 'Irrigation System Standards',
    content: `Irrigation systems require proper design and code compliance:
• **Backflow prevention**: required by code at the point of connection to potable water
• Pressure vacuum breaker (PVB): most common residential — install 12" above highest head
• Reduced pressure zone (RPZ): required in some jurisdictions, especially commercial
• Zone sizing: calculate GPM by adding all heads in a zone — don't exceed available flow
• Head spacing: head-to-head coverage (matched precipitation)
• Drip irrigation: preferred for plant beds — reduces water waste by 30-50%
• Winterization: blow-out with compressed air (40-80 PSI, NOT to exceed 80) in freeze zones
• Smart controllers (weather-based): many jurisdictions offer rebates.`,
  },
  {
    id: 'plant-selection',
    category: 'practice',
    condition: (ctx) => textMatch(ctx.climateZone, /.+/) ||
                        textMatch(ctx.softscapeType, /plant|shrub|tree|perenni|annual/i),
    title: 'Plant Selection & Placement',
    content: `Professional plant selection prevents costly replacements:
• Match plants to the USDA hardiness zone AND local microclimate
• Sun exposure: full sun (6+ hrs), part shade (3-6 hrs), full shade (<3 hrs)
• Mature size: space for full growth — don't plant trees 5 feet from foundations
• Root clearance: trees minimum 15-20 feet from foundations, 10 feet from sewer lines
• Invasive species: check local lists — some jurisdictions ban specific species
• Native plants: lower maintenance, adapted to local rainfall/soil, support pollinators
• Soil amendment: test soil pH and amend BEFORE planting — saves time and plant losses
• Mulch: 2-4 inches, keep 3 inches away from plant stems/tree trunks (prevents rot).`,
  },
];
