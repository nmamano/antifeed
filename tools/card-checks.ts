// Round Q1, package C (the card and the call; /tmp/af-queue-r1/SPEC.md, Nil's
// feedback of 2026-10-28), on a fresh walkthrough copy:
//   PORT=21199 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/card-checks.ts http://localhost:21199
// It only looks and picks; it sends no call.
import { chromium, devices } from "playwright-core";

const base = process.argv[2];
const H = { "X-Isomux-Member-Id": "m0000000" };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const view = async () => (await (await fetch(base + "/api/view", { headers: H })).json()) as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
};
// Every seeded card is open and predicted (the walkthrough's waits: 5 s and 15 s).
for (let i = 0; i < 90 && (await view()).cards.some((k: any) => k.state === "predicting" || k.state === "preparing"); i++) await sleep(500);
// The Wall Game board's long task (projects/wallgame/walkthrough.ts) comes at a board read.
for (let i = 0; i < 90 && !(await view()).cards.some((k: any) => k.state === "open" && k.packet?.question.startsWith("The engine moves")); i++) await sleep(500);
const openCards = async () => (await view()).cards.filter((c: any) => c.state === "open");
const byQ = async (start: string) => (await openCards()).find((c: any) => c.packet?.question.startsWith(start));

async function page(kind: "desk" | "phone") {
  const o = kind === "phone" ? { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } : { viewport: { width: 1400, height: 1000 } };
  const c = await browser.newContext({ ...o, extraHTTPHeaders: H });
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await p.goto(base + "/");
  await p.waitForSelector("[data-card]");
  await p.waitForTimeout(1000);
  return p;
}
async function open(p: any, id: string) {
  if (!(await p.$(`[data-card="${id}"]`))) {
    await p.click(`.row[data-cur="${id}"]`);
    await p.waitForTimeout(700);
  }
  return `[data-card="${id}"]`;
}

const desk = await page("desk");

// C8: every packet fits one desktop screen (1400 x 1000), with its folds closed.
{
  const tall: string[] = [];
  for (const c of await openCards()) {
    if (c.kind !== "decision") continue;
    const sel = await open(desk, c.id);
    const h = await desk.$eval(sel + " .packet", (e: Element) => e.getBoundingClientRect().height).catch(() => 0);
    if (h > 900) tall.push(`${c.packet.question.slice(0, 40)}: ${Math.round(h)} px`);
  }
  check("C8. every packet body is 900 px or less on a 1400 x 1000 screen", !tall.length, tall.join("; "));
}
// C8: the long task is behind one closed "Full packet".
{
  const c = await byQ("The engine moves to the server");
  const sel = await open(desk, c.id);
  const r = await desk.$eval(sel + " .packet", (e: Element) => {
    const full = [...e.querySelectorAll("details")].filter((d) => d.querySelector(":scope > summary")?.textContent === "Full packet");
    const shown = [...e.children].filter((x) => !x.matches("details")).map((x) => x.textContent).join(" ");
    return { n: full.length, open: full[0]?.hasAttribute("open"), shown, inFull: full[0]?.textContent ?? "" };
  });
  check("C8. a long packet has one Full packet toggle, closed", r.n === 1 && r.open === false, JSON.stringify({ n: r.n, open: r.open }));
  // Nil, 2026-10-29 ("the task is described AGAIN"): the long text shows only inside Full packet.
  check("C8. the long text is only in Full packet", !/step 14 of the move/.test(r.shown) && /step 14 of the move/.test(r.inFull), r.shown.slice(0, 200));
  await desk.click(sel + ' .packet summary:text-is("Full packet")');
  await desk.waitForTimeout(300);
  const seen = await desk.$eval(sel + " .packet details.full", (d: Element) => d.hasAttribute("open") && (d as HTMLElement).innerText.includes("step 14 of the move"));
  check("C8. a click on Full packet shows the whole text", seen);
}

