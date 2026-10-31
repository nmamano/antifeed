// Round 11 (Antifeed PM's walkthrough of 227a297, 2026-10-25): one or more checks per item.
// It uses up demo cards, so run it on a fresh walkthrough copy:
//   PORT=21199 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/round11-checks.ts http://localhost:21199
import { chromium, devices } from "playwright-core";

const base = process.argv[2];
const H = { "X-Isomux-Member-Id": "m0000000" };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const view = async () => (await (await fetch(base + "/api/view", { headers: H })).json()) as any;
const bySubject = async (s: string) => (await view()).cards.find((c: any) => c.subject === s);
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
};
for (let i = 0; i < 60 && (await view()).cards.some((k: any) => k.state === "predicting" || k.state === "preparing"); i++) await new Promise((r) => setTimeout(r, 500));
async function ctx(kind: "desk" | "phone") {
  const c = await browser.newContext(kind === "phone" ? { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, extraHTTPHeaders: H } : { viewport: { width: 1400, height: 1000 }, extraHTTPHeaders: H });
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await p.goto(base + "/");
  await p.waitForSelector("[data-card]");
  await p.waitForTimeout(1500);
  return { c, p };
}
const open = async (p: any, subject: string, tap = false) => {
  const id = (await bySubject(subject)).id;
  if (await p.$(`[data-card="${id}"]`)) return id;
  if (tap) await p.tap(`.row[data-cur="${id}"]`);
  else await p.click(`.row[data-cur="${id}"]`);
  await p.waitForTimeout(1500);
  return id;
};
const overlap = (a: any, b: any) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// 1. Phone: the toast covers no tab and no Confirm, and it keeps its Undo across tab switches; the same on a desktop.
{
  const { c, p } = await ctx("phone");
  const k = (await view()).cards.find((x: any) => x.state === "open" && x.kind === "decision" && x.prediction && !(x.prediction.standin && x.prediction.standin.basis === "none"));
  const id = await open(p, k.subject, true);
  await p.evaluate(() => window.dispatchEvent(new Event("touchmove")));
  await p.$eval(`[data-card="${id}"] .premove`, (e) => e.scrollIntoView({ block: "start" }));
  await p.waitForTimeout(600);
  const conf = (await p.$(`[data-sticky]:not([hidden]) [data-confirm]`)) || (await p.$(`[data-card="${id}"] .actions [data-confirm]`));
  await conf!.tap();
  await p.waitForTimeout(1200);
  const rects = await p.evaluate(() => {
    const r = (s: string) => { const e = document.querySelector(s) as HTMLElement | null; if (!e || e.closest("[hidden]")) return null; const b = e.getBoundingClientRect(); return b.height ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom } : null; };
    const confirms = [...document.querySelectorAll("[data-confirm], [data-done]")].filter((e) => !(e as HTMLElement).closest("[hidden]")).map((e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; });
    return { toast: r("#toast"), tabs: r("#tabs"), confirms, slot: innerHeight - document.querySelector("#toast")!.getBoundingClientRect().bottom, barTop: (() => { const b = document.querySelector("[data-sticky]") as HTMLElement | null; return b && !b.hidden ? b.getBoundingClientRect().top : null; })() };
  });
  // Round 12: the toast sits just above the bar while it shows, else on the bottom edge.
  const placed = rects.barTop !== null ? rects.toast && rects.toast.bottom <= rects.barTop && rects.barTop - rects.toast.bottom <= 16 : rects.slot <= 12;
  check("1. phone: after a call the toast shows, over no tab and no Confirm, on the bottom edge or just above the bar", !!rects.toast && !overlap(rects.toast, rects.tabs) && !rects.confirms.some((x: any) => overlap(rects.toast, x)) && !!placed, JSON.stringify({ toast: rects.toast, tabs: rects.tabs, slot: Math.round(rects.slot), barTop: rects.barTop }));
  for (const t of ["decided", "accuracy"]) {
    await p.tap(`[data-tab=${t}]`);
    await p.waitForTimeout(500);
  }
  await p.tap("[data-more]");
  await p.waitForTimeout(300);
  await p.tap("[data-tab=status]");
  await p.waitForTimeout(500);
  const u = await p.$eval("[data-toast-undo]", (e) => (e.closest("[hidden]") ? "" : e.textContent)).catch(() => "");
  check("1. phone: after three tab switches the toast and its Undo are still there", /Undo \(1\d s\)|Undo \(2\d s\)/.test(u!), u || "(gone)");
  await p.tap("[data-toast-undo]");
  await p.waitForTimeout(800);
  const back = (await view()).cards.find((x: any) => x.id === k.id);
  check("1. phone: the Undo works from the Status tab", back.state === "open" && !back.decision, back.state);
  await c.close();
  const d = await ctx("desk");
  // A Reply card, so demo-1 stays open for the checks below; the Undo puts it back.
  const k2 = (await view()).cards.find((x: any) => x.state === "open" && x.policy === "demo-reply" && x.prediction);
  await fetch(base + "/api/cards/" + k2.id + "/decide", { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ version: k2.version, call: { ...k2.prediction.call, note: "" } }) });
  await d.p.evaluate((q: string) => (window as any).eval("setToast(" + JSON.stringify("Decided: " + q) + ", " + JSON.stringify(q) + "); drawChrome();"), k2.id);
  for (const t of ["policies", "setup", "status"]) {
    await d.p.click(`[data-tab=${t}]`);
    await d.p.waitForTimeout(300);
  }
  const du = await d.p.$eval("[data-toast-undo]", (e) => (e.closest("[hidden]") ? "" : e.textContent)).catch(() => "");
  check("1. desktop: the toast and its Undo stay across tab switches", /Undo \(\d+ s\)/.test(du!), du || "(gone)");
  await d.p.click("[data-toast-undo]");
  await d.p.waitForTimeout(800);
  await d.c.close();
}

