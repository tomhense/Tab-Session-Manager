const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const babel = require("@babel/core");

const filePath = path.resolve(__dirname, "../src/options/components/importSessionParsers.js");
const source = fs.readFileSync(filePath, "utf8");
const transformed = babel.transformSync(source, {
  filename: filePath,
  configFile: path.resolve(__dirname, "../babel.config.js")
});

const testModule = { exports: {} };
const sandbox = {
  module: testModule,
  exports: testModule.exports,
  require,
  __dirname: path.dirname(filePath),
  __filename: filePath,
  console
};

vm.runInNewContext(transformed.code, sandbox, { filename: filePath });

const { isTabSessionManagerExport, normalizeTabSessionManagerSessions } = sandbox.module.exports;

const legacySessions = [
  {
    windows: { 1: {} },
    tabsNumber: 1,
    name: "Legacy session",
    date: "2024-04-03T12:34:56.000Z",
    tag: "user auto project",
    sessionStartTime: 1712147696000
  }
];

assert.strictEqual(isTabSessionManagerExport(legacySessions), true);

const normalized = JSON.parse(
  JSON.stringify(normalizeTabSessionManagerSessions(JSON.parse(JSON.stringify(legacySessions))))
);
assert.strictEqual(normalized.length, 1);
assert.match(normalized[0].id, /^[0-9a-f-]{36}$/i);
assert.deepStrictEqual(normalized[0].tag, ["project"]);
assert.strictEqual(normalized[0].windowsNumber, 1);
assert.strictEqual(normalized[0].date, 1712147696000);
assert.strictEqual(normalized[0].lastEditedTime, 1712147696000);

console.log("importSessionParsers regression test passed");
