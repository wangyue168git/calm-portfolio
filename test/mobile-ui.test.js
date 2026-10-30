"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "m.html"), "utf8");

test("mobile add-holding FAB stays outside animated page containers", () => {
  const holdingsStart = source.indexOf('<section id="pageHoldings"');
  const holdingsEnd = source.indexOf("</section>", holdingsStart);
  const fab = source.indexOf('id="addHoldingFab"');
  assert.ok(holdingsStart >= 0 && holdingsEnd > holdingsStart && fab > holdingsEnd);
  assert.match(source, /#addHoldingFab\s*\{\s*display:\s*none;/);
  assert.match(source, /#addHoldingFab\.show\s*\{\s*display:\s*flex;/);
  assert.match(source, /getElementById\('addHoldingFab'\)\.classList\.toggle\('show', p === 'holdings'\)/);
});
