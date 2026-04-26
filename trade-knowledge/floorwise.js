/**
 * FloorWise (Flooring) — Trade-specific best practices, safety alerts, and code requirements.
 */

const yearBefore = (v, cutoff) => { const n = parseInt(v); return !isNaN(n) && n < cutoff; };
const textMatch = (v, pattern) => v && pattern.test(String(v));

export default [
  // ── Safety Alerts ──────────────────────────────────────
  {
    id: 'asbestos-risk',
    category: 'safety',
    condition: (ctx) => yearBefore(ctx.buildingAge, 1985) ||
                        textMatch(ctx.existingFlooring, /9.?x.?9|vinyl.*tile|vat|linoleum|mastic/i),
    title: 'Asbestos-Containing Materials',
    content: `Flooring materials in pre-1985 buildings may contain asbestos:
• 9"x9" floor tiles: high probability of asbestos content
• Black mastic adhesive ("cutback" adhesive): almost certainly contains asbestos
• Sheet vinyl backing: some backings contain chrysotile asbestos
• DO NOT sand, scrape, or demo without testing — asbestos testing costs $25-50/sample
• Encapsulation (installing over) is acceptable if the surface is flat and stable
• If removal is required: licensed asbestos abatement contractor only
• Document with photos and test results — liability protection for the contractor.`,
  },

  // ── Code Requirements ──────────────────────────────────
  {
    id: 'moisture-testing',
    category: 'code',
    condition: (ctx) => textMatch(ctx.flooringType, /hardwood|engineered|laminate|lvp|lvt|vinyl.*plank|bamboo/i) ||
                        textMatch(ctx.subfloorType, /concrete|slab/i) ||
                        textMatch(ctx.moistureLevel, /.+/),
    title: 'Moisture Testing — Mandatory Before Installation',
    content: `Moisture testing is required by virtually all flooring manufacturers for warranty coverage:
• **Concrete slabs**: calcium chloride test (ASTM F1869) — max 3-5 lbs/1000sqft/24hrs depending on product
• **Concrete slabs**: in-situ RH probe test (ASTM F2170) — max 75-85% RH depending on product
• **Wood subfloors**: pin-type moisture meter — must be 6-12% MC, within 2-4% of flooring MC
• Test in multiple locations, especially near exterior walls and bathrooms
• New concrete: wait minimum 30 days per inch of thickness before testing
• Document ALL readings with photos of meter — this is your warranty protection
• Moisture mitigation systems available but add $1-3/sqft when needed.`,
  },
  {
    id: 'subfloor-flatness',
    category: 'code',
    condition: (ctx) => textMatch(ctx.subfloorCondition, /uneven|wavy|dip|hump|out.?of.?flat/i) ||
                        textMatch(ctx.additionalNotes, /level|flat|self.?level/i),
    title: 'Subfloor Flatness Standards',
    content: `Flooring manufacturers specify flatness tolerances:
• Standard requirement: 3/16" variance over 10 feet (most products)
• Premium products (large-format tile, rigid LVP): 1/8" over 10 feet
• Use a 10-foot straightedge, checking in multiple directions
• High spots: grind down with concrete grinder or sand wood subfloor
• Low spots: fill with floor patch compound (NOT thinset unless installing tile)
• Self-leveling underlayment for widespread unevenness: $1-3/sqft material cost
• Addressing flatness BEFORE installation prevents callbacks (click-lock gaps, hollow spots, cracked tile).`,
  },

  // ── Best Practices ─────────────────────────────────────
  {
    id: 'radiant-heat-compatibility',
    category: 'practice',
    condition: (ctx) => textMatch(ctx.radiantHeat, /yes|true|radiant|heated/i) ||
                        textMatch(ctx.additionalNotes, /radiant|heated.*floor|floor.*heat/i),
    title: 'Radiant Heat Flooring Requirements',
    content: `Radiant heat systems have specific flooring requirements:
• **Compatible**: tile/stone (best conductor), engineered hardwood (check max temp), LVP/LVT (check product specs)
• **NOT recommended**: solid hardwood (expansion/contraction), most laminates (poor conductivity, may delaminate)
• Maximum surface temperature: typically 82-85°F (product-specific)
• System must be ON for 1-2 weeks before flooring installation, then OFF 24hrs before install
• Gradual temperature ramp-up after installation (5°F per day maximum)
• R-value matters: underlayment + flooring combined R-value should not exceed manufacturer's maximum
• Thermal break underlayment defeats the purpose — use thin or no underlayment over radiant.`,
  },
  {
    id: 'acclimation-standards',
    category: 'practice',
    condition: (ctx) => textMatch(ctx.flooringType, /hardwood|solid|engineered|bamboo|laminate/i),
    title: 'Acclimation Requirements',
    content: `Wood-based flooring requires proper acclimation:
• Acclimate in the installation space for 3-7 days minimum (manufacturer-specific)
• HVAC system must be operating at normal conditions during acclimation
• Break open all boxes and cross-stack for airflow — don't just leave sealed boxes on site
• Ideal conditions: 60-80°F, 30-50% RH (similar to post-occupancy conditions)
• Engineered hardwood: shorter acclimation needed than solid (more dimensionally stable)
• Measure moisture content of flooring AND subfloor — both must be within spec
• Skipping acclimation is the #1 cause of flooring callbacks (gaps, buckling, cupping).`,
  },
  {
    id: 'transition-planning',
    category: 'practice',
    condition: () => true,
    title: 'Transition & Detail Planning',
    content: `Professional finishing details separate quality installers:
• Plan ALL transitions before starting: room-to-room, flooring-to-tile, flooring-to-carpet
• T-molding: required at doorways between floating floors in separate rooms
• Reducer strips: flooring to lower surfaces
• Stair nosing: must be specific to the flooring product for proper fit
• Expansion gaps: 1/4"-3/8" at ALL walls, columns, and transitions (covered by baseboard/molding)
• Undercut door casings and jambs rather than notching flooring around them
• Order transitions at the same time as flooring to ensure batch/color match.`,
  },
];
