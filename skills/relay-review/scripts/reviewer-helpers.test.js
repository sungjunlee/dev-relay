const test = require("node:test");
const assert = require("node:assert/strict");

const { summarizeFailure, ensureJsonText } = require("./reviewer-helpers");

test("summarizeFailure prefers stderr when both streams are populated", () => {
  // Anti-theater: rejects a naive `error.stdout || error.message` helper because callers surface
  // stderr first — that's where codex/claude write the actionable failure reason.
  const summary = summarizeFailure({
    stderr: "  boom\n",
    stdout: "noise\n",
    message: "command failed",
  });
  assert.equal(summary, "boom");
});

test("summarizeFailure falls back to stdout when stderr is empty", () => {
  // Anti-theater: an empty stderr (buffer exists but trims to "") must not short-circuit the
  // `||` chain; real failures frequently land on stdout when the reviewer CLI crashes late.
  const summary = summarizeFailure({
    stderr: "   \n",
    stdout: "partial response",
    message: "command failed",
  });
  assert.equal(summary, "partial response");
});

test("summarizeFailure falls back to message when both streams are empty", () => {
  // Anti-theater: callers rely on a non-empty return so they can wrap it with `reviewer failed:
  // ${summary}`. Returning "" would produce a dangling colon.
  const summary = summarizeFailure({
    stderr: "",
    stdout: undefined,
    message: "spawn ENOENT",
  });
  assert.equal(summary, "spawn ENOENT");
});

test("summarizeFailure handles missing stream buffers without throwing", () => {
  // Anti-theater: `error.stderr` can be undefined when the child process is killed before I/O;
  // the helper must coerce to string rather than assuming `.trim()` exists.
  const summary = summarizeFailure({ message: "killed" });
  assert.equal(summary, "killed");
});

test("ensureJsonText is silent when the text is valid JSON", () => {
  // Anti-theater: the helper must not mutate or return the parsed value — it only validates.
  // Returning a parsed object would tempt callers to use it and duplicate `JSON.parse` later.
  assert.doesNotThrow(() => ensureJsonText('{"verdict":"pass"}', "Claude reviewer"));
});

test("ensureJsonText throws with label prefix when the text is not valid JSON", () => {
  // Anti-theater: the label ("Claude reviewer" / "Codex reviewer") must appear in the thrown
  // message so the operator can tell which adapter produced the bad output.
  assert.throws(
    () => ensureJsonText("not-json", "Codex reviewer"),
    /^Error: Codex reviewer did not return valid JSON:/
  );
});

test("ensureJsonText rejects empty-string input", () => {
  // Anti-theater: JSON.parse("") throws, which is what we want — an empty recovery buffer must
  // not be treated as a valid verdict. Guard against a future change that pre-checks emptiness.
  assert.throws(
    () => ensureJsonText("", "Claude reviewer"),
    /did not return valid JSON/
  );
});
