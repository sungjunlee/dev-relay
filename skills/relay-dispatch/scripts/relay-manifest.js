// Compatibility facade — see `references/architecture.md` § Module Boundaries.
// Runtime code imports `./manifest/<submodule>` directly; this file exists for
// legacy public-surface tests and deferred consumers (#188).
const paths = require("./manifest/paths");
const store = require("./manifest/store");
const lifecycle = require("./manifest/lifecycle");
const rubric = require("./manifest/rubric");
const cleanup = require("./manifest/cleanup");
const attempts = require("./manifest/attempts");
const environment = require("./manifest/environment");

module.exports = {
  ...paths,
  ...store,
  ...lifecycle,
  ...rubric,
  ...cleanup,
  ...attempts,
  ...environment,
};
