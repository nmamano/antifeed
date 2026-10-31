// Tab title and icon (Nil, 2026-10-27): "(N) Antifeed" with N the queue's
// count, live on a call, an Undo and a call from another device, also with the
// tab hidden; the icon and the iPhone icon are served and linked.
// Run on a fresh walkthrough copy (it uses up demo cards):
//   PORT=21199 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/title-checks.ts http://localhost:21199
import { chromium } from "playwright-core";

const base = process.argv[2];
const H = { "X-Isomux-Member-Id": "m0000000" };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const view = async () => (await (await fetch(base + "/api/view", { headers: H })).json()) as any;
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60 && (await view()).cards.some((k: any) => k.state === "predicting" || k.state === "preparing"); i++) await sleep(500);
const queued = async () => (await view()).cards.filter((c: any) => c.state === "open" && !c.held).length;
const want = (n: number) => (n ? `(${n}) Antifeed` : "Antifeed");
const decide = async (k: any) =>
  fetch(base + "/api/cards/" + k.id + "/decide", { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ version: k.version, call: { ...k.prediction.call, note: "" } }) });
const decidable = async () => (await view()).cards.find((x: any) => x.state === "open" && x.kind === "decision" && x.prediction && !x.held);
// Waits up to ms for the page title to be t. With no t, the title follows the
// server's count at each read (a walkthrough copy adds cards as it runs).
const titleIs = async (p: any, t?: string, ms = 8000) => {
  for (let i = 0; i < ms / 200; i++) {
    if ((await p.title()) === (t ?? want(await queued()))) return true;
    await sleep(200);
  }
  return false;
};

// 1. The icons.
const svg = await fetch(base + "/icon.svg");
check("1. /icon.svg is an SVG", svg.status === 200 && svg.headers.get("content-type") === "image/svg+xml" && (await svg.text()).startsWith("<svg"));
const png = await fetch(base + "/apple-touch-icon.png");
const b = new Uint8Array(await png.arrayBuffer());
const w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
const h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
check("1. /apple-touch-icon.png is a 180 px PNG", png.status === 200 && png.headers.get("content-type") === "image/png" && w === 180 && h === 180, `${w}x${h}`);
check("1. /favicon.ico is a 404, not the page", (await fetch(base + "/favicon.ico")).status === 404);

const c = await browser.newContext({ viewport: { width: 1400, height: 1000 }, extraHTTPHeaders: H });
// The test can make the tab hidden: Chrome headless shows every tab.
await c.addInitScript(() => {
  let hidden = false;
  Object.defineProperty(document, "visibilityState", { get: () => (hidden ? "hidden" : "visible") });
  Object.defineProperty(document, "hidden", { get: () => hidden });
  (window as any).setHidden = (v: boolean) => ((hidden = v), document.dispatchEvent(new Event("visibilitychange")));
});
const p = await c.newPage();
p.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
await p.goto(base + "/");
await p.waitForSelector("[data-card]");
await p.waitForTimeout(1500);
const links = await p.evaluate(() => [...document.querySelectorAll("link")].map((l) => l.rel + " " + l.getAttribute("href")));
check("1. the page links both icons", links.includes("icon /icon.svg?v=3") && links.includes("apple-touch-icon /apple-touch-icon.png?v=3"), links.join(", "));

// 2. The title and the Queue tab's count agree with the open cards.
let n = await queued();
const tabText = await p.textContent('#tabs [data-tab="queue"]');
check("2. the title is (N) Antifeed at load", await titleIs(p, want(n)), `${await p.title()} | tab "${tabText}" | open ${n}`);
check("2. the Queue tab shows the same N", tabText === `Queue (${n})`, tabText ?? "");

// 3. A call on this page: the count drops at once; Undo brings it back.
// Confirm takes a press once the Premove was on the screen and Nil did something on the card.
const btn = p.locator("[data-callzone] .actions [data-confirm], [data-callzone] .actions [data-done]").first();
await p.locator("[data-card] .premove").first().evaluate((e: HTMLElement) => e.scrollIntoView({ block: "center" })).catch(() => {});
await p.mouse.move(700, 600);
await p.mouse.wheel(0, 200); // Nil's scroll: an act on the card, so Confirm or Done unlocks
await p.waitForTimeout(600);
// An action card's Done asks for its steps first.
for (const box of await p.locator("[data-card] input[type=checkbox]").all()) await box.check();
await btn.evaluate((e: HTMLElement) => e.scrollIntoView({ block: "center" }));
await p.waitForTimeout(600);
const id = await p.locator("[data-callzone]").first().getAttribute("data-callzone");
const t0 = Date.now();
await btn.click();
const out = await titleIs(p, undefined, 2000);
const gone = (await view()).cards.find((x: any) => x.id === id);
check("3. a call here takes its card out of N at once", out && (gone.state !== "open" || !!gone.held), `${await p.title()} after ${Date.now() - t0} ms`);
await p.click("#toast [data-toast-undo]");
check("3. its Undo brings the card back into N", (await titleIs(p, undefined, 4000)) && (await view()).cards.find((x: any) => x.id === id).state === "open", await p.title());

// 4. The tab is hidden, and a call comes from another device: the title follows; the page itself does not redraw.
await p.evaluate(() => (window as any).setHidden(true));
const before = await p.textContent('#tabs [data-tab="queue"]');
await p.waitForTimeout(500);
const t1 = await p.title();
let k = await decidable();
await decide(k);
n = await queued();
check("4. hidden: a call on another device changes the title", (await titleIs(p, undefined, 8000)) && (await p.title()) !== t1, t1 + " -> " + (await p.title()));
check("4. hidden: the page does not redraw (its Queue tab keeps the old count)", (await p.textContent('#tabs [data-tab="queue"]')) === before, before ?? "");
await fetch(base + "/api/cards/" + k.id + "/undo", { method: "POST", headers: H });
n = await queued();
check("4. hidden: an Undo on another device brings the title back", await titleIs(p, undefined, 8000), await p.title());
await p.evaluate(() => (window as any).setHidden(false));
check("4. visible again: title and Queue tab agree", (await titleIs(p, undefined, 4000)) && (await p.textContent('#tabs [data-tab="queue"]')) === `Queue (${await queued()})`, await p.title());

// 5. At 0 the title is just "Antifeed": every decision card decided, every action card marked Done.
for (let i = 0; i < 80; i++) {
  k = await decidable();
  if (!k) break;
  await decide(k);
}
for (const a of (await view()).cards.filter((x: any) => x.state === "open" && !x.held && x.kind !== "decision"))
  await fetch(base + "/api/cards/" + a.id + "/action", { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) });
n = await queued();
if (n === 0) check("5. an empty queue: the title is Antifeed", await titleIs(p, "Antifeed", 8000), await p.title());
else console.log(`SKIP 5. ${n} cards stay open that this check could not close by API`);
await browser.close();
console.log(fails ? `${fails} FAIL` : "ALL PASS");
process.exit(fails ? 1 : 0);