// 2. Desktop and phone: at every scroll, one Confirm shows: the card's, all of it, or the bar's, with none of the card's showing.
for (const kind of ["desk", "phone"] as const) {
  const { c, p } = await ctx(kind);
  const id = await open(p, "demo-1", kind === "phone");
  const bad: string[] = [];
  const h = await p.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += 25) {
    await p.evaluate((yy: number) => window.scrollTo(0, yy), y);
    await p.waitForTimeout(60);
    const s = await p.evaluate((cid: string) => {
      const head = document.querySelector("header")!;
      const top = getComputedStyle(head).position === "sticky" ? head.getBoundingClientRect().bottom : 0;
      const t = document.querySelector("#toast") as HTMLElement;
      const bottom = !t.hidden && getComputedStyle(t).position === "fixed" ? t.getBoundingClientRect().top : innerHeight;
      const cb = document.querySelector(`[data-card="${cid}"] .actions [data-confirm]`)!;
      const r = cb.getBoundingClientRect();
      const shown = getComputedStyle(cb).visibility === "visible";
      const bar = document.querySelector("[data-sticky]") as HTMLElement | null;
      const barOn = !!bar && !bar.hidden;
      const barBottom = barOn && getComputedStyle(bar!).position === "fixed" ? bar!.getBoundingClientRect().top : bottom;
      const seen = shown ? Math.max(0, Math.min(r.bottom, Math.min(bottom, barBottom)) - Math.max(r.top, top)) : 0;
      const z = document.querySelector(`[data-card="${cid}"] .yourcall`)!.getBoundingClientRect();
      return { barOn, full: r.top >= top && r.bottom <= bottom, seen: Math.round(seen), zone: z.bottom > top && z.top < bottom };
    }, id);
    // The bar shows exactly when the card's Confirm is not all on the screen, and then none of the card's shows.
    // Round Q1, C1 (Antifeed PM, 2026-10-29): on a desk, the bar shows exactly when none of Your call is on the screen.
    if ((kind === "desk" ? s.barOn === s.zone : s.barOn === s.full) || (s.barOn && s.seen > 0)) bad.push(y + ":" + JSON.stringify(s));
  }
  check(`2. ${kind}, Log in card: at each 25 px of scroll, the bar follows its rule (desk: none of Your call on the screen; phone: the card's Confirm not all on it), never a strip of the card's next to the bar's`, bad.length === 0, bad.length + " bad positions" + (bad.length ? ": " + bad.slice(0, 3).join(" ; ") : ""));
  await c.close();
}

