// Round 9 (Antifeed PM's walkthrough list, 2026-10-25): one or more checks per item.
// It uses up demo cards, so run it on a fresh walkthrough copy:
//   PORT=21199 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/round9-checks.ts http://localhost:21199
import { chromium, devices } from "playwright-core";

const base = process.argv[2];
const H = { "X-Isomux-Member-Id": "m0000000" };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const view = async () => (await (await fetch(base + "/api/view", { headers: H })).json()) as any;
const bySubject = async (s: string) => (await view()).cards.find((c: any) => c.subject === s);
const post = (path: string, body?: unknown) => fetch(base + path, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
};
for (let i = 0; i < 60 && (await view()).cards.some((k: any) => k.state === "predicting" || k.state === "preparing"); i++) await new Promise((r) => setTimeout(r, 500));
async function ctx(kind: "desk" | "phone" | "dark", height = 1000) {
  const c = await browser.newContext(kind === "phone" ? { ...devices["Pixel 7"], extraHTTPHeaders: H } : { viewport: { width: 1400, height }, extraHTTPHeaders: H, colorScheme: kind === "dark" ? "dark" : "light" });
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
  await p.waitForTimeout(900);
  return id;
};
// WCAG contrast of two "rgb(...)" colors.
function contrast(a: string, b: string) {
  const lum = (s: string) => {
    const [r, g, bl] = s.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// 1. The before/after pair shows the part to look at, cropped and boxed in red, readable without a tap; the viewer boxes it too.
{
  const { c, p } = await ctx("desk");
  const id = await open(p, "demo-1");
  // Round 12 (the reviewer's fix for a flake seen once in round 11): wait until the card is the
  // current one for 500 ms, and both crops are ready, connected and laid out, before reading them.
  await p.waitForFunction((cid) => {
    const w = window as any;
    const now = (document.querySelector("[data-card]") as HTMLElement | null)?.dataset.card;
    if (now !== w.__cid) { w.__cid = now; w.__since = performance.now(); }
    const cs = [...document.querySelectorAll(`[data-card="${cid}"] .imgpair .crop.ready`)];
    return now === cid && performance.now() - w.__since > 500 && cs.length === 2 && cs.every((e) => e.isConnected && e.getBoundingClientRect().width > 0);
  }, id, { timeout: 8000, polling: 100 }).catch(() => {});
  const crops = await p.$$eval(`[data-card="${id}"] .imgpair .crop`, (es) =>
    es.map((e) => {
      const img = e.querySelector("img") as HTMLImageElement;
      const box = e.querySelector(".redbox") as HTMLElement;
      const r = e.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      return { ready: e.classList.contains("ready"), connected: e.isConnected, w: Math.round(r.width), h: Math.round(r.height), scale: img.getBoundingClientRect().width / img.naturalWidth, boxIn: b.width > 20 && b.height > 20 && b.left >= r.left - 1 && b.right <= r.right + 1, color: getComputedStyle(box).borderTopColor };
    }),
  );
  // The demo screenshots are 2x: their 13 px footer text is 26 px in the image.
  check("1. both halves show a crop around the focus, side by side, with a red box", crops.length === 2 && crops.every((x) => x.ready && x.boxIn && x.color === "rgb(224, 0, 0)"), JSON.stringify(crops.map((x) => ({ ready: x.ready, boxIn: x.boxIn, color: x.color, w: x.w, h: x.h, isConnected: x.connected }))));
  check("1. the footer text shows at 11 px or more on the card (was about 5 px)", crops.every((x) => 26 * x.scale >= 11), crops.map((x) => (26 * x.scale).toFixed(1) + " px").join(", "));
  await p.click(`[data-card="${id}"] .imgpair .thumb`);
  await p.waitForTimeout(400);
  const boxes = await p.$$eval("#lb .lbimg .redbox", (es) => es.length);
  check("1. the viewer shows the whole images with the same red box", boxes === 2, boxes + " boxes");
  await p.keyboard.press("Escape");
  await c.close();
}
// 1. Phone: the halves stack, and the text stays readable.
{
  const { c, p } = await ctx("phone");
  const id = await open(p, "demo-1", true);
  const crops = await p.$$eval(`[data-card="${id}"] .imgpair .crop`, (es) => es.map((e) => [Math.round(e.getBoundingClientRect().top), (e.querySelector("img") as HTMLImageElement).getBoundingClientRect().width / (e.querySelector("img") as HTMLImageElement).naturalWidth]));
  check("1. phone: the halves stack, footer text 9 px or more", crops.length === 2 && crops[1][0] > crops[0][0] && crops.every((x) => 26 * x[1] >= 9), JSON.stringify(crops));
  await c.close();
}
// 2. Phone: a swipe right in the viewer goes to the previous image, a swipe left to the next, and the viewer stays open.
{
  const { c, p } = await ctx("phone");
  await open(p, "demo-1", true);
  await p.evaluate(() => {
    (window as any).pops = 0;
    window.addEventListener("popstate", () => (window as any).pops++);
  });
  await p.tap("[data-card] .imgpair .thumb");
  await p.waitForTimeout(400);
  const cdp = await c.newCDPSession(p);
  const where = () => p.$eval("#lb", (e) => ((e as HTMLElement).hidden ? "closed" : (e.querySelector(".lb-bar span")!.textContent!.match(/\((\d) of/) || [])[1]));
  const swipe = async (dir: number) => {
    const x0 = dir > 0 ? 40 : 360;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: 400 }] });
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + dir * i * 35, y: 400 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await p.waitForTimeout(600);
  };
  const s0 = await where();
  await swipe(-1);
  const s1 = await where();
  await swipe(1);
  const s2 = await where();
  await cdp.send("Input.synthesizeScrollGesture", { x: 30, y: 400, xDistance: 300, yDistance: 0, gestureSourceType: "touch", speed: 1500 });
  await p.waitForTimeout(800);
  const s3 = await where();
  const pops = await p.evaluate(() => (window as any).pops);
  // Round 10: on a phone each half of the pair is its own step, so a swipe right from the first goes round to the last.
  const last = await p.$eval("#lb .lb-bar span", (e) => (e.textContent!.match(/of (\d+)\)/) || [])[1]);
  check("2. phone: left goes to the next image, right to the previous, a fast sideways swipe too; the viewer stays open", s0 === "1" && s1 === "2" && s2 === "1" && s3 === last && pops === 0, [s0, s1, s2, s3].join(" -> ") + ", Back events " + pops);
  await c.close();
}
// 3. Undo undoes: the command of a call waits for the Undo time; an Undo in it cancels the command.
{
  const { c, p } = await ctx("desk");
  const k = (await view()).cards.find((x: any) => x.state === "open" && x.policy === "demo-reply" && x.prediction && !(x.prediction.standin && x.prediction.standin.basis === "none"));
  const id = await open(p, k.subject);
  await p.click(`[data-card="${id}"] .premove details > summary`);
  await p.waitForTimeout(900);
  const applies = async () => (await view()).flow["demo-reply"].commands["demo.apply"] || {};
  const a0 = await applies();
  await p.click(`[data-card="${id}"] .yourcall [data-confirm]`);
  await p.waitForTimeout(2000);
  const a1 = await applies();
  check("3. 2 s after Confirm, the call's command has not run: it waits", (a1.waiting || 0) === (a0.waiting || 0) + 1 && (a1.done || 0) === (a0.done || 0), JSON.stringify([a0, a1]));
  await p.click("[data-toast-undo]");
  await p.waitForTimeout(1000);
  const a2 = await applies();
  const toast = await p.$eval("#toast", (e) => e.textContent);
  check("3. the toast's Undo cancels the command; nothing ran, and the toast says no more", (a2.undone || 0) === (a0.undone || 0) + 1 && (a2.done || 0) === (a0.done || 0) && !/already ran/.test(toast!), JSON.stringify(a2) + " | " + toast);
  // A call that stays goes out after the Undo time.
  await open(p, k.subject);
  await p.waitForTimeout(400);
  await p.click(`[data-card="${id}"] .premove details > summary`);
  await p.waitForTimeout(900);
  await p.click(`[data-card="${id}"] .yourcall [data-confirm]`);
  await p.waitForTimeout(26_500);
  const a3 = await applies();
  check("3. a call that is not undone has its command done after the 24 s", (a3.done || 0) === (a0.done || 0) + 1, JSON.stringify(a3));
  await c.close();
}
// 5. The filters fold into one line on the desktop; the card starts high. Phone: the bottom bar hides while the filters are open.
{
  const { c, p } = await ctx("desk");
  const hidden = await p.$eval(".controls", (e) => getComputedStyle(e).display === "none");
  const top = await p.$eval("[data-card]", (e) => Math.round(e.getBoundingClientRect().top));
  const line = await p.$eval(".qhead", (e) => e.textContent);
  check("5. desktop: the filters are folded, one line says what shows, and the card starts under 200 px", hidden && top < 200, top + " px | " + line);
  await p.click("[data-filters]");
  await p.waitForTimeout(200);
  check("5. desktop: Filters and sort opens them", await p.$eval(".controls", (e) => getComputedStyle(e).display !== "none"));
  await c.close();
  const q = await ctx("phone");
  while (await q.p.$("[data-card] [data-done]")) {
    await q.p.tap("[data-card] [data-step='1']");
    await q.p.waitForTimeout(900);
  }
  await q.p.$eval("[data-card] .premove", (e) => e.scrollIntoView({ block: "start" }));
  await q.p.waitForTimeout(400);
  const bar0 = await q.p.$eval("[data-sticky]", (e) => (e as HTMLElement).hidden);
  await q.p.evaluate(() => window.scrollTo(0, 0));
  await q.p.tap("[data-filters]");
  await q.p.waitForTimeout(300);
  await q.p.$eval("[data-card] .premove", (e) => e.scrollIntoView({ block: "start" }));
  await q.p.waitForTimeout(400);
  const bar1 = await q.p.$eval("[data-sticky]", (e) => (e as HTMLElement).hidden);
  check("5. phone: the bottom bar shows with the filters closed, and hides while they are open", bar0 === false && bar1 === true, bar0 + " -> " + bar1);
  await q.c.close();
}
// 6. Desktop: one Confirm on the screen. The header bar shows only while the whole of Your call is off the screen, and follows a search.
// A 600 px tall window, so the packet can push Your call off the screen.
{
  const { c, p } = await ctx("desk", 600);
  const id = await open(p, "demo-1");
  await p.$eval(`[data-card="${id}"] .yourcall`, (e) => e.scrollIntoView({ block: "end" }));
  await p.waitForTimeout(400);
  const withZone = await p.$eval("[data-sticky]", (e) => (e as HTMLElement).hidden).catch(() => true);
  await p.$eval(`[data-card="${id}"] .yourcall`, (e) => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 140 + 30));
  await p.waitForTimeout(400);
  const partly = await p.$eval("[data-sticky]", (e) => (e as HTMLElement).hidden).catch(() => true);
  await p.$eval(`[data-card="${id}"] .packet`, (e) => e.scrollIntoView({ block: "end" }));
  await p.waitForTimeout(400);
  const off = await p.$eval("[data-sticky]", (e) => (e as HTMLElement).hidden).catch(() => true);
  // Round 10: the bar follows the Confirm row, which is still on the screen in the "partly" case.
  check("6. the call bar hides while the Confirm row shows, and shows once it is off the screen", withZone === true && partly === true && off === false, [withZone, partly, off].join(" "));
  // 7. A search counts in the tab, and the bar follows the card the search leaves.
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.click("[data-filters]");
  await p.fill("[data-view=q]", "refund");
  await p.waitForTimeout(500);
  const tab = await p.$eval("[data-tab=queue]", (e) => e.textContent);
  const cur = await p.$eval("[data-card]", (e) => (e as HTMLElement).dataset.card);
  const barFor = await p.$eval("[data-sticky]", (e) => (e as HTMLElement).dataset.sticky).catch(() => "");
  check("7. a search changes the tab count", /^Queue \(1 of \d+\)$/.test(tab!), tab!);
  check("6. 0.5 s after a search, the call bar is the current card's", barFor === cur, barFor + " / " + cur);
  await c.close();
}
// 8. Hover help: a styled tip at the page's size; copy fixed; the four gaps filled.
{
  const { c, p } = await ctx("desk");
  const id = await open(p, "demo-1");
  await p.hover(`[data-card="${id}"] .yourcall [data-field=priority][data-v='"P2"']`);
  await p.waitForTimeout(700);
  const tip = await p.$eval(".tip", (e) => [(e as HTMLElement).hidden, e.textContent, getComputedStyle(e).fontSize]);
  const native = await p.$eval(`[data-card="${id}"] .yourcall [data-field=priority][data-v='"P2"']`, (e) => e.getAttribute("title"));
  check("8. a styled tip shows after 0.4 s at 15 px, and the browser's own tip is held back", tip[0] === false && tip[1] === "Set priority to P2" && tip[2] === "15px" && native === null, JSON.stringify(tip) + " native " + native);
  await p.mouse.move(5, 5);
  await p.waitForTimeout(300);
  const gaps = await p.evaluate((cid) => {
    const t = (s: string) => document.querySelector(s)?.getAttribute("title") || "";
    return { chat: t(`[data-card="${cid}"] [data-chatsend]`), who: t(`[data-card="${cid}"] .premove > .zlabel .who`), title: t(`[data-card="${cid}"] [data-text=title]`) };
  }, id);
  check("8. the chat's Send, who made the Premove, and the New title box have help", Object.values(gaps).every(Boolean), JSON.stringify(gaps));
  const all = await p.$$eval("[title]", (es) => es.map((e) => e.getAttribute("title")!));
  const bad = all.filter((t) => /\btap\b|A field of your call|Open this fold|tasks unknown filed/i.test(t));
  check("8. no desktop tip says tap, and the empty tips are gone", bad.length === 0, bad.slice(0, 4).join(" ; "));
  const labels = await p.$$eval(`[data-card="${id}"] .yourcall .flabel`, (es) => es.map((e) => e.textContent + ": " + e.getAttribute("title")));
  check("8. Call and Priority have their own help", new Set(labels.map((l) => l.split(": ").slice(1).join(": "))).size === labels.length, labels.join(" ; "));
  // The header bar's call text, once the bar shows.
  await p.evaluate(() => window.scrollBy(0, 3000));
  await p.waitForTimeout(400);
  const sb = await p.$eval("[data-sticky] .sbcall", (e) => e.getAttribute("title")).catch(() => "");
  check("8. the call bar's call text has help", !!sb, sb!);
  // 10. All, not Any.
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.click("[data-filters]");
  // Queue round 1, F2: a segment shows its count after its label; the label alone here.
  const floor = await p.$$eval("[data-seg=floor]", (es) => es.map((e) => [...e.childNodes].filter((n) => !(n.nodeType === 1 && (n as Element).classList.contains("cnt"))).map((n) => n.textContent).join("").trim()));
  // Queue round 1 (G3): All goes last.
  check("10. Predictor's priority says All, as every filter does", floor[floor.length - 1] === "All" && !floor.includes("Any"), floor.join(","));
  // 11. Round 10 changed it: Against is as tall as its text, not as the Premove.
  await p.click("[data-filters]");
  const hs = await p.$eval(`[data-card="${id}"] .pa`, (e) => [...e.children].map((x) => Math.round(x.getBoundingClientRect().height)));
  check("11. (round 10 rule) desktop: Against is no taller than the Premove beside it", hs.length === 2 && hs[1] <= hs[0], hs.join(" / "));
  // 11. Terms: no row ends on an arrow. Round q1b, P7: the cycle of boxes and
  // arrows is now a numbered list in Help (tools/pages-checks.ts 7), so there is no arrow to check.
  // 11. Flow: one table for the demo's three policies; the event count is set apart.
  await p.click("[data-tab=policies]");
  await p.waitForTimeout(300);
  // Only the demo's section counts (round q1b: its heading is "Project: demo"): Antifeed's own policy (failed commands)
  // and, since slice 7, the walkthrough's Inbox have "Does" columns of their own.
  const flow = await p.evaluate(() => {
    const section = (e: Element) => {
      let n: Element | null = e.closest(".flowgrid, .flowtable, .flowreads");
      while (n && n.tagName !== "H2") n = n.previousElementSibling;
      return n?.textContent ?? "";
    };
    return { tables: [...document.querySelectorAll(".flowtable")].filter((e) => section(e) === "Project: demo").length, does: [...document.querySelectorAll(".fhead")].filter((e) => e.textContent === "Does" && section(e) === "Project: demo").length, sep: (document.querySelector(".flowreads .ev") as HTMLElement).innerText };
  });  // round 11: the separator is in the text
  check("11. Flow: the three same policies show as one table, and the count reads apart from the source", flow.tables === 1 && flow.does === 0 && /·/.test(flow.sep), JSON.stringify(flow));
  await c.close();
}
// 9. Phone: the toast wraps. 11. Phone: a step's tick is a 44 px target.
{
  const { c, p } = await ctx("phone");
  const a = (await view()).cards.find((k: any) => k.kind === "action" && k.state === "open" && !k.held);
  const id = await open(p, a.subject, true);
  const lab = await p.$$eval(`[data-card="${id}"] .checklist label`, (es) => es.map((e) => Math.round(e.getBoundingClientRect().height)));
  check("11. phone: each step's tick has a 44 px target", lab.length > 0 && lab.every((h) => h >= 44), lab.join(","));
  const k = (await view()).cards.find((x: any) => x.state === "open" && x.kind === "decision" && x.prediction && !(x.prediction.standin && x.prediction.standin.basis === "none"));
  await post("/api/cards/" + k.id + "/decide", { version: k.version, call: { ...k.prediction.call, note: "" } });
  await p.evaluate(() => (window as any).eval('setToast("Decided design · P1: The export file has no header row, and its date column reads in UTC", null, 30000); drawChrome();'));
  await p.waitForTimeout(300);
  const t = await p.$eval("#toast .ttext", (e) => [getComputedStyle(e).whiteSpace, e.scrollHeight <= e.clientHeight + 1]);
  check("9. phone: the toast text wraps, and all of it shows", t[0] === "normal" && t[1] === true, JSON.stringify(t));
  await c.close();
}
// 11. Decided, when empty, says what lands there. 12. Dark: the placeholders reach 4.5:1.
{
  const fresh = await view();
  const none = !fresh.cards.some((x: any) => x.decision || x.held || x.state === "done" || x.state === "withdrawn");
  const { c, p } = await ctx("dark");
  if (none) {
    await p.click("[data-tab=decided]");
    await p.waitForTimeout(300);
    const t = await p.$eval("#tab-decided .empty", (e) => e.textContent);
    check("11. Decided, when empty, says what lands there", /Your calls show here/.test(t!), t!);
  } else {
    const t = await p.evaluate(() => (window as any).eval("V.cards = V.cards.filter((x) => !(x.decision || x.held || x.state === 'done' || x.state === 'withdrawn')); decidedParts()[0][1]"));
    check("11. Decided, when empty, says what lands there", /Your calls show here/.test(t), t);
    await p.reload();
    await p.waitForSelector("[data-card]");
  }
  const pairs = await p.$$eval("[data-note], [data-text]", (es) => es.slice(0, 2).map((e) => [getComputedStyle(e, "::placeholder").color, getComputedStyle(e).backgroundColor]));
  const ratios = pairs.map(([fg, bg]) => contrast(fg, bg));
  check("12. dark: the placeholders reach 4.5:1", ratios.length > 0 && ratios.every((r) => r >= 4.5), ratios.map((r) => r.toFixed(2)).join(", "));
  await c.close();
}
await browser.close();
console.log(fails ? fails + " FAILED" : "ALL PASS");
