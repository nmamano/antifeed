// Round 10 (Antifeed PM's walkthrough list, 2026-10-25): one or more checks per item.
// It uses up demo cards, so run it on a fresh walkthrough copy:
//   PORT=21199 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/round10-checks.ts http://localhost:21199
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
async function ctx(kind: "desk" | "phone" | "dark", height = 1000) {
  const c = await browser.newContext(kind === "phone" ? { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, extraHTTPHeaders: H } : { viewport: { width: 1400, height }, extraHTTPHeaders: H, colorScheme: kind === "dark" ? "dark" : "light" });
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
// Where each element below the hint line is, in page coordinates (a scroll does not change them).
const below = (p: any, id: string) =>
  p.evaluate((cid: string) => {
    const card = document.querySelector(`[data-card="${cid}"]`)!;
    const hint = card.querySelector("[data-cfhint]")!;
    const hy = hint.getBoundingClientRect().top;
    const els = [hint, ...card.querySelectorAll(".yourcall ~ *, .yourcall [data-cfhint] ~ *"), card, ...document.querySelectorAll(".row")];
    return { text: hint.textContent, ys: els.map((e) => { const r = e.getBoundingClientRect(); return r.top >= hy - 1 || e === card ? Math.round(r.bottom + scrollY) : null; }) };
  }, id);

// 1. Nothing moves when Confirm or Done unlocks: the hint line keeps its height.
for (const [kind, subject] of [["desk", "demo-1"], ["desk", "demo-6"], ["phone", "demo-1"], ["phone", "demo-6"]] as const) {
  const { c, p } = await ctx(kind);
  const id = await open(p, subject, kind === "phone");
  // Nil, 2026-10-29: the packet comes first, so the Premove is shown before the act.
  await p.evaluate((cid: string) => document.querySelector(`[data-card="${cid}"] .zone.premove`)?.scrollIntoView({ block: "center" }), id);
  await p.waitForTimeout(500);
  const a = await below(p, id);
  if (kind === "desk") {
    const box = (await (await p.$(`[data-card="${id}"] .zlabel`))!.boundingBox())!;
    await p.mouse.move(box.x + 10, box.y + 5);
    await p.mouse.move(box.x + 200, box.y + 5, { steps: 8 });
  } else await p.evaluate(() => window.dispatchEvent(new Event("touchmove")));
  await p.waitForTimeout(500);
  const b = await below(p, id);
  const moved = a.ys.filter((y: number | null, i: number) => y !== null && y !== b.ys[i]).length;
  check(`1. ${kind} ${subject}: at unlock the hint changes and nothing below it moves`, a.text !== b.text && /undo/.test(b.text) && moved === 0, JSON.stringify(a.text) + " -> " + JSON.stringify(b.text) + ", " + moved + " of " + a.ys.filter((y: any) => y !== null).length + " moved");
  await c.close();
}

// 2. Phone viewer: one image of the pair at a time, at full width; a swipe goes from Before to After and back.
// 10. Back from the viewer lands on #queue.
{
  const { c, p } = await ctx("phone");
  await open(p, "demo-1", true);
  await p.tap("[data-card] .imgpair .thumb");
  await p.waitForTimeout(500);
  const shot = () => p.evaluate(() => {
    const lb = document.querySelector("#lb") as HTMLElement;
    const imgs = [...lb.querySelectorAll(".lbimg img")] as HTMLImageElement[];
    return { open: !lb.hidden, n: imgs.length, w: imgs[0] ? Math.round(imgs[0].getBoundingClientRect().width) : 0, scale: imgs[0] ? imgs[0].getBoundingClientRect().width / imgs[0].naturalWidth : 0, bar: lb.querySelector(".lb-bar span")!.textContent, label: lb.querySelector(".lb-label")?.textContent };
  });
  const s0 = await shot();
  // The demo screenshots are 2x: their 13 px footer text is 26 px in the image.
  check("2. phone viewer: one image at the screen's width, its text at 14 px or more", s0.open && s0.n === 1 && s0.w >= 0.9 * 390 && 26 * s0.scale >= 14, JSON.stringify(s0) + ", text " + (26 * s0.scale).toFixed(1) + " px");
  const cdp = await c.newCDPSession(p);
  const swipe = async (dir: number) => {
    const x0 = dir > 0 ? 40 : 350;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: 400 }] });
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + dir * i * 35, y: 400 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await p.waitForTimeout(600);
  };
  await swipe(-1);
  const s1 = await shot();
  await swipe(1);
  const s2 = await shot();
  check("2. phone viewer: a swipe left shows After, a swipe right Before again", s0.label === "Before" && s1.label === "After" && s2.label === "Before" && s1.open && s2.open, [s0.bar, s1.bar, s2.bar].join(" -> "));
  // A Back within 1 s of a swipe counts as the swipe's (round 9); this one comes later.
  await p.waitForTimeout(1200);
  await p.evaluate(() => history.back());
  await p.waitForTimeout(600);
  const after = await p.evaluate(() => [(document.querySelector("#lb") as HTMLElement).hidden, location.hash]);
  check("10. Back from the viewer closes it and the address keeps #queue", after[0] === true && after[1] === "#queue", JSON.stringify(after));
  await c.close();
}

