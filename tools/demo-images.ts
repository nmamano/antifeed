// Makes the two demo screenshots (a phone screen before and after a fix).
// Run: bun tools/demo-images.ts
import { chromium } from "playwright-core";

const screen = (fixed: boolean) => `<!doctype html><body style="margin:0;font:15px -apple-system,sans-serif;background:#f6f5f2">
<div style="height:560px;display:flex;flex-direction:column">
<div style="padding:14px;font-weight:600;border-bottom:1px solid #ddd;background:#fff">Sign in</div>
<div style="flex:1;padding:16px">
<div style="margin:8px 0">Email</div><div style="height:36px;border:1px solid #ccc;border-radius:8px;background:#fff"></div>
<div style="margin:12px 0 8px">Password</div><div style="height:36px;border:1px solid #ccc;border-radius:8px;background:#fff"></div>
</div>
<button style="position:${fixed ? "static" : "absolute"};${fixed ? "margin:0 16px 12px" : "bottom:22px;left:40px;right:40px"};height:44px;border:0;border-radius:10px;background:#2f6fde;color:#fff;font:600 15px sans-serif">Log in</button>
<div style="padding:14px;color:#666;border-top:1px solid #ddd;background:#fff;font-size:13px">Terms · Privacy · Help</div>
</div></body>`;

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 320, height: 560 }, deviceScaleFactor: 2 });
for (const [name, fixed] of [["before", false], ["after", true]] as const) {
  await page.setContent(screen(fixed));
  await page.screenshot({ path: `projects/demo/assets/${name}.png` });
}
await browser.close();
console.log("wrote projects/demo/assets/before.png and after.png");
