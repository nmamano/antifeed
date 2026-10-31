// The priority floor (Antifeed PM, 2026-10-28, from Nil's feedback in
// LOOP-APP-FEEDBACK.md): a floor never hides a card with no priority, and a
// board card with no board priority says "No board priority" in its head.
// Queue round 1 (F1): the floor reads the Predictor's priority. The walkthrough
// has no such card, so the check takes the board priority and the Premove's
// priority off a demo triage card in the page's own view.
// Run on a fresh walkthrough copy:
//   PORT=21199 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/floor-checks.ts http://localhost:21199
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
for (let i = 0; i < 60 && (await view()).cards.some((k: any) => k.state === "predicting" || k.state === "preparing"); i++) await new Promise((r) => setTimeout(r, 500));
const open = (await view()).cards.filter((c: any) => c.state === "open" && !c.held);
const noPr = open.find((c: any) => c.policy === "demo-triage" && c.kind === "decision" && c.meta?.priority)!;
// A card the Predictor put below P1 (P2, P3, backlog or obsolete).
const p3 = open.find((c: any) => c.id !== noPr.id && c.kind === "decision" && c.prediction?.by !== "code:standin" && (["P2", "P3"].includes(c.prediction?.call?.priority) || ["backlog", "obsolete"].includes(c.prediction?.call?.choice)))!;
const ask = open.find((c: any) => c.policy === "ask")!;
for (const [kind, vp] of [["desk", { width: 1400, height: 1000 }], ["phone", { width: 390, height: 844 }]] as const) {
  const c = await browser.newContext({ viewport: vp, extraHTTPHeaders: H, ...(kind === "phone" ? { isMobile: true, hasTouch: true } : {}) });
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await p.goto(base + "/");
  await p.waitForSelector("[data-card]");
  // The task of noPr has no priority on its board; the next poll answers 304, so the page keeps it.
  await p.evaluate((id) => {
    const w = window as any;
    const card = w.eval("V").cards.find((x: any) => x.id === id);
    delete card.meta.priority;
    if (card.prediction?.call) delete card.prediction.call.priority;
    w.eval("view").floor = "P1";
    w.eval("redraw")();
  }, noPr.id);
  await p.waitForTimeout(300);
  const rows = await p.evaluate(() => document.querySelector("#tab-queue")!.textContent || "");
  const shown = async (c: any) => (await p.locator(`[data-card="${c.id}"], [data-row="${c.id}"], [data-id="${c.id}"]`).count()) > 0 || rows.includes(c.packet?.question ?? "\u0000");
  check(`${kind}: floor P0-P1 shows the card with no priority`, await shown(noPr), noPr.id);
  check(`${kind}: floor P0-P1 shows an Inbox ask (no board priority)`, await shown(ask), ask.id);
  check(`${kind}: floor P0-P1 still hides a card the Predictor put below P1`, !(await shown(p3)), p3.id);
  // Its head, as the current card.
  await p.evaluate((id) => {
    const w = window as any;
    w.eval("setCur")(id);
    w.eval("redraw")();
  }, noPr.id);
  await p.waitForTimeout(300);
  // A phone folds the head: the fold's summary names the board priority.
  const head = await p.locator(`[data-card="${noPr.id}"] ${kind === "phone" ? ".metamore summary" : ".meta"}`).first().textContent();
  check(`${kind}: its head says "No board priority"`, !!head && head.includes("No board priority"), (head ?? "").replace(/\s+/g, " ").slice(0, 120));
  await p.evaluate((id) => {
    const w = window as any;
    w.eval("setCur")(id);
    w.eval("redraw")();
  }, ask.id);
  await p.waitForTimeout(300);
  const askHead = await p.locator(`[data-card="${ask.id}"]`).first().textContent();
  check(`${kind}: an Inbox ask's head does not say "No board priority"`, !!askHead && !askHead.includes("No board priority"));
  await c.close();
}
await browser.close();
console.log(fails ? `${fails} FAIL` : "ALL PASS");
process.exit(fails ? 1 : 0);