// C6: one confidence format, no bar, on the card and the rows; G1: the parts that change have the tint (.dv).
{
  const c = await byQ("The Log in button covers");
  const sel = await open(desk, c.id);
  const r = await desk.evaluate((sel: string) => ({
    meter: document.querySelectorAll(".meter").length,
    conf: document.querySelector(sel + " .zone.premove .conf")?.innerHTML ?? "",
    rows: [...document.querySelectorAll(".row .rp")].map((e) => e.innerHTML).filter((h) => /Premove:/.test(h)),
  }), sel);
  check("C6. no confidence bar on the page", r.meter === 0);
  // N3 (P9 on the card): "sure" is the dotted term for confidence.
  check('C6. the card says "<b>82%</b> sure", with "sure" the confidence term', /^<span class="dv">82%<\/span> <a class="term" [^>]*data-term="confidence"[^>]*>sure<\/a>$/.test(r.conf), r.conf);
  check("C6. each row says the call and the confidence in the tint, the words in plain text", r.rows.length > 0 && r.rows.every((h) => /^Premove: <span class="dv">[^<]+<\/span>, <span class="dv">\d+%<\/span> sure/.test(h)), r.rows[0]);
}

// C7: the Against names who wrote it, as the Premove does.
{
  const c = await byQ("The Log in button covers");
  const sel = await open(desk, c.id);
  const who = await desk.$eval(sel + " .zone.against .zlabel .who", (e: Element) => e.textContent).catch(() => "");
  check("C7. the Against says by whom", who === "by the Predictor", String(who));
}

// G0: the code stand-in's logged words ("no prediction came from the consult agent") say "the Predictor" on the card.
{
  const c = await byQ("The engine moves to the server");
  const sel = await open(desk, c.id);
  const t = await desk.$eval(sel + " .zone.premove", (e: Element) => (e as HTMLElement).innerText);
  check('G0. a no-basis Premove says "the Predictor", not "consult" or "author"', /the Predictor/.test(t) && !/consult|author/i.test(t), t.slice(0, 200));
}

// C3: the author's pick names the author.
{
  const c = await byQ("What does the queue do with a card whose task closed");
  const sel = await open(desk, c.id);
  // Nil, 2026-10-29: an option carries one mark only, the Premove's; no pick tag.
  check("C3. no option has a pick tag", !(await desk.$(sel + " .option .rec")));
}

// C5: "Later (l)", the tooltip says the rest.
{
  const r = await desk.$$eval("[data-later]", (bs: Element[]) => bs.map((b) => [b.textContent, b.getAttribute("title")]));
  check('C5. every Later button reads "Later (l)", with "on this device" in its tooltip', r.length > 0 && r.every(([t, tip]) => t === "Later (l)" && /on this device/.test(tip ?? "")), JSON.stringify(r[0]));
}

// C1: on a desktop the call bar is never in the header, and nothing floats
// over Your call while any of it is on the screen (Antifeed Walker: a sticky
// Confirm row covered the Priority chips, and a press on P1 hit Confirm). The
// bar shows only once the whole call zone is scrolled away.
{
  const c = await byQ("What does the queue do with a card whose task closed");
  const sel = await open(desk, c.id);
  check("C1. the header holds no call bar", !(await desk.$("header [data-sticky]")));
  const at = async (y: number) => {
    await desk.evaluate((y: number) => window.scrollTo(0, y), y);
    await desk.mouse.wheel(0, 1);
    await desk.waitForTimeout(450);
    return desk.evaluate((sel: string) => {
      const b = document.querySelector("[data-sticky]") as HTMLElement | null;
      const z = document.querySelector(sel + " .yourcall")!.getBoundingClientRect();
      const head = document.querySelector("header")!.getBoundingClientRect().bottom;
      // Each chip, option and the note that is on the screen takes a press at its center.
      const covered = [...document.querySelectorAll(sel + " .yourcall [data-field], " + sel + " .yourcall [data-opt], " + sel + " .yourcall [data-note]")]
        .filter((e) => { const r = e.getBoundingClientRect(); const y = r.top + r.height / 2; return y > head && y < innerHeight; })
        .filter((e) => { const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !hit || !(e === hit || e.contains(hit)); })
        .map((e) => e.textContent || (e as HTMLElement).dataset.note || "note");
      return { bar: !!b && !b.hidden, zoneShows: z.bottom > head && z.top < innerHeight, covered, barBottom: b ? Math.round(innerHeight - b.getBoundingClientRect().bottom) : -1 };
    }, sel);
  };
  const runs: any[] = [];
  for (const y of [0, 100, 200, 300, 400, 500, 600, 800]) runs.push([y, await at(y)]);
  check("C1. desktop: while Your call is on the screen, no bar, and every chip, option and the note on the screen takes its own press", runs.every(([, r]) => !r.zoneShows || (!r.bar && !r.covered.length)), JSON.stringify(runs.filter(([, r]) => r.zoneShows && (r.bar || r.covered.length))));
  const zoneBottom = await desk.$eval(sel + " .yourcall", (e: Element) => e.getBoundingClientRect().bottom + window.scrollY);
  const past = await at(Math.round(zoneBottom - 60));
  check("C1. desktop, the whole call zone scrolled away: the bar shows at the bottom edge", !past.zoneShows && past.bar && past.barBottom >= 0 && past.barBottom < 40, JSON.stringify(past));
}

