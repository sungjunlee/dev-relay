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
