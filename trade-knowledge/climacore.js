/**
 * ClimaCore (HVAC) — Trade-specific best practices, safety alerts, and code requirements.
 */

const yearBefore = (v, cutoff) => { const n = parseInt(v); return !isNaN(n) && n < cutoff; };
const textMatch = (v, pattern) => v && pattern.test(String(v));

export default [
  // ── Safety Alerts ──────────────────────────────────────
  {
    id: 'r22-phaseout',
    category: 'safety',
    condition: (ctx) => textMatch(ctx.refrigerantType, /r.?22|R.?22|HCFC/i) ||
                        (textMatch(ctx.systemType, /ac|air\s*condition|heat\s*pump|split/i) && yearBefore(ctx.systemAge, 2010)),
    title: 'R-22 Refrigerant Phaseout',
    content: `R-22 (HCFC-22) production and import ended January 1, 2020:
• Existing R-22 systems can continue operating but refrigerant is extremely expensive ($50-150+/lb)
• Adding R-22 requires EPA 608 certification — no venting allowed
• Retrofit options: R-407C or R-422D drop-in replacements (check compressor compatibility)
• Systems over 15 years old: typically more cost-effective to replace than retrofit
• When replacing, new equipment uses R-410A or newer R-32/R-454B (A2L refrigerants)
• Quote both repair and replacement options — let the customer decide with full cost data.`,
  },
  {
    id: 'cracked-heat-exchanger',
    category: 'safety',
    condition: (ctx) => textMatch(ctx.systemType, /furnace|gas.*heat/i) ||
                        textMatch(ctx.additionalNotes, /heat exchanger|CO|carbon monoxide|crack/i),
    title: 'Heat Exchanger / CO Safety',
    content: `Carbon monoxide from cracked heat exchangers is a leading cause of HVAC-related fatalities:
• **Older furnaces (15+ years)**: inspect heat exchanger cells visually and with combustion analysis
• CO readings above 100 PPM in the flue = immediate red flag
• Ambient CO readings above 9 PPM in living space = DANGER, shut down immediately
• Always carry a personal CO monitor on gas furnace calls
• Document all combustion analysis readings — CYA and liability protection
• A cracked heat exchanger = system shutdown, no exceptions.`,
  },

  // ── Code Requirements ──────────────────────────────────
  {
    id: 'manual-j-load-calc',
    category: 'code',
    condition: (ctx) => textMatch(ctx.additionalNotes, /new.*system|replace|install|size|tonnage|undersized|oversized/i) ||
                        textMatch(ctx.tonnage, /\?|unknown/i),
    title: 'Manual J Load Calculation Required',
    content: `ACCA Manual J is required by IMC and most jurisdictions for equipment sizing:
• Never size from "rule of thumb" (e.g., 1 ton per 500 sqft) — this produces oversized systems
• Oversized cooling = short cycling, poor humidity control, reduced equipment life
• Manual J factors: climate zone, insulation levels, window area/orientation, infiltration, duct losses
• Follow Manual J with Manual S (equipment selection) for proper match
• Commercial: ASHRAE load calculations replace Manual J
• Many AHJs now require the load calc to be submitted with the permit application.`,
  },
  {
    id: 'combustion-air',
    category: 'code',
    condition: (ctx) => textMatch(ctx.systemType, /furnace|boiler|gas/i) ||
                        textMatch(ctx.additionalNotes, /combustion air|sealed closet|utility room/i),
    title: 'Combustion Air Requirements',
    content: `All fuel-burning appliances require adequate combustion air (IMC 701-703):
• Indoor air: room volume must be ≥50 cu ft per 1,000 BTU/hr for all appliances combined
• Outdoor air: two openings required — one high (within 12" of ceiling), one low (within 12" of floor)
• Each opening: minimum 1 sq in per 4,000 BTU/hr (direct outdoor) or 1 sq in per 2,000 BTU/hr (horizontal duct)
• Sealed combustion / direct-vent equipment: exempt from room sizing requirements
• Converting to high-efficiency (90%+) sealed combustion eliminates most combustion air concerns
• Check ALL appliances in the space — don't forget water heaters.`,
  },
  {
    id: 'duct-static-pressure',
    category: 'code',
    condition: (ctx) => textMatch(ctx.ductCondition, /restrict|crush|kink|undersized|poor|old/i) ||
                        textMatch(ctx.additionalNotes, /airflow|static|duct/i),
    title: 'Ductwork & Static Pressure',
    content: `Ductwork problems are the #1 cause of comfort complaints:
• Target total external static pressure: 0.50" WC for residential (per ACCA Manual D)
• Measure static pressure at supply and return plenums before any equipment change
• Common problems: crushed flex duct, excessive length, too many elbows, missing return air
• When replacing equipment: ALWAYS verify existing ductwork can handle the new unit's CFM
• High-efficiency equipment often needs LARGER ductwork than older systems
• Filter restriction: verify filter size matches manufacturer specs — undersized filters kill airflow.`,
  },

  // ── Best Practices ─────────────────────────────────────
  {
    id: 'condensate-management',
    category: 'practice',
    condition: (ctx) => textMatch(ctx.systemType, /ac|air\s*condition|heat\s*pump|mini.?split|high.?eff/i) ||
                        textMatch(ctx.additionalNotes, /condensate|drain|overflow|leak/i),
    title: 'Condensate Management',
    content: `Condensate management prevents water damage:
• Primary drain: 3/4" minimum PVC with proper trap and slope
• Secondary drain or float switch: required for equipment above finished spaces (attics, upper floors)
• High-efficiency furnaces (90%+): produce acidic condensate — route to appropriate drain, not onto concrete or metal
• Mini-splits: condensate pumps often required for wall-mounted units without gravity drain
• Test both drains at every maintenance visit — clogs cause expensive water damage claims
• Consider a Wi-Fi leak sensor near the drain pan for proactive monitoring.`,
  },
  {
    id: 'seasonal-maintenance-checklist',
    category: 'practice',
    condition: () => true,
    title: 'Professional Maintenance Standards',
    content: `Complete maintenance visits build customer trust and prevent callbacks:
• **Cooling season**: clean condenser coil, check refrigerant charge (superheat/subcooling), verify amp draw, inspect capacitors, check contactor, clean drain, test safeties
• **Heating season**: combustion analysis (gas), check heat exchanger, clean burners, test igniter, verify gas pressure, check flue draft, test safeties, check CO
• **Both**: change filter, verify thermostat calibration, check electrical connections (torque), inspect ductwork accessible sections
• Document all readings — trend data catches problems early.`,
  },
];
