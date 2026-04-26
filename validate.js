/**
 * Lightweight schema-based validation middleware for Express.
 * Zero dependencies — works with any Express app across all trade packages.
 *
 * Two usage patterns:
 *   1. Named schemas:  validate(schemas.createJob)
 *   2. Inline schemas:  validate({ title: { type: 'string', maxLength: 200 } })
 *
 * Supported field options:
 *   type       - 'string' | 'number' | 'boolean' | 'object' | 'array'
 *   required   - boolean, field must be present and non-null
 *   min / max  - numeric range (inclusive)
 *   minLength / maxLength - string length bounds
 *   pattern    - RegExp to test against
 *   enum       - array of allowed values
 *
 * @module validate
 */

/**
 * Validate a single field value against its rule set.
 * @param {string} field - field name
 * @param {*} value - field value from req.body
 * @param {object} rules - validation rules for this field
 * @returns {string|null} error message or null if valid
 */
function validateField(field, value, rules) {
  const isPresent = value !== undefined && value !== null;

  if (rules.required && !isPresent) {
    return `${field} is required`;
  }

  // Skip further checks if value is absent and not required
  if (!isPresent) return null;

  // Type check
  if (rules.type) {
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (actualType !== rules.type) {
      return `${field} must be of type ${rules.type}, got ${actualType}`;
    }
  }

  // String constraints
  if (typeof value === 'string') {
    if (rules.minLength !== undefined && value.length < rules.minLength) {
      return `${field} must be at least ${rules.minLength} characters`;
    }
    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      return `${field} must be at most ${rules.maxLength} characters`;
    }
    if (rules.pattern && !rules.pattern.test(value)) {
      return `${field} does not match required pattern`;
    }
  }

  // Numeric constraints
  if (typeof value === 'number') {
    if (rules.min !== undefined && value < rules.min) {
      return `${field} must be >= ${rules.min}`;
    }
    if (rules.max !== undefined && value > rules.max) {
      return `${field} must be <= ${rules.max}`;
    }
  }

  // Enum
  if (rules.enum && !rules.enum.includes(value)) {
    return `${field} must be one of: ${rules.enum.join(', ')}`;
  }

  return null;
}

/**
 * Returns Express middleware that validates req.body against the given schema.
 * On failure, responds with 400 and { error, details }.
 * On success, calls next().
 *
 * @param {object} schema - map of field names to validation rules
 * @returns {Function} Express middleware
 */
export function validate(schema) {
  return (req, _res, next) => {
    if (!schema || typeof schema !== 'object') return next();

    const errors = [];
    for (const [field, rules] of Object.entries(schema)) {
      const err = validateField(field, req.body?.[field], rules);
      if (err) errors.push(err);
    }

    if (errors.length > 0) {
      return _res.status(400).json({
        error: 'Validation failed',
        details: errors,
      });
    }

    next();
  };
}

/**
 * Pre-built schemas used by route files across trade packages.
 */
export const schemas = {
  /** POST /api/jobs */
  createJob: {
    name: { type: 'string', required: true, maxLength: 200 },
    address: { type: 'string', maxLength: 500 },
    client_name: { type: 'string', maxLength: 200 },
    client_phone: { type: 'string', maxLength: 30 },
    notes: { type: 'string', maxLength: 2000 },
  },

  /** PUT /api/jobs/:id */
  updateJob: {
    name: { type: 'string', maxLength: 200 },
    address: { type: 'string', maxLength: 500 },
    client_name: { type: 'string', maxLength: 200 },
    client_phone: { type: 'string', maxLength: 30 },
    notes: { type: 'string', maxLength: 2000 },
  },

  /** POST /api/:jobId/estimates */
  createEstimate: {
    label: { type: 'string', maxLength: 200 },
    labor_rate: { type: 'number', min: 0, max: 1000 },
    markup_pct: { type: 'number', min: 0, max: 200 },
    notes: { type: 'string', maxLength: 2000 },
  },

  /** PUT /api/estimates/:id */
  updateEstimate: {
    label: { type: 'string', maxLength: 200 },
    status: { type: 'string', maxLength: 50 },
    labor_rate: { type: 'number', min: 0, max: 1000 },
    markup_pct: { type: 'number', min: 0, max: 200 },
    notes: { type: 'string', maxLength: 2000 },
  },

  /** PATCH /api/estimates/:id/factors */
  applyOverride: {
    item_id: { required: true },
    factor_key: { type: 'string', required: true, maxLength: 100 },
    override_value: { required: true },
  },
};