// C4: a New packet request needs Nil's own words; the option's text that the
// Premove put in the note box is no request (Antifeed Walker).
{
  const fresh = await page("desk");
  const c = await byQ("What does the queue do with a card whose task closed");
  const sel = await open(fresh, c.id);
  const v0 = c.version;
  await fresh.mouse.move(300, 300);
  await fresh.mouse.move(700, 600, { steps: 8 });
  await fresh.waitForTimeout(1600);
  const note = await fresh.$eval(sel + " [data-note]", (e: Element) => (e as HTMLTextAreaElement).value);
  await fresh.click(sel + " [data-rewrite]");
  await fresh.waitForTimeout(500);
  const zoneErr = () => fresh.$eval(sel + " .yourcall", (e: Element) => e.querySelector(":scope > .err")?.textContent ?? "").catch(() => "(card gone)");
  const err = await zoneErr();
  const after = (await openCards()).find((x: any) => x.id === c.id);
  check("C4. New packet with only the Premove option's text in the note: refused, with why, and nothing goes out", !!note && /^A new packet needs a note/.test(err) && !!after && after.version === v0 && after.state === "open", JSON.stringify({ note, err, state: after?.state }));
  // A note left by an option Nil dropped with a field edit is no request either (Antifeed Reviewer 2).
  await fresh.click(sel + ' [data-opt="a"]');
  await fresh.click(sel + " [data-field=priority][data-v='\"P3\"']");
  await fresh.waitForTimeout(800);
  const left = await fresh.$eval(sel + " [data-note]", (e: Element) => (e as HTMLTextAreaElement).value);
  const optOn = await fresh.$$eval(sel + " [data-opt].on", (es: Element[]) => es.length);
  await fresh.click(sel + " [data-rewrite]");
  await fresh.waitForTimeout(500);
  const err2 = await zoneErr();
  const after2 = (await openCards()).find((x: any) => x.id === c.id);
  check("C4. New packet with the note a dropped option left: refused, and nothing goes out", /^A: /.test(left) && optOn === 0 && /^A new packet needs a note/.test(err2) && !!after2 && after2.version === v0 && after2.state === "open", JSON.stringify({ left, optOn, err2, state: after2?.state, version: after2?.version, v0, why: await fresh.evaluate("readyFor(cardById(cur))") }));
  await fresh.context().close();
}