// 3. Desktop: one Confirm is always on the screen: the card's own, or the call bar's once the card's is off the screen.
{
  const { c, p } = await ctx("desk");
  const k = (await view()).cards.find((x: any) => x.policy === "demo-design" && x.state === "open");
  const id = await open(p, k.subject);
  const counts = [];
  for (const y of [0, 300, 600, 900, 1400]) {
    await p.evaluate((yy: number) => window.scrollTo(0, yy), y);
    await p.waitForTimeout(350);
    counts.push(await p.evaluate((cid: string) => {
      const seen = (e: Element | null) => {
        if (!e || (e as HTMLElement).closest("[hidden]")) return false;
        const r = e.getBoundingClientRect();
        const head = document.querySelector("header")!.getBoundingClientRect().bottom;
        return r.height > 0 && r.bottom <= innerHeight && r.top >= (e.closest("header") ? 0 : head);
      };
      // Round Q1, C1 (Antifeed PM, 2026-10-29): the bar shows exactly when none of Your call is on the screen.
      const z = document.querySelector(`[data-card="${cid}"] .yourcall`)!.getBoundingClientRect();
      const head = document.querySelector("header")!.getBoundingClientRect().bottom;
      const zone = z.bottom > head && z.top < innerHeight;
      const bar = !!document.querySelector("[data-sticky]:not([hidden])");
      const n = [seen(document.querySelector(`[data-card="${cid}"] .actions [data-confirm]`)), seen(document.querySelector("[data-sticky] [data-confirm]"))].filter(Boolean).length;
      return n <= 1 && bar !== zone ? 1 : 0;
    }, id));
  }
  check("3. desktop, design card: at each scroll, never two Confirms, and the bar exactly when none of Your call is on the screen", counts.every((n) => n === 1), "scroll 0, 300, 600, 900, 1400: " + counts.join(","));
  await c.close();
}

// 4. Against is as tall as its text. 5. The crop keeps a small margin around the red box.
{
  const { c, p } = await ctx("desk");
  const id = await open(p, "demo-1");
  const ag = await p.$eval(`[data-card="${id}"] .against`, (e) => {
    const r = e.getBoundingClientRect();
    const last = e.lastElementChild!.getBoundingClientRect();
    return Math.round(r.bottom - last.bottom);
  });
  check("4. desktop: Against ends under its text (no empty band)", ag <= 24, ag + " px under its last line");
  await p.waitForFunction((cid) => document.querySelectorAll(`[data-card="${cid}"] .imgpair .crop.ready`).length === 2, id, { timeout: 5000 }).catch(() => {});
  const gaps = await p.$$eval(`[data-card="${id}"] .imgpair .crop`, (es) => es.map((e) => {
    const r = e.getBoundingClientRect();
    const b = e.querySelector(".redbox")!.getBoundingClientRect();
    return [Math.round(b.top - r.top), Math.round(r.bottom - b.bottom)];
  }));
  check("5. desktop: the crop keeps 20 px or less of margin above and below the red box", gaps.length === 2 && gaps.flat().every((g) => g >= 0 && g <= 20), JSON.stringify(gaps));
  await c.close();
  const q = await ctx("phone");
  const id2 = await open(q.p, "demo-1", true);
  await q.p.waitForTimeout(500);
  const px = await q.p.$$eval(`[data-card="${id2}"] .imgpair .crop img`, (es) => es.map((e) => Math.round((26 * (e as HTMLImageElement).getBoundingClientRect().width) / (e as HTMLImageElement).naturalWidth * 10) / 10));
  check("5. phone: the footer text in the card's crops is 13.5 px or more (was about 12)", px.length === 2 && px.every((x) => x >= 13.5), px.join(", ") + " px");
  await q.c.close();
}

// 6. A press hides the tip, and it does not come back while the mouse stays.
{
  const { c, p } = await ctx("desk");
  await p.hover("[data-filters]");
  await p.waitForTimeout(700);
  const shown = await p.$eval(".tip", (e) => !(e as HTMLElement).hidden);
  await p.mouse.down();
  await p.mouse.up();
  await p.waitForTimeout(900);
  const after = await p.$eval(".tip", (e) => !(e as HTMLElement).hidden);
  check("6. Filters and sort: the tip shows on hover, and is gone after the press", shown && !after, shown + " -> " + after);
  await c.close();
}

