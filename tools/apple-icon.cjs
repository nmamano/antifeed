// Makes src/apple-touch-icon.png (180 px) from src/icon.svg: the same mark on
// a square with no round corners and no transparency, because the iPhone
// rounds the corners of a home screen icon itself.
// Run: node tools/apple-icon.cjs (after a change to src/icon.svg).
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { chromium } = require("playwright-core");

const src = join(__dirname, "..", "src");
const svg = readFileSync(join(src, "icon.svg"), "utf8").replace(/ rx="7"/, "");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
  const p = await b.newPage({ viewport: { width: 180, height: 180 } });
  await p.setContent('<body style="margin:0">' + svg.replace("<svg ", '<svg width="180" height="180" style="display:block" '));
  await p.screenshot({ path: join(src, "apple-touch-icon.png"), omitBackground: false });
  await b.close();
})();
