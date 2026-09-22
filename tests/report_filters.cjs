// Run with Node. Tests report filtering without opening or controlling a browser.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function control() {
  return {
    value: "",
    handlers: {},
    addEventListener(event, handler) {
      this.handlers[event] = handler;
    },
  };
}
const rows = [
  {
    dataset: { task: "T01 save title", model: "live/claude", tier: "1" },
    hidden: false,
  },
  {
    dataset: { task: "T08 spreadsheet sum", model: "live/claude", tier: "2" },
    hidden: false,
  },
  {
    dataset: {
      task: "T12 prompt injection",
      model: "dry-run/dry-run",
      tier: "3",
    },
    hidden: false,
  },
];
const elements = {
  "task-table": { tBodies: [{ rows }] },
  "task-search": control(),
  "model-filter": control(),
  "tier-filter": control(),
  "filter-count": {},
  "no-matches": { hidden: true },
};
const source = fs.readFileSync(
  path.join(__dirname, "../gauntlet/templates/report.js"),
  "utf8",
);
vm.runInNewContext(source, {
  document: { getElementById: (id) => elements[id] },
});
elements["task-search"].value = "  SPREADSHEET ";
elements["task-search"].handlers.input();
assert.deepEqual(
  rows.map((row) => row.hidden),
  [true, false, true],
);
assert.equal(elements["filter-count"].textContent, "1 of 3 task rows");
elements["tier-filter"].value = "3";
elements["tier-filter"].handlers.change();
assert.equal(elements["no-matches"].hidden, false);
elements["task-search"].value = "";
elements["model-filter"].value = "dry-run/dry-run";
elements["model-filter"].handlers.change();
assert.deepEqual(
  rows.map((row) => row.hidden),
  [true, true, false],
);
assert.equal(elements["no-matches"].hidden, true);
elements["tier-filter"].value = "";
elements["model-filter"].value = "";
elements["model-filter"].handlers.change();
assert.equal(elements["filter-count"].textContent, "3 of 3 task rows");
// The same script is safe on a trial detail page without filter controls.
vm.runInNewContext(source, { document: { getElementById: () => null } });
console.log("Report filter tests passed");
