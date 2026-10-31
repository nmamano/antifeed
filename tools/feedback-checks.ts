// The checks for Nil's loop app feedback (projects/isomux/LOOP-APP-FEEDBACK.md):
// one or more per line that round 8 fixed. It uses up the demo cards, so run
// it on a fresh walkthrough copy:
//   PORT=21199 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/feedback-checks.ts http://localhost:21199
import { chromium, devices } from "playwright-core";
import { readFileSync } from "node:fs";
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
async function desk() {
  const c = await browser.newContext({ viewport: { width: 1400, height: 1000 }, extraHTTPHeaders: H, permissions: ["clipboard-read", "clipboard-write"] });
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
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

// The card draws again when the queue's length changes: wait until every demo card has its Premove.
for (let i = 0; i < 60 && (await view()).cards.some((k: any) => k.state === "predicting" || k.state === "preparing"); i++) await new Promise((r) => setTimeout(r, 500));
const { c, p } = await desk();
await p.goto(base + "/");
await p.waitForSelector("[data-card]");
await p.waitForTimeout(1500);
const id1 = await open(p, "demo-1");
const card = `[data-card="${id1}"]`;

// L154, then Nil, 2026-10-29 ("the task is described AGAIN"): the question, the packet's blocks, Premove and Against, Your call.
{
  const order = await p.$eval(card, (e) => [...e.querySelectorAll(":scope > .question, :scope > .pa, :scope > .yourcall, :scope > .packet")].map((x) => x.className.replace(/\s+/g, ".")));
  check("L154 card order: question, the packet, Premove/Against, Your call", order.join(" ") === "question packet.pbody pa zone.yourcall", order.join(" "));
}
// L41: a wide page.
check("L41 the page is up to 1240 px wide", (await p.$eval("main", (e) => getComputedStyle(e).maxWidth)) === "1240px");
// L39: the task id, and Copy puts it on the clipboard.
{
  const shown = await p.$eval(`${card} .tid code`, (e) => e.textContent);
  await p.click(`${card} [data-copy]`);
  await p.waitForTimeout(300);
  const clip = await p.evaluate(() => navigator.clipboard.readText());
  const label = await p.$eval(`${card} [data-copy]`, (e) => e.textContent);
  check("L39 the card head shows the task id, and Copy copies it", shown === "demo-1" && clip === "demo-1" && label === "Copied", shown + " / " + clip + " / " + label);
}
// L31: the button and e open every fold, then close them.
{
  const folds = () => p.$$eval(`${card} .packet details`, (es) => es.map((e) => (e as HTMLDetailsElement).open));
  const label = () => p.$eval(`${card} [data-openall]`, (e) => e.textContent);
  await p.click(`${card} [data-openall]`);
  const a = await folds();
  const la = await label();
  await p.click(`${card} [data-openall]`);
  const b = await folds();
  const lb = await label();
  await p.click("h1");
  await p.keyboard.press("e");
  const e1 = await folds();
  await p.keyboard.press("e");
  const e2 = await folds();
  check("L31 Open all folds opens every fold, then reads Close all folds and closes them", a.every(Boolean) && /^Close all folds/.test(la!) && b.every((x) => !x) && /^Open all folds/.test(lb!), JSON.stringify([a, la, b, lb]));
  check("L31 e opens every fold, and e again closes them", e1.length > 0 && e1.every(Boolean) && e2.every((x) => !x), JSON.stringify([e1, e2]));
}
// L81: the before/after pair sits side by side on a desktop, and opens as the pair.
{
  const ys = await p.$$eval(`${card} .imgpair .thumb`, (es) => es.map((e) => [Math.round(e.getBoundingClientRect().top), e.querySelector(".side")?.textContent]));
  await p.click(`${card} .imgpair .thumb`);
  await p.waitForTimeout(300);
  const imgs = await p.$$eval("#lb .lb-body img", (es) => es.map((e) => [Math.round(e.getBoundingClientRect().left), Math.round(e.getBoundingClientRect().top)]));
  const labels = await p.$$eval("#lb .lb-label", (es) => es.map((e) => e.textContent).join(","));
  check("L81 desktop: the pair is side by side, before then after", ys.length === 2 && ys[0][0] === ys[1][0] && ys[0][1] === "Before" && ys[1][1] === "After", JSON.stringify(ys));
  check("L81 the viewer opens the pair as a pair, side by side", imgs.length === 2 && imgs[0][1] === imgs[1][1] && imgs[0][0] < imgs[1][0] && labels === "Before,After", JSON.stringify(imgs) + " " + labels);
  // L80: a click on the black closes it.
  const body = (await (await p.$("#lb .lb-body"))!.boundingBox())!;
  await p.mouse.click(body.x + 4, body.y + body.height - 4);
  await p.waitForTimeout(300);
  check("L80 a click on the backdrop closes the viewer", await p.$eval("#lb", (e) => (e as HTMLElement).hidden));
}
// L130: the value hold reads "on hold"; the log keeps "hold".
{
  const chips = await p.$$eval(`${card} .yourcall [data-field=choice]`, (es) => es.map((e) => e.textContent));
  check("L130 the hold chip reads on hold", chips.includes("on hold") && !chips.includes("hold"), chips.join(","));
}
// L129: every visible button, chip and label has hover help, on every tab.
{
  const missing: string[] = [];
  for (const t of ["queue", "decided", "accuracy", "policies", "setup", "status", "help"]) {
    await p.click(`[data-tab=${t}]`);
    await p.waitForTimeout(t === "status" ? 700 : 250);
    // Round 9: a fold's own words are its label (no tip); the tip under the mouse holds its title aside (_tip).
    missing.push(...(await p.$$eval("button, .chip, .kchip, .flabel, .clabel, .zlabel > span:first-child, .kind", (es) => es.filter((e) => (e as HTMLElement).offsetParent && !e.getAttribute("title") && (e as any)._tip === undefined && !e.querySelector("[title]")).map((e) => e.outerHTML.slice(0, 70)))).map((x) => t + ": " + x));
  }
  check("L129 every visible button, chip and label has hover help (7 tabs)", missing.length === 0, missing.slice(0, 6).join(" ; "));
  await p.click("[data-tab=queue]");
  await p.waitForTimeout(300);
}
// L57: the sorts. Queue round 1 (F7) replaced the five sorts with four keys in
// two directions, the Predictor's priority highest first by default; every order
// is checked in tools/queue-r1-f-checks.ts. Here: the default, and its order.
// Round 9: the filters and sorts fold away behind "Filters and sort".
await p.click("[data-filters]");
await p.waitForTimeout(200);
{
  const labels = await p.$$eval("[data-seg=sort], [data-seg=dir]", (es) => es.map((e) => e.textContent + (e.classList.contains("on") ? "*" : "")));
  check("L57 four sort keys, Priority highest first the default", labels.join(",") === "Priority*,Age,Effort,Confidence,Highest first*,Lowest first", labels.join(","));
  const f = await p.evaluate(() => {
    const w = (window as any).eval;
    const { list } = w("queueLists()");
    const rest = [...document.querySelectorAll("[data-cur]")].map((e) => (e as HTMLElement).dataset.cur);
    const cur = (document.querySelector("[data-card]") as HTMLElement).dataset.card;
    return {
      domOk: JSON.stringify(list.map((c: any) => c.id).filter((x: string) => x !== cur)) === JSON.stringify(rest),
      rows: list.filter((c: any) => c.kind !== "action").map((c: any) => ({ pre: w("premoveRank")(c) ?? 99, at: c.meta.openedAt })),
      actionsFirst: list.findIndex((c: any) => c.kind !== "action") >= list.filter((c: any) => c.kind === "action").length,
    };
  });
  const ok = f.rows.every((r: any, i: number) => i === 0 || f.rows[i - 1].pre < r.pre || (f.rows[i - 1].pre === r.pre && f.rows[i - 1].at <= r.at));
  check("L57 sort Priority, highest first: in order, ties older first, actions first, the rows as the list", ok && f.domOk && f.actionsFirst, JSON.stringify(f.rows.map((r: any) => r.pre)));
}
// L58 and L63: the filters, and the tab's "n of m". Queue round 1 (F1-F6): the
// rows are Kind, Predictor's priority, Packet creator's effort, Confidence.
{
  const rows = await p.$$eval(".controls .clabel", (es) => es.map((e) => e.textContent));
  check("L58 filter rows: Kind, Predictor's priority, Packet creator's effort, Confidence, Sort", rows.join(",") === "Kind,Predictor's priority,Packet creator's effort,Confidence,Sort", rows.join(","));
  const shown = () => p.evaluate(() => (window as any).eval("queueLists()").list);
  const totalNow = () => p.evaluate(() => (window as any).eval("queueLists()").total);
  const tryRow = async (key: string, v: string, ok: (c: any) => boolean, name: string) => {
    await p.click(`[data-multi=${key}][data-v="${v}"]`);
    await p.waitForTimeout(250);
    const l = await shown();
    const total = await totalNow();
    const tab = await p.$eval("[data-tab=queue]", (e) => e.textContent);
    const good = l.length > 0 && l.length < total && l.filter((c: any) => c.kind !== "action").every(ok);
    check("L58 " + name + ": only matching cards; L63 the tab reads Queue (n of m)", good && tab === "Queue (" + l.length + " of " + total + ")", l.length + " of " + total + ", tab " + tab);
    await p.click(`[data-multi=${key}][data-v=""]`);
    await p.waitForTimeout(200);
  };
  await tryRow("efforts", "S", (c) => c.meta.effort === "S", "Effort S");
  await tryRow("conf", "low", (c) => c.prediction && Math.round(c.prediction.confidence * 100) < 70, "Confidence Under 70%");
  const tab0 = await p.$eval("[data-tab=queue]", (e) => e.textContent);
  check("L63 with no filter, the tab reads Queue (m)", tab0 === "Queue (" + (await totalNow()) + ")", tab0!);
}
// L65: a kind names its project only when two loaded projects have a kind of
// that name (slice 7 walk, round 2: "Triage (Isomux)", not "isomux: Triage").
{
  const name = await p.evaluate(() => (window as any).eval('const s = V.policies; V.policies = [...s, { id: "t2", project: "other", name: "Triage" }]; const n = kindName({ id: "t1", project: "isomux", name: "Triage" }); V.policies = s; n'));
  const one = await p.evaluate(() => (window as any).eval('const s1 = V.policies; V.policies = s1.filter((x) => x.name !== "Triage"); const n1 = kindName({ id: "t1", project: "isomux", name: "Triage" }); V.policies = s1; n1'));
  check("L65 the kind chip reads Triage (Isomux) when two projects have a Triage, Triage when one has", name === "Triage (Isomux)" && one === "Triage", name + " / " + one);
}
// L167: a withdrawn card says why (the view's withdrawn, from the event that withdrew it; the unit test covers the view).
{
  const t = await p.evaluate(() => [
    (window as any).eval("withdrawnText")({ withdrawn: { cause: "board.task.changed", task: { title: "[hold | nil] Old idea", priority: "P3", status: "open" } } }),
    (window as any).eval("withdrawnText")({ withdrawn: { cause: "board.task.closed", task: { status: "obsolete" } } }),
    (window as any).eval("withdrawnText")({ withdrawn: { cause: "board.task.changed", task: { title: "x", priority: "P4", status: "open" } } }),
  ]);
  check("L167 the reason for a tag, a close and a move to P4", /got a tag on the board \(\[hold \| nil\]\)/.test(t[0]) && /closed on the board \(obsolete\)/.test(t[1]) && /moved to P4/.test(t[2]), t.join(" / "));
}
// L81 phone: the pair stacks; L79: a swipe in the viewer goes to the next image.
{
  const c2 = await browser.newContext({ ...devices["Pixel 7"], extraHTTPHeaders: H });
  const q = await c2.newPage();
  await q.goto(base + "/");
  await q.waitForSelector("[data-card]");
  await q.waitForTimeout(1500);
  const id = await open(q, "demo-1", true);
  const ys = await q.$$eval(`[data-card="${id}"] .imgpair .thumb`, (es) => es.map((e) => Math.round(e.getBoundingClientRect().top)));
  check("L81 phone: the pair is stacked", ys.length === 2 && ys[1] > ys[0], JSON.stringify(ys));
  await q.tap(`[data-card="${id}"] .imgpair .thumb`);
  await q.waitForTimeout(300);
  const before = await q.$eval("#lb .lb-bar span", (e) => e.textContent);
  const cdp = await c2.newCDPSession(q);
  const touch = async (type: string, x: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: 400 }] });
  await touch("touchStart", 330);
  for (const x of [280, 220, 160, 100]) await touch("touchMove", x);
  await touch("touchEnd", 100);
  await q.waitForTimeout(300);
  const after = await q.$eval("#lb .lb-bar span", (e) => e.textContent);
  // Round 10: on a phone each half of the pair is its own step (Before, then After).
  check("L79 a swipe left goes to the next image", /before \(1 of \d\)/.test(before!) && /after \(2 of \d\)/.test(after!), before + " -> " + after);
  await c2.close();
}
// L70: the Undo toast lasts 24 s, and the engine holds an action's Done for 24 s.
{
  const k = (await view()).cards.find((x: any) => x.kind === "decision" && x.state === "open" && x.prediction && !(x.prediction.standin && x.prediction.standin.basis === "none"));
  await open(p, k.subject);
  await p.$eval(`[data-card="${k.id}"] .premove`, (e) => e.scrollIntoView({ block: "center" }));
  await p.waitForTimeout(900);
  await p.click(`[data-card="${k.id}"] .premove details > summary`);
  await p.waitForTimeout(200);
  await p.click(`[data-card="${k.id}"] .yourcall [data-confirm]`);
  await p.waitForTimeout(400);
  const toast = await p.$eval("[data-toast-undo]", (e) => e.textContent).catch(() => "");
  check("L70 the Undo toast counts down from 24 s", /Undo \(2[34] s\)/.test(toast!), toast!);
  await p.waitForTimeout(12_000);
  const later = await p.$eval("[data-toast-undo]", (e) => e.textContent).catch(() => "");
  check("L70 the toast is still there 12 s after the call", /Undo \(1[12] s\)/.test(later!), later!);
  const a = (await view()).cards.find((x: any) => x.kind === "action" && x.state === "open" && !x.held);
  const t0 = Date.now();
  await fetch(base + "/api/cards/" + a.id + "/action", { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) });
  const held = (await view()).cards.find((x: any) => x.id === a.id).action;
  const ms = Date.parse(held.until) - t0;
  check("L70 the engine holds Done for 24 s", held.state === "held" && ms > 23_000 && ms <= 24_500, ms + " ms");
  await fetch(base + "/api/cards/" + a.id + "/undo", { method: "POST", headers: H });
  // L130 again: a call of hold goes to the log as hold, and the page says on hold.
  const r = (await view()).cards.find((x: any) => x.policy === "demo-reply" && x.state === "open");
  await fetch(base + "/api/cards/" + r.id + "/decide", { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ version: r.version, call: { choice: "hold", note: "" } }) });
  await p.click("[data-tab=decided]");
  await p.waitForTimeout(3500);
  const line = await p.$$eval(".dline .dcall", (es) => es.map((e) => e.textContent));
  const raw = (await view()).cards.find((x: any) => x.id === r.id).decision.call.choice;
  check("L130 Decided says on hold; the log keeps hold", line.includes("on hold") && raw === "hold", line.join(",") + " / " + raw);
}
await c.close();
// L136, L156: the curator's packet rules.
{
  const d = readFileSync(new URL("../projects/isomux/curator-skill-draft.md", import.meta.url), "utf8");
  check("L156 the curator draft: lead with the answer, in as few words as it needs", /Lead with the answer, in as few words as it needs/.test(d));
  check("L136 the curator draft: a merge or obsolete option says what the click does", /A merge or obsolete option says what the click does/.test(d));
}
await browser.close();
console.log(fails ? fails + " FAILED" : "ALL PASS");