// C2: the fields are the call. The Premove's value has one mark (.pm, a ring
// and a dot); Nil's pick is the filled chip; an option is a shortcut.
{
  const c = await byQ("What does the queue do with a card whose task closed");
  const sel = await open(desk, c.id);
  const z = sel + " .yourcall";
  const state = () => desk.$eval(z, (e: Element) => ({
    text: (e as HTMLElement).innerText,
    on: [...e.querySelectorAll("[data-field].on")].map((b) => (b as HTMLElement).dataset.field + "=" + b.textContent),
    pm: [...e.querySelectorAll("[data-field].pm")].map((b) => (b as HTMLElement).dataset.field + "=" + b.textContent),
    optOn: [...e.querySelectorAll("[data-opt].on")].map((b) => (b as HTMLElement).dataset.opt),
    optPm: [...e.querySelectorAll("[data-opt].pm")].map((b) => (b as HTMLElement).dataset.opt),
    // Nil, 2026-10-29: the button keeps its place, disabled with nothing changed.
    reset: !!e.querySelector("[data-reset]:not([disabled])"),
    resetShown: !!e.querySelector("[data-reset]"),
    optTop: (e.querySelector(".options") as HTMLElement | null)?.offsetTop ?? -1,
    filled: [...e.querySelectorAll("[data-field].filled")].map((b) => b.textContent),
    hint: (() => { const h = e.querySelector("[data-cfhint]") as HTMLElement | null; return h ? getComputedStyle(h).display : "none"; })(),
    actions: [...e.querySelectorAll(".actions button")].map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim()),
    req: (e.querySelector(".reqrow") as HTMLElement | null)?.innerText.replace(/\s+/g, " ").trim() ?? "",
  }));
  let r = await state();
  check("C2. no sub-heading, no fill line, no changes line, no line under Confirm", !/^Options$/m.test(r.text) && !/from option|Filled in from|Changed from the Premove|Read the packet, then confirm/.test(r.text) && r.hint === "none", r.text.slice(0, 160));
  check("C2. the Premove's values carry the mark, and they start as Nil's pick", r.pm.join() === "choice=go,priority=P1" && r.on.join() === "choice=go,priority=P1" && r.optPm.join() === "b" && r.optOn.join() === "b", JSON.stringify(r));
  check("C2. Back to the Premove is there but disabled before a change", !r.reset && r.resetShown);
  const top0 = r.optTop;
  // A press on a locked Confirm (a fresh page: no act on the card yet) shows why, beside it, and only then.
  const fresh = await page("desk");
  await fresh.$eval(`.row[data-cur="${c.id}"]`, (b: Element) => (b as HTMLElement).click());
  await fresh.waitForTimeout(700);
  const locked = await fresh.$eval(z + " .actions [data-confirm]", (b: Element) => b.classList.contains("locked"));
  const before = await fresh.$eval(z + " [data-cfhint]", (h: Element) => getComputedStyle(h).display);
  await fresh.$eval(z + " .actions [data-confirm]", (b: Element) => (b as HTMLElement).click());
  await fresh.waitForTimeout(150);
  const hint = await fresh.$eval(z + " [data-cfhint]", (h: Element) => [getComputedStyle(h).display, h.textContent]);
  await fresh.context().close();
  check("C2. a press on the locked Confirm shows the reason beside it, hidden before", locked && before === "none" && hint[0] !== "none" && !!hint[1], JSON.stringify([locked, before, hint]));
  await desk.click(z + ' [data-opt="a"]');
  await desk.waitForTimeout(150);
  r = await state();
  check("C2. option A fills the fields: P2 is the pick, P1 keeps the mark, P2 flashes", r.on.join() === "choice=go,priority=P2" && r.pm.join() === "choice=go,priority=P1" && r.optOn.join() === "a" && r.filled.join() === "P2", JSON.stringify(r));
  check("C2. Back to the Premove is enabled after the change", r.reset);
  const top1 = r.optTop;
  await desk.click(z + ' [data-opt="b"]');
  await desk.waitForTimeout(150);
  const top2 = (await state()).optTop;
  await desk.click(z + ' [data-opt="a"]');
  await desk.waitForTimeout(150);
  const top3 = (await state()).optTop;
  // Nil, 2026-10-29 ("the rest of ui below it janks up and down"): nothing above the options moves.
  check("C2. the options list keeps its place on option switches", top0 > 0 && [top1, top2, top3].every((t) => t === top0), JSON.stringify([top0, top1, top2, top3]));
  await desk.click(z + " [data-field=priority][data-v='\"P3\"']");
  await desk.waitForTimeout(150);
  r = await state();
  check("C2. a field edit after an option: the option no longer shows as picked", r.on.join() === "choice=go,priority=P3" && r.optOn.length === 0, JSON.stringify(r));
  await desk.click(z + " [data-reset]");
  await desk.waitForTimeout(150);
  r = await state();
  check("C2. Back to the Premove puts back the fields and option B, and disables itself", r.on.join() === "choice=go,priority=P1" && r.optOn.join() === "b" && !r.reset, JSON.stringify(r));
  // C4: Confirm and Later together; the packet requests in their own row, named for who acts.
  check("C4. the call row holds Confirm and Later only", r.actions.join("|") === "ConfirmCtrl+Enter|Later (l)", r.actions.join("|"));
  check('C4. the request row: "Ask Demo Worker 2 for", New packet, Closer to this option', r.req === "Ask Demo Worker 2 for New packet (w) Closer to this option (r)", r.req);
  const tips = await desk.$$eval(z + " .reqrow button", (bs: Element[]) => bs.map((b) => b.getAttribute("title") ?? ""));
  check("C4. their tips say who acts and that it is no call", tips.length === 2 && tips.every((t) => /^Demo Worker 2 /.test(t) && /no call/.test(t)), JSON.stringify(tips));
  // C4 walk: Closer to this option goes to the packet creator, and the card comes back with variants.
  await desk.mouse.move(300, 300);
  await desk.mouse.move(600, 600, { steps: 8 });
  await desk.waitForTimeout(800);
  await desk.click(z + " [data-refine]");
  let v2: any = null;
  for (let i = 0; i < 90 && !(v2 = (await openCards()).find((x: any) => x.id === c.id && x.version === 2)); i++) await sleep(1000);
  check("C4. Closer to option B: the card comes back as version 2 with variants of B", !!v2 && v2.packet.options.map((o: any) => o.id).join() === "b1,b2,b3", JSON.stringify(v2?.packet?.options?.map((o: any) => o.label)));
  // The variants share B's note: with nothing changed, there is nothing to go back to (Antifeed Reviewer 2, 2026-10-29).
  for (let i = 0; i < 30 && !(await openCards()).find((x: any) => x.id === c.id && x.version === 2 && x.prediction); i++) await sleep(1000);
  await open(desk, c.id);
  await desk.waitForTimeout(500);
  r = await state();
  check("C2. version 2, nothing changed: no Back to the Premove", r.optPm.join() === "b2" && r.optOn.join() === "b2" && !r.reset, JSON.stringify(r));
}

