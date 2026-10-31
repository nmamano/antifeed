// Round 12 (Antifeed PM's held list after Nil's review of slice 4b, 2026-10-25): one or more checks per item.
// It uses up demo cards, so run it on a fresh walkthrough copy:
//   PORT=21199 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/round12-checks.ts http://localhost:21199
import { chromium, devices } from "playwright-core";

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
type Kind = "phone" | "phone-nomobile" | "desk";
async function ctx(kind: Kind) {
  const o =
    kind === "phone" ? { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }
    : kind === "phone-nomobile" ? { viewport: { width: 390, height: 844 }, isMobile: false, hasTouch: true }
    : { viewport: { width: 1400, height: 1000 } };
  const c = await browser.newContext({ ...o, extraHTTPHeaders: H });
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await p.goto(base + "/");
  await p.waitForSelector("[data-card]");
  await p.waitForTimeout(1500);
  return { c, p };
}
// The toast's Undo box and every Confirm or Done box that shows (the card's and the bar's), at this scroll.
const boxes = (p: any) =>
  p.evaluate(() => {
    const r = (e: Element) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
    const shows = (e: Element) => !(e as HTMLElement).closest("[hidden]") && getComputedStyle(e).visibility === "visible" && e.getBoundingClientRect().height > 0;
    const u = document.querySelector("#toast [data-toast-undo]");
    const t = document.querySelector("#toast") as HTMLElement;
    return {
      undo: u && shows(u) ? r(u) : null,
      toast: !t.hidden ? r(t) : null,
      tabs: r(document.querySelector("#tabs")!),
      buttons: [...document.querySelectorAll("[data-confirm], [data-done]")].filter(shows).map(r).filter((b) => b.bottom > 0 && b.top < innerHeight),
      bottomGap: !t.hidden ? innerHeight - t.getBoundingClientRect().bottom : null,
    };
  });
const meets = (a: any, b: any) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const decideOne = async (policy?: string) => {
  const k = (await view()).cards.find((x: any) => x.state === "open" && x.kind === "decision" && (!policy || x.policy === policy) && x.prediction && !(x.prediction.standin && x.prediction.standin.basis === "none"));
  await fetch(base + "/api/cards/" + k.id + "/decide", { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ version: k.version, call: { ...k.prediction.call, note: "" } }) });
  return k;
};
const LONG = "Decided go · P1: The Log in button covers the footer links on narrow phones, and the export file has no header row, and its date column reads in UTC";

// 5. (The reviewer's check.) The toast's Undo never meets a Confirm or Done box: phone with isMobile true and false, and desktop;
// a one-line and a three-line toast; at each 40 px of scroll of the current card and of a long one.
// 1. Phone: the toast is never over the tabs; on another tab it sits on the bottom edge.
for (const kind of ["phone", "phone-nomobile", "desk"] as const) {
  const { c, p } = await ctx(kind);
  const k = await decideOne("demo-reply");
  let bad: string[] = [];
  let seen = 0;
  let overTabs = 0;
  for (const text of ["Decided send: " + k.packet.question.slice(0, 40), LONG]) {
    await p.evaluate(([t, id]: string[]) => (window as any).eval("setToast(" + JSON.stringify(t) + ", " + JSON.stringify(id) + "); drawChrome();"), [text, k.id]);
    for (const subject of ["demo-1", "demo-6"]) {
      const id = (await view()).cards.find((x: any) => x.subject === subject).id;
      if (!(await p.$(`[data-card="${id}"]`))) {
        await p.evaluate(() => window.scrollTo(0, 0));
        await p.locator(`.row[data-cur="${id}"]`).click();
        await p.waitForTimeout(1600);
      }
      const h = await p.evaluate(() => document.documentElement.scrollHeight);
      for (let y = 0; y < h; y += 40) {
        await p.evaluate((yy: number) => window.scrollTo(0, yy), y);
        await p.waitForTimeout(50);
        const b = await boxes(p);
        if (!b.undo) continue;
        seen++;
        if (kind !== "desk" && meets(b.toast, b.tabs)) overTabs++;
        for (const x of b.buttons) if (meets(b.undo, x)) bad.push(`${subject} y${y}: undo ${Math.round(b.undo.left)}-${Math.round(b.undo.right)},${Math.round(b.undo.top)}-${Math.round(b.undo.bottom)} button ${Math.round(x.left)}-${Math.round(x.right)},${Math.round(x.top)}-${Math.round(x.bottom)}`);
      }
    }
  }
  check(`5. ${kind}: at every scroll, with a 1-line and a 3-line toast, the Undo meets no Confirm or Done`, seen > 20 && bad.length === 0, seen + " positions with the Undo on screen, " + bad.length + " bad" + (bad.length ? ": " + bad.slice(0, 2).join(" ; ") : ""));
  if (kind !== "desk") {
    check(`1. ${kind}: the toast is never over the tabs`, overTabs === 0, overTabs + " positions over the tabs");
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.locator("[data-tab=decided]").click();
    await p.waitForTimeout(400);
    const b = await boxes(p);
    check(`1. ${kind}: on another tab the toast sits on the bottom edge, with its Undo`, !!b.undo && b.bottomGap !== null && b.bottomGap <= 12, "gap " + b.bottomGap);
  }
  await fetch(base + "/api/cards/" + k.id + "/undo", { method: "POST", headers: H });
  await c.close();
}

// 2. Status: one colon in a held command's line.
{
  const { c, p } = await ctx("desk");
  const k = await decideOne("demo-reply");
  await p.click("[data-tab=status]");
  await p.waitForTimeout(2500);
  const line = (await p.$eval("#tab-status", (e) => (e as HTMLElement).innerText)).split("\n").find((l: string) => /Carry out your call/.test(l)) || "";
  check("2. Status: a held command's line has one colon, and says when it goes out", (line.match(/:/g) || []).length === 1 && /goes out in \d+ s, when your Undo time ends\.$/.test(line) && !/since/.test(line)  /* round 13 wording */, line);
  await fetch(base + "/api/cards/" + k.id + "/undo", { method: "POST", headers: H });
  await c.close();
}

// 3. Phone: the footer text in the card's crops is 14.5 px or more, with 10 px around the red box.
{
  const { c, p } = await ctx("phone");
  const id = (await view()).cards.find((x: any) => x.subject === "demo-1").id;
  if (!(await p.$(`[data-card="${id}"]`))) {
    await p.tap(`.row[data-cur="${id}"]`);
    await p.waitForTimeout(1600);
  }
  await p.waitForFunction((cid) => document.querySelectorAll(`[data-card="${cid}"] .imgpair .crop.ready`).length === 2, id, { timeout: 5000 }).catch(() => {});
  const m = await p.$$eval(`[data-card="${id}"] .imgpair .crop`, (es) => es.map((e) => {
    const i = e.querySelector("img") as HTMLImageElement;
    const r = e.getBoundingClientRect();
    const b = e.querySelector(".redbox")!.getBoundingClientRect();
    return { px: Math.round(((26 * i.getBoundingClientRect().width) / i.naturalWidth) * 10) / 10, top: Math.round(b.top - r.top), left: Math.round(b.left - r.left) };
  }));
  const hs = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check("3. phone: footer text 14.5 px or more in both crops, 10 px around the box, no sideways scroll", m.length === 2 && m.every((x) => x.px >= 14.5 && x.top >= 8 && x.top <= 12 && x.left >= 8) && hs <= 0, JSON.stringify(m) + ", sideways " + hs);
  await c.close();
}

await browser.close();
console.log(fails ? fails + " FAILED" : "ALL PASS");
