/**
 * BrushWise (Painting) — Trade-specific best practices, safety alerts, and code requirements.
 */

const yearBefore = (v, cutoff) => { const n = parseInt(v); return !isNaN(n) && n < cutoff; };
const textMatch = (v, pattern) => v && pattern.test(String(v));

export default [
  // ── Safety Alerts ──────────────────────────────────────
  {
    id: 'lead-paint-rrp',
    category: 'safety',
    condition: (ctx) => yearBefore(ctx.buildingAge, 1978) ||
                        textMatch(ctx.additionalNotes, /lead|rrp|pre.?1978/i),
    title: 'Lead Paint — EPA RRP Rule',
    content: `All renovation work on pre-1978 homes must comply with EPA RRP (Renovation, Repair, and Painting) Rule:
• Firm must be EPA-certified, workers must be RRP-trained
• Required: containment (plastic sheeting), prohibited practices (no open-flame burning, no power sanding without HEPA)
• Post-work cleaning verification with cleaning cloth test
• Fines up to $37,500/day for non-compliance
• Distribute the "Renovate Right" pamphlet to occupants before work begins
• XRF testing or lab analysis can confirm lead presence — don't assume.`,
  },
  {
    id: 'voc-compliance',
    category: 'safety',
    condition: (ctx) => textMatch(ctx.paintType, /oil|alkyd|solvent|lacquer|epoxy/i) ||
                        textMatch(ctx.additionalNotes, /indoor|interior|ventilat/i),
    title: 'VOC Compliance & Ventilation',
    content: `VOC regulations vary by jurisdiction but are increasingly strict:
• EPA federal limit: 250 g/L for flat, 380 g/L for non-flat (architectural coatings)
• SCAQMD Rule 1113 (California standard many adopt): 50 g/L flat, 100 g/L non-flat
• Oil-based/alkyd paints: require adequate ventilation, respiratory protection
• Solvent-based products in occupied spaces: coordinate with building management for ventilation
• Low-VOC and zero-VOC latex products perform well for most interior applications
• Always check the product SDS for specific ventilation requirements.`,
  },

  // ── Code Requirements ──────────────────────────────────
  {
    id: 'fire-rated-assemblies',
    category: 'code',
    condition: (ctx) => textMatch(ctx.buildingType, /commercial|multi.?family|condo|apartment|hotel/i) ||
                        textMatch(ctx.additionalNotes, /fire.?rated|fire.?wall|fire.?door/i),
    title: 'Fire-Rated Assembly Coatings',
    content: `Fire-rated assemblies have specific coating requirements:
• Intumescent coatings: required on exposed structural steel in many commercial applications
• Fire-rated doors: check label — some coatings void the fire rating
• Thickness limits: excessive paint buildup can affect fire ratings on labeled assemblies
• Fire-stop penetrations: verify caulk/sealant ratings match assembly requirements
• Document the coating system used on fire-rated elements — needed for building records.`,
  },

  // ── Best Practices ─────────────────────────────────────
  {
    id: 'surface-prep-standards',
    category: 'practice',
    condition: (ctx) => textMatch(ctx.surfaceCondition, /peel|blister|chalk|mildew|crack|alligator|fail/i) ||
                        textMatch(ctx.prepWork, /.+/),
    title: 'Surface Preparation Standards',
    content: `90% of paint failures are preparation failures:
• **Peeling**: remove all loose paint to a sound edge, feather sand, spot prime with bonding primer
• **Chalking**: power wash, allow to dry, apply chalk-binding primer
• **Mildew**: kill with 3:1 water/bleach solution, rinse thoroughly, allow to dry completely
• **Alligatoring**: complete removal required — this cannot be painted over successfully
• **Bare wood**: prime within 2 weeks of exposure to prevent UV damage to wood fibers
• SSPC (Society for Protective Coatings) standards define prep levels: SP1-SP13 for industrial
• Residential: follow manufacturer's prep instructions — they'll deny warranty claims for poor prep.`,
  },
  {
    id: 'weather-window',
    category: 'practice',
    condition: (ctx) => textMatch(ctx.surfaceType, /exterior|outdoor|outside|siding|deck|fence/i) ||
                        textMatch(ctx.additionalNotes, /exterior|outdoor|season|weather/i),
    title: 'Exterior Weather Requirements',
    content: `Exterior painting has strict weather windows:
• **Temperature**: most latex requires 50°F+ (some products down to 35°F), oil-based 40°F+
• **Surface temp**: must be above dew point — use IR thermometer to verify
• **Humidity**: below 85% RH for proper curing
• **Rain**: no application if rain expected within 4-8 hours (product-specific)
• **Direct sun**: avoid painting surfaces in direct sunlight — causes lap marks, poor adhesion
• **Morning dew**: wait until surface is completely dry before application
• Plan the sequence: follow the shade around the building for best results.`,
  },
  {
    id: 'coverage-calculation',
    category: 'practice',
    condition: () => true,
    title: 'Coverage & Material Estimation',
    content: `Accurate material estimation prevents mid-job supply runs:
• Standard coverage: 350-400 sqft/gallon for smooth surfaces, 250-300 for textured
• Primer coverage: typically 300-350 sqft/gallon
• Stain coverage: 150-300 sqft/gallon depending on porosity
• Add 10-15% waste factor for spray application, 5-10% for brush/roller
• Multiple coats: each coat gets its own coverage calculation
• Color changes: drastic color shifts may need tinted primer + 2 finish coats
• Always order 1 extra gallon for touch-ups — same batch ensures color match.`,
  },
];
