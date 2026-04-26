/**
 * StoneSet (Masonry) — Trade-specific best practices, safety alerts, and code requirements.
 */

const textMatch = (v, pattern) => v && pattern.test(String(v));

export default [
  // ── Safety Alerts ──────────────────────────────────────
  {
    id: 'silica-exposure',
    category: 'safety',
    condition: () => true,
    title: 'Crystalline Silica Exposure (OSHA)',
    content: `OSHA's silica rule (29 CFR 1926.1153) applies to ALL masonry cutting/grinding:
• PEL: 50 µg/m³ as an 8-hour TWA — extremely low threshold
• Wet cutting is the primary engineering control for masonry saws
• Table 1 compliance: follow specific controls per task (wet method + respiratory protection)
• Medical surveillance required for workers exposed above action level (25 µg/m³) for 30+ days/year
• Dust from brick, block, stone, mortar, and concrete ALL contain respirable crystalline silica
• Provide N95 or P100 respirators at minimum — medical fit testing required
• Housekeeping: no dry sweeping — use wet methods or HEPA vacuum.`,
  },
  {
    id: 'structural-wall-engineering',
    category: 'safety',
    condition: (ctx) => textMatch(ctx.wallHeight, /[5-9]|1[0-9]/i) ||
                        textMatch(ctx.wallType, /structural|bearing|retaining|foundation/i) ||
                        textMatch(ctx.additionalNotes, /retaining|structur|foundation|tall/i),
    title: 'Structural/Retaining Wall Engineering',
    content: `Masonry walls over 4 feet (retaining) or structural walls require engineering:
• Retaining walls over 4 feet: structural engineer design required in most jurisdictions
• Foundation walls: rebar placement, grout fill, and footing sizing per engineering
• Vertical rebar: typically #4 or #5 at 24-48" OC (engineer-specified)
• Horizontal bond beam reinforcement: at top of wall and every 4 feet of height
• Lateral support: pilasters or buttresses per TMS 402 (Masonry Standards Joint Committee)
• Footing depth: below frost line, sized by engineer for soil bearing capacity
• Waterproofing: required on below-grade surfaces (damproofing is NOT waterproofing).`,
  },

  // ── Code Requirements ──────────────────────────────────
  {
    id: 'veneer-anchoring',
    category: 'code',
    condition: (ctx) => textMatch(ctx.wallType, /veneer/i) ||
                        textMatch(ctx.stoneType, /brick.*veneer|veneer|thin/i),
    title: 'Veneer Anchoring & Air Space (IRC R703.8)',
    content: `Masonry veneer requires proper anchoring to the backup wall:
• Corrugated metal ties: minimum 22 ga, 7/8" wide, one per 2.67 sqft
• Adjustable ties: required for uncoursed stone (to accommodate irregular heights)
• Air space: minimum 1" between veneer and backup wall (maximum 4.5" with adjustable ties)
• Weep holes: required at base of wall and above all flashing, 33" OC maximum
• Flashing: at base of wall, above windows/doors, at shelf angles
• Shelf angle deflection: maximum L/600 to prevent cracking
• Never fill the air space with mortar droppings — use a drainage mat or mortar net.`,
  },
  {
    id: 'mortar-specifications',
    category: 'code',
    condition: (ctx) => textMatch(ctx.mortarType, /.+/) ||
                        textMatch(ctx.additionalNotes, /mortar|tuck.?point|re.?point/i),
    title: 'Mortar Type Selection (ASTM C270)',
    content: `Correct mortar type prevents premature failure:
• **Type M**: highest compressive strength (2,500 psi) — foundations, retaining walls, below-grade
• **Type S**: high strength (1,800 psi) — exterior walls, structural masonry
• **Type N**: moderate strength (750 psi) — general above-grade, best for soft brick/stone
• **Type O**: low strength (350 psi) — interior, non-load-bearing
• CRITICAL: repointing old brick (pre-1920s) — ALWAYS use Type O or lime-only mortar
• Using Type S or M on soft historic brick WILL cause spalling — the mortar must be softer than the masonry unit
• Portland-lime-sand proportions vary by type — follow ASTM C270 proportions exactly.`,
  },

  // ── Best Practices ─────────────────────────────────────
  {
    id: 'freeze-thaw-protection',
    category: 'practice',
    condition: (ctx) => textMatch(ctx.additionalNotes, /freez|thaw|winter|cold|frost|crack/i) ||
                        textMatch(ctx.existingCondition, /spall|crack|pop|efflor/i),
    title: 'Freeze-Thaw & Cold Weather Masonry',
    content: `Freeze-thaw damage is the leading cause of masonry deterioration:
• New masonry: protect from freezing for minimum 48 hours (windbreaks, heated enclosures)
• Anti-freeze admixtures: reduce freezing point but slow strength gain — follow manufacturer limits
• Efflorescence: white mineral deposits indicate moisture migration — identify and correct the source
• Spalling: surface breaking away from freeze-thaw cycles — repair with compatible mortar and units
• Sealers: use breathable masonry sealer (silane/siloxane) — NOT film-forming sealers that trap moisture
• Never lay masonry on frozen surfaces or with frozen materials.`,
  },
  {
    id: 'control-joints',
    category: 'practice',
    condition: () => true,
    title: 'Control & Expansion Joints',
    content: `Masonry moves — control joints prevent random cracking:
• **CMU (block) walls**: control joints at 25-foot intervals maximum
• **Brick walls**: expansion joints at 20-25 foot intervals (brick EXPANDS over time)
• At changes in wall height, wall thickness, and building corners
• At openings: provide control joints at one or both sides of large openings
• Joint sealant: use flexible backer rod + polyurethane or silicone sealant
• Steel reinforcement must NOT pass through control joints (defeats the purpose)
• Expansion joints in brick: critical and often missed — brick moisture expansion is permanent.`,
  },
];