// A zone heading and its "by" (or "from", with an agent chip) sit on one baseline,
// on a phone too (Antifeed Walker, live, 390 px: the name sat about 20 px higher).
async function baselines(p: any) {
  return p.evaluate(() => {
    const textBottom = (el: Element) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent!.trim() && !(n.parentElement as HTMLElement).closest(".av") ? 1 : 3) });
      const t = w.nextNode();
      if (!t) return null;
      const r = document.createRange();
      r.selectNodeContents(t);
      const rs = r.getClientRects();
      return rs.length ? rs[0].bottom : null;
    };
    const bad: string[] = [];
    let n = 0;
    for (const z of document.querySelectorAll("[data-card] .zone > .zlabel")) {
      const head = z.children[0];
      const who = z.querySelector(":scope > .who");
      if (!who || !who.textContent!.trim()) continue;
      const hb = textBottom(head), wb = textBottom(who);
      if (hb === null || wb === null) continue;
      // Only when they share a row (a long "by" may wrap under the heading).
      if (who.getBoundingClientRect().top >= head.getBoundingClientRect().bottom - 2) continue;
      n++;
      if (Math.abs(hb - wb) > 3) bad.push(head.textContent + ": " + Math.round(hb) + " vs " + Math.round(wb));
    }
    return { n, bad };
  });
}
for (const kind of ["desk", "phone"] as const) {
  const p = await page(kind);
  const out: string[] = [];
  let n = 0;
  for (const q of ["The Log in button covers", "The campaign level list", "What does the queue do with a card whose task closed"]) {
    const c = await byQ(q);
    if (!c) continue;
    await open(p, c.id);
    const r = await baselines(p);
    n += r.n;
    out.push(...r.bad);
  }
  check(`H2/C. ${kind}: each zone heading and its "by" or "from" share one baseline`, n > 0 && !out.length, `${n} heads; ` + out.join("; "));
  await p.context().close();
}


// The phone: the packet starts after the call, and the long one has its toggle too.
{
  const phone = await page("phone");
  const c = await byQ("The engine moves to the server");
  const sel = await open(phone, c.id);
  const n = await phone.$$eval(sel + " .packet details.full", (d: Element[]) => d.length);
  check("C8. on a phone, the long packet has its Full packet toggle", n === 1);
}

await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