// 7. Copy. 8. Flow says each command and event in words.
{
  const k = (await view()).cards.find((x: any) => x.state === "open" && x.policy === "demo-reply" && x.prediction);
  await fetch(base + "/api/cards/" + k.id + "/decide", { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ version: k.version, call: { ...k.prediction.call, note: "" } }) });
  const { c, p } = await ctx("desk");
  await p.click("[data-tab=decided]");
  await p.waitForTimeout(300);
  const intro = await p.$eval("#tab-decided", (e) => (e as HTMLElement).innerText);
  check("7. Decided: a call's commands wait for the Undo time too", /What your call or your Done starts waits 24 s/.test(intro), intro.slice(0, 160));
  await p.click("[data-tab=help]");
  await p.waitForTimeout(300);
  // Round q1b, P7: the cycle is a numbered list in Help; its call step is a sentence of its own.
  const cyc = await p.$eval("ol.steps", (e) => (e as HTMLElement).innerText.replace(/\s+/g, " "));
  check("7. Help: the call step does not start mid-sentence", !/or, only if you switch it/.test(cyc) && /Your call:/.test(cyc), cyc);
  await p.click("[data-tab=setup]");
  await p.waitForTimeout(300);
  const tips = await p.$$eval("#tab-setup [title]", (es) => es.map((e) => e.getAttribute("title")));
  check("7. Setup: no tip is a bare id", !tips.some((t) => /^[a-z-]+$/.test(t || "")), tips.filter((t) => /handler/i.test(t || "")).join(" ; "));
  await p.click("[data-tab=policies]");
  await p.waitForTimeout(300);
  const flow = await p.$eval("#tab-policies", (e) => (e as HTMLElement).innerText);
  const ids = ["demo.apply", "demo.ask-nil", "demo.item"].filter((x) => flow.includes(x));
  const named = await p.$$eval("#tab-policies .named", (es) => es.map((e) => e.getAttribute("title")));
  check("8. Flow: no command or event id in the text; each id is in a tip", ids.length === 0 && named.some((t) => /demo\.apply/.test(t!)) && named.some((t) => /demo\.item/.test(t!)), "ids shown: " + (ids.join(",") || "none") + " | tips: " + named.join(" ; "));
  // 7. Status: a command of a call says it waits for the Undo time.
  await p.click("[data-tab=status]");
  await p.waitForTimeout(2500);
  const st = await p.$eval("#tab-status", (e) => (e as HTMLElement).innerText);
  // Round 11: the line names the command in words ("Carry out your call"), its id in the tip.
  const line = st.split("\n").find((l) => /Carry out your call/.test(l)) || "";
  check("7. Status: a held command says it waits for the Undo time, with the time left", /goes out in \d+ s, when your Undo time ends/.test(line)  /* round 13 wording */, line);
  await c.close();
}

// 9. Phone: More keeps one row; the Flow values line up; "Filed by" stays on one line.
{
  const { c, p } = await ctx("phone");
  await p.tap("[data-more]");
  await p.waitForTimeout(300);
  const tops = await p.$$eval("#tabs button", (es) => es.filter((e) => getComputedStyle(e).display !== "none").map((e) => [e.textContent, Math.round(e.getBoundingClientRect().top)]));
  check("9. phone: with More open, the tabs are one row", new Set(tops.map((t) => t[1])).size === 1, JSON.stringify(tops));
  await p.tap("[data-tab=policies]");
  await p.waitForTimeout(400);
  const lefts = await p.$$eval(".flowtable td > span", (es) => [...new Set(es.map((e) => Math.round(e.getBoundingClientRect().left)))]);
  check("9. phone Flow: the values start at one x", lefts.length === 1, lefts.join(","));
  await p.tap("[data-tab=queue]").catch(async () => {
    await p.tap("[data-more]");
    await p.tap("[data-tab=queue]");
  });
  await p.waitForTimeout(400);
  const id = await open(p, "demo-1", true);
  const fb = await p.$eval(`[data-card="${id}"] table.fields td`, (e) => [e.textContent, Math.round(e.getBoundingClientRect().height)]);
  check("9. phone: the Filed by label is one line", (fb[1] as number) <= 30, JSON.stringify(fb));
  await c.close();
}

// 10. Accessible names; the step boxes take the page's colors in dark.
{
  const { c, p } = await ctx("dark");
  const id = await open(p, "demo-1");
  const name = await p.$eval(`[data-card="${id}"] .actions [data-confirm]`, (e) => e.getAttribute("aria-label"));
  const a = (await view()).cards.find((k: any) => k.kind === "action" && k.state === "open" && !k.held);
  const aid = await open(p, a.subject);
  const dn = await p.$eval(`[data-card="${aid}"] .actions [data-done]`, (e) => e.getAttribute("aria-label"));
  check("10. Confirm and Done have their own names", name === "Confirm" && dn === "Done", name + ", " + dn);
  const box = await p.$eval(`[data-card="${aid}"] .checklist input`, (e) => [getComputedStyle(e).colorScheme, getComputedStyle(e).accentColor, Math.round(e.getBoundingClientRect().width)]);
  check("10. desktop dark: the step boxes use the dark scheme and the accent, 18 px", /dark/.test(box[0] as string) && box[2] === 18, JSON.stringify(box));
  await c.close();
}

await browser.close();
console.log(fails ? fails + " FAILED" : "ALL PASS");
