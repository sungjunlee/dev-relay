const REVIEW_VERDICT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "verdict",
    "summary",
    "contract_status",
    "quality_status",
    "next_action",
    "issues",
    "rubric_scores",
    "scope_drift",
  ],
  properties: {
    verdict: {
      type: "string",
      enum: ["pass", "changes_requested", "escalated"],
    },
    summary: {
      type: "string",
      minLength: 1,
    },
    contract_status: {
      type: "string",
      enum: ["pass", "fail", "not_run"],
    },
    quality_status: {
      type: "string",
      enum: ["pass", "fail", "not_run"],
    },
    next_action: {
      type: "string",
      enum: ["ready_to_merge", "changes_requested", "escalated"],
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body", "file", "line", "category", "severity"],
        properties: {
          title: { type: "string", minLength: 1 },
          body: { type: "string", minLength: 1 },
          file: { type: "string", minLength: 1 },
          line: { type: "integer", minimum: 1 },
          category: { type: "string", minLength: 1 },
          severity: { type: "string", minLength: 1 },
        },
      },
    },
    rubric_scores: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["factor", "target", "observed", "status", "notes"],
        properties: {
          factor: { type: "string", minLength: 1 },
          target: { type: "string", minLength: 1 },
          observed: { type: "string", minLength: 1 },
          tier: {
            type: "string",
            enum: ["contract", "quality"],
          },
          status: {
            type: "string",
            enum: ["pass", "fail", "not_run"],
          },
          notes: { type: "string", minLength: 1 },
        },
      },
    },
    scope_drift: {
      type: "object",
      additionalProperties: false,
      required: ["creep", "missing"],
      properties: {
        creep: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["file", "reason"],
            properties: {
              file: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1 },
            },
          },
        },
        missing: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["criteria", "status"],
            properties: {
              criteria: { type: "string", minLength: 1 },
              status: {
                type: "string",
                enum: ["verified", "partial", "not_done", "changed"],
              },
            },
          },
        },
      },
    },
  },
};

module.exports = {
  REVIEW_VERDICT_JSON_SCHEMA,
};
