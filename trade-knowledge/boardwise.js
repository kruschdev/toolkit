/**
 * BoardWise (Drywall) — Trade-specific best practices, safety alerts, and code requirements.
 */

const textMatch = (v, pattern) => v && pattern.test(String(v));

export default [
  // ── Safety Alerts ──────────────────────────────────────
  {
    id: 'dust-exposure',
    category: 'safety',
    condition: () => true,
    title: 'Drywall Dust & Joint Compound Safety',
    content: `Drywall dust exposure requires proper controls:
• Sanding generates respirable particles — N95 respiratory protection minimum
• Joint compound dust contains silica (in some formulations) — check SDS
• Wet sanding reduces airborne dust by 80%+ — preferred method for occupied spaces
• Vacuum sanders with HEPA filtration: best practice for remodel work
• Contain the workspace: plastic sheeting over doorways, HVAC return vents sealed
• Pre-mixed vs. hot mud (setting compound): hot mud is harder to sand — plan accordingly
• Cleanup: HEPA vacuum first, then damp wipe — never dry sweep drywall dust.`,
  },

  // ── Code Requirements ──────────────────────────────────
  {
    id: 'fire-rated-assemblies',
    category: 'code',
    condition: (ctx) => textMatch(ctx.fireRating, /yes|true|required|1.?hr|2.?hr/i) ||
                        textMatch(ctx.additionalNotes, /fire|garage.*wall|party.*wall|separation|rated/i),
    title: 'Fire-Rated Assembly Requirements',
    content: `Fire-rated walls and ceilings have strict construction requirements:
• **Type X drywall**: 5/8" Type X required for fire-rated assemblies (not regular 5/8")
• **Garage-to-dwelling**: minimum 1/2" drywall on garage side (1-hour rated assembly at sleeping areas)
• **Party walls (multi-family)**: typically 1-hour or 2-hour fire rating — see UL Design Number
• **Screw spacing**: fire-rated assemblies have specific fastener spacing (typically 12" OC walls, 12" OC ceilings)
• **Joint treatment**: all joints must be taped and finished — no gaps or unfilled screw holes
• **Penetrations**: all penetrations through fire-rated assemblies must be properly fire-stopped
• Use only listed assemblies (UL, GA, or equivalent) — substituting materials voids the rating.`,
  },
  {
    id: 'moisture-resistant-areas',
    category: 'code',
    condition: (ctx) => textMatch(ctx.moistureArea, /yes|true|bath|shower|kitchen|laundry/i) ||
                        textMatch(ctx.additionalNotes, /bath|shower|wet|moisture|tub|tile/i),
    title: 'Moisture-Resistant Board Requirements',
    content: `Wet and high-moisture areas require specific board types:
• **Standard drywall**: NEVER use in shower/tub surrounds or direct water exposure areas
• **Green board (moisture-resistant)**: acceptable for bathrooms AWAY from direct water contact
• **Cement board** (Hardiebacker, Durock): required behind tile in shower/tub surrounds
• **KBRS/foam board**: waterproof alternative substrate for shower walls
• **Behind tile**: cement board or equivalent water-resistant substrate per IRC R702.4
• Mold-resistant drywall (purple board): recommended for ALL bathrooms, kitchens, and laundry rooms
• Vapor barrier considerations vary by climate zone — check local requirements.`,
  },

  // ── Best Practices ─────────────────────────────────────
  {
    id: 'finish-levels',
    category: 'practice',
    condition: (ctx) => textMatch(ctx.finishLevel, /[0-5]|level/i) ||
                        textMatch(ctx.additionalNotes, /finish.*level|smooth|texture|knockdown|orange.*peel/i),
    title: 'GA Finish Levels (GA-214)',
    content: `Gypsum Association finish levels define expectations and scope:
• **Level 0**: no finishing — fire-rated assemblies hidden above ceilings only
• **Level 1**: tape embedded in compound only, no coating — plenum areas, concealed spaces
• **Level 2**: tape + one coat of compound — where tile or heavy texture will cover
• **Level 3**: tape + two coats — where heavy texture (knockdown, orange peel) will be applied
• **Level 4**: tape + three coats — standard for most painting applications (flat/eggshell)
• **Level 5**: tape + three coats + skim coat OR spray applied surfacer — required for gloss/semi-gloss paint, critical lighting, and smooth wall expectations
• Specify the finish level in the contract — prevents disputes over "smooth enough."`,
  },
  {
    id: 'hanging-best-practices',
    category: 'practice',
    condition: () => true,
    title: 'Drywall Hanging Standards',
    content: `Professional hanging techniques prevent finishing problems:
• Hang ceilings first, then walls (ceiling panels rest on wall panel edges)
• Horizontal orientation for walls: reduces total linear feet of joints
• Stagger joints: never align joints on adjacent surfaces — creates a stress concentration
• Screw spacing: 16" OC on ceilings, 16" OC on walls (12" OC for fire-rated)
• Screws should dimple the surface without breaking the paper face
• Gaps between panels: maximum 1/8" — wider gaps require backer and additional finishing
• Back-block butt joints that don't fall on framing — prevents ridging at flat joints
• Use adhesive (construction adhesive on studs) in addition to screws for reduced screw pops.`,
  },
];
