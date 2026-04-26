/**
 * RidgeLine (Roofing) — Trade-specific best practices, safety alerts, and code requirements.
 */

const textMatch = (v, pattern) => v && pattern.test(String(v));

export default [
  // ── Safety Alerts ──────────────────────────────────────
  {
    id: 'fall-protection',
    category: 'safety',
    condition: () => true,
    title: 'Fall Protection Requirements',
    content: `OSHA 29 CFR 1926.501 — fall protection required at 6 feet or more:
• **Residential exception**: allows alternative fall protection methods (slide guards, safety nets)
• Personal fall arrest systems: full-body harness, lanyard, roof anchor rated for 5,000 lbs
• Roof anchors: temporary or permanent, positioned to limit fall distance
• Steep-slope roofs (>4:12): additional precautions required — toe boards, roof jacks
• Never work alone on a roof — emergency rescue plan required
• Wet, icy, or high-wind conditions: postpone work — no exceptions
• Properly set up scaffold or ladder access — don't climb on unstable surfaces.`,
  },
  {
    id: 'existing-asbestos',
    category: 'safety',
    condition: (ctx) => textMatch(ctx.existingMaterial, /asbestos|transit|cement.*shingle|old/i) ||
                        textMatch(ctx.additionalNotes, /asbestos|old.*roof|original/i),
    title: 'Asbestos-Containing Roofing Materials',
    content: `Some older roofing materials contain asbestos:
• Cement-asbestos shingles (transite): common in 1920s-1970s construction
• Asphalt shingles from before 1980 MAY contain asbestos fibers
• Roofing felt/tar paper: some vintage products contained asbestos
• DO NOT break, cut, or power-wash suspected asbestos materials
• Testing costs $25-50/sample — always test before tear-off
• If confirmed: licensed abatement or regulated work practices with proper PPE
• Overlay (installing over) may be an option if structure supports the weight.`,
  },

  // ── Code Requirements ──────────────────────────────────
  {
    id: 'ice-water-shield',
    category: 'code',
    condition: (ctx) => textMatch(ctx.climateZone, /cold|north|snow|ice|[4-8]/i) ||
                        textMatch(ctx.additionalNotes, /ice dam|ice.*shield|cold.*climate/i),
    title: 'Ice & Water Shield Requirements',
    content: `IRC R905.1.2 requires ice barrier underlayment in areas with mean January temp ≤ 25°F:
• Install from the eave edge to a point 24" inside the exterior wall line (minimum)
• Valleys: full coverage recommended, minimum 36" wide centered on valley
• Around penetrations: pipes, skylights, chimneys — extend 24" in all directions
• Low-slope areas (<4:12): consider double coverage or fully adhered membrane
• Self-adhering ice and water shield (peel-and-stick) is the standard product
• Verify local requirements — some jurisdictions require extended coverage
• Do NOT install over existing shingles — must be applied to clean, dry deck.`,
  },
  {
    id: 'wind-uplift-rating',
    category: 'code',
    condition: (ctx) => textMatch(ctx.climateZone, /coast|hurricane|wind|tropical/i) ||
                        textMatch(ctx.additionalNotes, /wind|hurricane|storm|uplift/i),
    title: 'Wind Uplift & Shingle Ratings',
    content: `High-wind zones require specific roofing product ratings:
• ASTM D7158 Class H: rated for 150 mph sustained wind
• ASTM D3161 Class F: rated for 110 mph
• Enhanced nailing: 6 nails per shingle (instead of 4) in high-wind zones
• Starter strip: required at eaves AND rakes in high-wind areas
• Hip and ridge caps: high-profile caps rated for wind resistance
• Metal roofing: verify wind uplift rating matches design wind speed for the location
• Florida Building Code: requires specific product approvals (Miami-Dade NOA).`,
  },

  // ── Best Practices ─────────────────────────────────────
  {
    id: 'ventilation-balance',
    category: 'practice',
    condition: (ctx) => textMatch(ctx.ventilationType, /.+/) ||
                        textMatch(ctx.additionalNotes, /ventilat|ridge.*vent|soffit|attic/i),
    title: 'Attic Ventilation Balance',
    content: `Proper attic ventilation prevents moisture damage and extends roof life:
• IRC R806: minimum 1/150 ratio (1 sqft NFA per 150 sqft attic floor area)
• With balanced intake/exhaust: allowed to reduce to 1/300 ratio
• **Intake**: soffit vents (continuous or individual) — must be unobstructed by insulation
• **Exhaust**: ridge vent (preferred), box vents, or power vents — pick ONE type
• DO NOT mix ridge vents with powered vents — they create short circuits
• Verify intake ≥ exhaust (60/40 to 50/50 split ideal)
• Hot roofs (unvented assemblies): spray foam insulation directly to underside of deck — different code path (IRC R806.5).`,
  },
  {
    id: 'flashing-details',
    category: 'practice',
    condition: () => true,
    title: 'Critical Flashing Details',
    content: `Flashing failures are the #1 cause of roof leaks:
• **Step flashing**: individual L-shaped pieces at wall-to-roof intersections, woven with each course
• **Counter flashing**: embedded in mortar joints or reglet cuts, overlaps step flashing
• **Valley flashing**: closed-cut, open (metal), or woven — open metal is most durable
• **Pipe boots**: match pipe size, use high-quality EPDM or silicone — cheap boots fail in 5-7 years
• **Chimney cricket**: required for chimneys >30" wide on the uphill side (IRC R903.2.2)
• **Drip edge**: required at eaves AND rakes (IRC R905.2.8.5)
• Inspect and replace all flashing during re-roof — never reuse old flashing.`,
  },
];
