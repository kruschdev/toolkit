/**
 * FrameUp (Framing) — Trade-specific best practices, safety alerts, and code requirements.
 */

const textMatch = (v, pattern) => v && pattern.test(String(v));

export default [
  // ── Safety Alerts ──────────────────────────────────────
  {
    id: 'load-bearing-engineering',
    category: 'safety',
    condition: (ctx) => textMatch(ctx.loadBearing, /yes|true|load/i) ||
                        textMatch(ctx.structuralType, /removal|modify|open.*concept|header/i) ||
                        textMatch(ctx.additionalNotes, /load.?bearing|remove.*wall|open.*up/i),
    title: 'Load-Bearing Wall Modifications',
    content: `Modifying or removing load-bearing walls REQUIRES engineering:
• A licensed structural engineer must design the replacement beam/header system
• Temporary shoring is required before any load-bearing wall work begins
• Engineered drawings must be submitted with the permit application
• Point loads from headers must transfer to the foundation — verify path of load
• PSL/LVL/glulam beams are sized by the engineer — do not substitute without approval
• Post-and-beam connections require specific hardware (Simpson strong-tie or equivalent)
• This is non-negotiable — structural failures can be catastrophic and fatal.`,
  },

  // ── Code Requirements ──────────────────────────────────
  {
    id: 'seismic-wind-requirements',
    category: 'code',
    condition: (ctx) => textMatch(ctx.buildingCode, /seismic|wind|hurricane|coastal|flood/i) ||
                        textMatch(ctx.additionalNotes, /seismic|hurricane|wind.*zone|strap|hold.?down/i),
    title: 'Seismic & High-Wind Requirements',
    content: `High-wind and seismic zones have additional framing requirements (IRC R602.10):
• **Hurricane straps**: connect rafters/trusses to wall top plates (Simpson H2.5A or equivalent)
• **Hold-down hardware**: anchor shear wall ends to foundation (Simpson HDU series)
• **Shear panels**: specific nailing patterns required (closer spacing than standard)
• **Continuous load path**: every connection from roof to foundation must be engineered
• **Wind speed design**: IRC Table R301.2(1) defines design wind speeds by location
• Seismic Design Category D/E/F: bracing amounts increase significantly
• Verify local amendments — coastal areas often exceed IRC minimum requirements.`,
  },
  {
    id: 'fire-blocking',
    category: 'code',
    condition: (ctx) => textMatch(ctx.wallType, /exterior|interior|partition/i) ||
                        textMatch(ctx.additionalNotes, /fire.?block|fire.?stop|draft.?stop/i),
    title: 'Fire Blocking & Draft Stopping (IRC R602.8)',
    content: `Fire blocking is required to prevent fire/smoke spread in concealed spaces:
• At ceiling and floor levels in walls (including balloon-frame buildings)
• At soffits, drop ceilings, and cove ceilings
• At the interconnection of concealed vertical and horizontal spaces
• At openings around vents, pipes, and ducts passing through floors/walls
• Materials: 2x lumber, 3/4" plywood, 1/2" drywall, mineral wool, or approved caulk/foam
• Balloon framing (pre-1940s): particularly critical — no horizontal fire breaks between floors
• Failure to fire block is a common inspection rejection item.`,
  },
  {
    id: 'stud-spacing-sheathing',
    category: 'code',
    condition: (ctx) => textMatch(ctx.studSpacing, /.+/) || textMatch(ctx.sheathingType, /.+/),
    title: 'Stud Spacing & Sheathing Standards',
    content: `Stud spacing and sheathing are interdependent requirements:
• **16" OC**: standard for load-bearing walls and most exterior walls
• **24" OC**: allowed for non-load-bearing interior partitions and some exterior walls with proper engineering
• **Sheathing**: OSB or plywood structural sheathing (7/16" minimum for wall sheathing)
• Nail spacing for sheathing: 6" on edges, 12" in field (closer in high-wind areas)
• Engineered shear panels: follow manufacturer's specific nailing schedule exactly
• Rim board/band joist must be properly nailed and sealed for air infiltration
• Doubled studs at openings, corners, and intersecting walls (or approved alternatives like drywall clips).`,
  },

  // ── Best Practices ─────────────────────────────────────
  {
    id: 'rough-opening-sizing',
    category: 'practice',
    condition: (ctx) => textMatch(ctx.additionalNotes, /window|door|opening|header/i) ||
                        textMatch(ctx.headerSize, /.+/),
    title: 'Rough Opening & Header Sizing',
    content: `Correct rough openings prevent costly rework:
• Standard rough opening: window/door width + 1/2" each side + 1/2" top
• Header sizing per IRC Table R602.7 — depends on span, load, and stories above
• Single-story non-load-bearing: no header required (use flat 2x4)
• Two 2x lumber headers: must include 1/2" plywood spacer to match wall depth
• Jack studs (trimmers): support the header — king studs transfer load to sole plate
• Sill plate under windows: cripple studs below at same spacing as wall studs
• Verify header sizes with the plans BEFORE framing — changes after sheathing are expensive.`,
  },
  {
    id: 'lumber-quality',
    category: 'practice',
    condition: () => true,
    title: 'Lumber Quality & Storage',
    content: `Lumber quality directly affects framing accuracy:
• Reject studs with more than 1/4" crown, twist, or bow
• Store lumber flat, off the ground, and covered
• Pressure-treated lumber: required for sill plates, any wood in contact with concrete/masonry
• KD (kiln-dried) lumber: preferred over green — less shrinkage and warping
• Engineered lumber (LVL, I-joist, TJI): follow manufacturer span tables exactly
• Check moisture content: framing lumber should be below 19% MC before enclosing
• Crown all joists and rafters UP — creates a slight arch that settles flat under load.`,
  },
];