// 3. Phone: with a More tab open, the tabs are one row.
{
  const { c, p } = await ctx("phone");
  const out = [];
  // Queue round 1 (Antifeed PM, 2026-10-29): every tab behind More, Sources too, and with a
  // filter on, so the Queue tab reads "Queue (n of m)"; More reads "More ▾" and the menu marks the open tab.
  for (const filter of [false, true]) {
    if (filter) await p.evaluate(() => { const w = window as any; w.eval("view").efforts = ["?"]; w.eval("redraw")(); });
    for (const t of ["status", "setup", "sources", "help", "policies"]) {
      await p.tap("[data-more]");
      await p.waitForTimeout(250);
      await p.tap(`[data-tab=${t}]`);
      await p.waitForTimeout(350);
      const shut = await p.evaluate(() => {
        const bs = [...document.querySelectorAll("#tabs button")].filter((e) => getComputedStyle(e).display !== "none");
        return { tops: new Set(bs.map((e) => Math.round(e.getBoundingClientRect().top))).size, h: Math.round(document.querySelector("#tabs")!.getBoundingClientRect().height), labels: bs.map((e) => e.textContent).join("|") };
      });
      // More ▾ does not name the open tab, so the tab names itself at its top.
      const named = await p.evaluate((k) => { const h = document.querySelector(`#tab-${k} .tabname`) as HTMLElement | null; return h && getComputedStyle(h).display !== "none" ? h.textContent : null; }, t);
      await p.tap("[data-more]");
      await p.waitForTimeout(250);
      const marked = await p.evaluate((k) => { const e = document.querySelector(`#tabs [data-tab=${k}]`) as HTMLElement; return !!e && getComputedStyle(e).display !== "none" && e.classList.contains("on"); }, t);
      await p.tap("[data-more]");
      await p.waitForTimeout(250);
      out.push({ t, filter, ...shut, marked, named });
    }
  }
  check("3. phone: on Status, Setup, Sources, Help and Policies, with and without a filter, the tabs stay one row; More reads More ▾; the menu marks the open tab; the tab names itself at its top", out.length === 10 && out.every((o) => o.tops === 1 && o.h <= 60 && o.labels.endsWith("|More ▾") && o.marked && o.named === { status: "Status", setup: "Setup", sources: "Sources", help: "Help", policies: "Policies" }[o.t]) && out.some((o) => / of /.test(o.labels)), JSON.stringify(out));
  await c.close();
}

// 4. The crop keeps 10 px around the red box, on a phone as on a desktop.
for (const kind of ["desk", "phone"] as const) {
  const { c, p } = await ctx(kind);
  const id = await open(p, "demo-1", kind === "phone");
  await p.waitForFunction((cid) => document.querySelectorAll(`[data-card="${cid}"] .imgpair .crop.ready`).length === 2, id, { timeout: 5000 }).catch(() => {});
  const gaps = await p.$$eval(`[data-card="${id}"] .imgpair .crop`, (es) => es.map((e) => {
    const r = e.getBoundingClientRect();
    const b = e.querySelector(".redbox")!.getBoundingClientRect();
    return [Math.round(b.left - r.left), Math.round(b.top - r.top), Math.round(r.right - b.right), Math.round(r.bottom - b.bottom)];
  }));
  check(`4. ${kind}: 8-12 px around the red box on each side the image allows`, gaps.length === 2 && gaps.every((g) => g[1] >= 8 && g[1] <= 12 && g[3] >= 0 && g[3] <= 12 && g[0] >= 8 && g[2] >= 8), JSON.stringify(gaps));
  await c.close();
}

// 5. Words, not ids: Flow's decider; Status's commands; the separator is in the text.
{
  const { c, p } = await ctx("desk");
  const k = (await view()).cards.find((x: any) => x.state === "open" && x.policy === "demo-reply" && x.prediction);
  await fetch(base + "/api/cards/" + k.id + "/decide", { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ version: k.version, call: { ...k.prediction.call, note: "" } }) });
  await p.click("[data-tab=policies]");
  await p.waitForTimeout(400);
  const flow = await p.$eval("#tab-policies", (e) => (e as HTMLElement).innerText);
  check("5. Flow: no handler id, and the event line reads 'seed list · 8 in the log'", !/retry-once/.test(flow) && /seed list · 8 in the log/.test(flow), (flow.match(/Event:[^\n]*/) || [""])[0]);
  await p.click("[data-tab=status]");
  await p.waitForTimeout(2500);
  const st = await p.$eval("#tab-status", (e) => (e as HTMLElement).innerText);
  const line = st.split("\n").find((l) => /Carry out your call/.test(l)) || "";
  check("5. Status: commands in words, with no id in the text", !/demo\.apply|to clerk/.test(st) && /Carry out your call \(a small program inside Antifeed\): goes out in \d+ s, when your Undo time ends\./.test(line)  /* round 13 wording */, line);
  await p.click("[data-tab=setup]");
  await p.waitForTimeout(300);
  const setup = await p.$eval("#tab-setup", (e) => (e as HTMLElement).innerText);
  check("5. Setup still shows the handler id (it has every detail)", /retry-once/.test(setup));
  await c.close();
}

await browser.close();
console.log(fails ? fails + " FAILED" : "ALL PASS");
