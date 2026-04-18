const { getRubricAnchorStatus } = require("./rubric");

const STATES = Object.freeze({
  DRAFT: "draft",
  DISPATCHED: "dispatched",
  REVIEW_PENDING: "review_pending",
  CHANGES_REQUESTED: "changes_requested",
  READY_TO_MERGE: "ready_to_merge",
  MERGED: "merged",
  ESCALATED: "escalated",
  CLOSED: "closed",
});

const ALLOWED_TRANSITIONS = Object.freeze({
  [STATES.DRAFT]: new Set([STATES.DISPATCHED, STATES.CLOSED]),
  [STATES.DISPATCHED]: new Set([STATES.REVIEW_PENDING, STATES.ESCALATED, STATES.CLOSED]),
  [STATES.REVIEW_PENDING]: new Set([STATES.CHANGES_REQUESTED, STATES.READY_TO_MERGE, STATES.ESCALATED, STATES.CLOSED]),
  [STATES.CHANGES_REQUESTED]: new Set([STATES.DISPATCHED, STATES.CLOSED]),
  [STATES.READY_TO_MERGE]: new Set([STATES.MERGED, STATES.CLOSED]),
  [STATES.ESCALATED]: new Set([STATES.CLOSED]),
  [STATES.MERGED]: new Set(),
  [STATES.CLOSED]: new Set(),
});

function nowIso() {
  return new Date().toISOString();
}

function validateTransition(fromState, toState) {
  if (!Object.values(STATES).includes(fromState)) {
    throw new Error(`Unknown relay state: ${fromState}`);
  }
  if (!Object.values(STATES).includes(toState)) {
    throw new Error(`Unknown relay state: ${toState}`);
  }
  if (!ALLOWED_TRANSITIONS[fromState].has(toState)) {
    throw new Error(`Invalid relay state transition: ${fromState} -> ${toState}`);
  }
}

function validateTransitionInvariants(data, fromState, toState) {
  if (fromState === STATES.DISPATCHED && toState === STATES.REVIEW_PENDING) {
    const rubricAnchor = getRubricAnchorStatus(data);
    if (!rubricAnchor.satisfied) {
      throw new Error(
        `Cannot transition dispatched -> review_pending because ${rubricAnchor.error} ` +
        "Generate the rubric with relay-plan and dispatch with --rubric-file, " +
        "or migrate an approved pre-change run with relay-migrate-rubric.js."
      );
    }
  }
}

function updateManifestState(data, toState, nextAction) {
  validateTransition(data.state, toState);
  validateTransitionInvariants(data, data.state, toState);
  return {
    ...data,
    state: toState,
    next_action: nextAction,
    timestamps: {
      ...(data.timestamps || {}),
      updated_at: nowIso(),
    },
  };
}

function forceTransitionState(data, toState, nextAction) {
  if (!Object.values(STATES).includes(data.state)) {
    throw new Error(`Unknown relay state: ${data.state}`);
  }
  if (!Object.values(STATES).includes(toState)) {
    throw new Error(`Unknown relay state: ${toState}`);
  }
  validateTransitionInvariants(data, data.state, toState);
  return {
    ...data,
    state: toState,
    next_action: nextAction,
    timestamps: {
      ...(data.timestamps || {}),
      updated_at: nowIso(),
    },
  };
}

function isTerminalState(state) {
  return state === STATES.MERGED || state === STATES.CLOSED;
}

module.exports = {
  ALLOWED_TRANSITIONS,
  STATES,
  forceTransitionState,
  isTerminalState,
  updateManifestState,
  validateTransition,
  validateTransitionInvariants,
};
