// Round q1b, package P (Decided, Policies, Help), on a walkthrough copy:
//   PORT=21199 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/pages-checks.ts http://localhost:21199
// It decides 3 demo cards, finishes one action and sends one chat message, so run it on a fresh copy.
import { chromium, devices } from "playwright-core";

const base = process.argv[2];
const H = { "X-Isomux-Member-Id": "m0000000", "Content-Type": "application/json" };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const view = async () => (await (await fetch(base + "/api/view", { headers: H })).json()) as any;
const post = async (path: string, body: unknown) => (await fetch(base + path, { method: "POST", headers: H, body: JSON.stringify(body) })).status;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
};

// Decided needs calls: wait for the Premoves, then decide three, chat on one, finish an action.
for (let i = 0; i < 60 && (await view()).cards.some((k: any) => k.state === "predicting"); i++) await sleep(500);
{
  const open = (await view()).cards.filter((c: any) => c.state === "open");
  const dec = open.filter((c: any) => c.kind === "decision" && c.project === "demo" && c.prediction?.call);
  await post(`/api/cards/${dec[0].id}/chat`, { text: "Why this priority?" });
  await sleep(2500);
  for (const c of dec.slice(0, 3)) await post(`/api/cards/${c.id}/decide`, { version: c.version, call: c.prediction.call });
  const act = open.find((c: any) => c.kind === "action");
  if (act) await post(`/api/cards/${act.id}/action`, { ok: true, note: "Done on my phone." });
  await sleep(1500);
}
const chatted = (await view()).cards.find((c: any) => c.thread?.length && c.decision);

async function page(kind: "desk" | "phone") {
  const o = kind === "phone" ? { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } : { viewport: { width: 1400, height: 1000 } };
  const c = await browser.newContext({ ...o, extraHTTPHeaders: { "X-Isomux-Member-Id": H["X-Isomux-Member-Id"] } });
  const p = await c.newPage();
  p.on("pageerror", (e) => check(kind + ": no page error", false, e.message));
  return p;
}
const press = (p: any, kind: string, sel: string) => (kind === "phone" ? p.tap(sel) : p.click(sel));
const text = (p: any, tab: string) => p.$eval("#tab-" + tab, (e: HTMLElement) => e.innerText);

for (const kind of ["desk", "phone"] as const) {
  const p = await page(kind);
  // 1. The tabs are Policies and Help; an old link opens the new tab.
  await p.goto(base + "/#flow");
  await p.waitForTimeout(1200);
  const tabs = await p.$$eval("#tabs [data-tab]", (es) => es.map((e) => (e as HTMLElement).dataset.tab));
  check(kind + ": 1. the tabs name Policies and Help, not Flow and Terms", tabs.includes("policies") && tabs.includes("help") && !tabs.includes("flow") && !tabs.includes("terms"), tabs.join(","));
  check(kind + ": 1. #flow opens Policies", !(await p.$eval("#tab-policies", (e) => (e as HTMLElement).hidden)) && p.url().endsWith("#policies"), p.url());
  await p.goto(base + "/#terms-premove");
  await p.waitForTimeout(1200);
  check(kind + ": 1. #terms-premove opens Help at Premove", !(await p.$eval("#tab-help", (e) => (e as HTMLElement).hidden)) && p.url().endsWith("#help-premove"), p.url());

  // 2. Decided: the words, and a row opens in place to its details.
  await p.goto(base + "/#decided");
  await p.waitForTimeout(1200);
  const dt = await text(p, "decided");
  check(kind + ": 2. Decided says 'the last 200 are shown here'", dt.includes("the last 200 are shown here") && !dt.includes("are kept here"));
  const sel = `details[data-dkey="dec:${chatted.id}"]`;
  // A closed row is its two lines and the row's padding: the arrow adds no line or padding.
  const extra = await p.$eval(sel, (d) => {
    const row = d.parentElement!;
    const s = d.querySelector("summary")!;
    return Math.round(row.getBoundingClientRect().height - [...s.children].reduce((a, x) => a + x.getBoundingClientRect().height, 0));
  });
  check(kind + ": 2. a closed row is no taller than its lines and the row's padding", extra <= 26, extra + " px more");
  check(kind + ": 2. a closed row shows no details", !(await p.$eval(sel, (e) => (e as HTMLDetailsElement).open)));
  await press(p, kind, sel + " > summary");
  await p.waitForTimeout(1000);
  const det = await p.$eval(sel, (e) => (e as HTMLElement).innerText);
  check(kind + ": 2. one " + (kind === "phone" ? "tap" : "click") + " opens the row in place, with Premove, confidence, Against, what ran and the chat", /Premove by/.test(det) && /\d+% sure/.test(det) && /Against by/.test(det) && /What ran/.test(det) && /Chat with the Predictor/.test(det) && det.includes("Why this priority?"), det.slice(0, 300));
  check(kind + ": 2. with Undo on the row, What ran does not say it cannot be taken back", !/cannot be taken back/.test(det), det.match(/What ran\n.*/)?.[0] ?? "");
  check(kind + ": 2. the URL stays on Decided", p.url().endsWith("#decided"), p.url());
  await press(p, kind, sel + " details.dpacket > summary");
  await p.waitForTimeout(1000);
  const pk = await p.$eval(sel + " details.dpacket", (e) => ({ open: (e as HTMLDetailsElement).open, text: (e as HTMLElement).innerText, imgs: e.querySelectorAll("[data-lb]").length }));
  check(kind + ": 2. Full packet shows the packet as it was (its blocks loaded)", pk.open && !pk.text.includes("Loading") && pk.text.length > 80, pk.text.slice(0, 120));
  if (pk.imgs) {
    await press(p, kind, sel + " details.dpacket [data-lb]");
    await p.waitForTimeout(600);
    check(kind + ": 2. an image of a decided packet opens in the viewer", !(await p.$eval("#lb", (e) => (e as HTMLElement).hidden)));
    await p.keyboard.press("Escape");
    await p.waitForTimeout(400);
  }
  const undoBox = await p.$eval(sel, (d) => {
    const u = d.parentElement!.querySelector("[data-undo]");
    const s = d.querySelector("summary")!.getBoundingClientRect();
    return u ? { top: u.getBoundingClientRect().top - s.top } : null;
  });
  check(kind + ": 2. Undo stays at the top of an open row", !undoBox || undoBox.top < 40, JSON.stringify(undoBox));

  // 2. A failed load shows its error and Try again, and asks no more by itself (a restart gives 502s).
  if (kind === "desk") {
    const other = (await view()).cards.find((c: any) => c.decision && c.id !== chatted.id);
    let asks = 0;
    await p.route("**/api/cards/" + other.id, (r: any) => (asks++, r.fulfill({ status: 502, body: "down" })));
    await p.click(`details[data-dkey="dec:${other.id}"] > summary`);
    await p.waitForTimeout(3500);
    const err = await p.$eval(`details[data-dkey="dec:${other.id}"]`, (e) => (e as HTMLElement).innerText);
    check("desk: 2. a failed packet load asks once, and shows its error with Try again", asks === 1 && /did not load/.test(err) && !!(await p.$(`[data-cardagain="${other.id}"]`)), "requests: " + asks);
    await p.unroute("**/api/cards/" + other.id);
    await p.click(`[data-cardagain="${other.id}"]`);
    await p.waitForTimeout(1200);
    check("desk: 2. Try again loads it", !/did not load/.test(await p.$eval(`details[data-dkey="dec:${other.id}"]`, (e) => (e as HTMLElement).innerText)));
  }

  // 3. Policies: projects, one command or several, and when.
  await p.goto(base + "/#policies");
  await p.waitForTimeout(1200);
  const pt = await text(p, "policies");
  check(kind + ": 3. each group heading says 'Project: <name>'", (await p.$$eval("#tab-policies h2:not(.tabname)", (es) => es.map((e) => (e as HTMLElement).innerText))).every((h) => /^Project: /.test(h) || h === "Built into Antifeed"));
  check(kind + ": 3. the ask's three commands are one of these, as your call says", /After your call, it sends one of these, as your call says:/.test(pt) && /If you reply, to a small program inside Antifeed: send your reply/.test(pt) && /If you dismiss it, to a small program inside Antifeed/.test(pt));
  check(kind + ": 3. a policy with one command after the call says 'one command'", /After your call, it sends one command to /.test(pt) && /After your Done, it sends one command to /.test(pt) && /it gives you one action: /.test(pt));
  check(kind + ": 3. it says when the Premove is asked for", /For each packet, it asks the Predictor for one Premove/.test(pt));
  check(kind + ": 3. one command reads 'it sends one command to <actor>: <what>', with no link on the actor", /After your call, it sends one command to a small program inside Antifeed: carry out your call/.test(pt) && !/Command to/.test(pt) && !(await p.$("#tab-policies a[href^='#setup-actor']")));
  check(kind + ": 3. no 'flow' in the words", !/the end of the flow/.test(pt) && /\(the last step\)/.test(pt));
  check(kind + ": 3. 'packet' is not dotted; 'Who decides' is, and its tip names Decider", !(await p.$$eval("#tab-policies a.term", (es) => es.some((e) => /packet/.test(e.textContent!)))) && (await p.$$eval("#tab-policies a.term[data-term=decider]", (es) => es.length > 0 && es.every((e) => /^Who decides$/.test(e.textContent!) && /^Decider: /.test(e.getAttribute("title") || (e as any)._tip || "")))));
  check(kind + ": 3. the counts have the tint (G1)", (await p.$$eval("#tab-policies .n .dv, #tab-policies td .dv", (es) => es.length)) > 10);
  check(kind + ": 3. 'Who decides' values start with a capital, with no second colon", (await p.$$eval("#tab-policies .pol > div", (es) => es.map((e) => (e as HTMLElement).innerText))).every((t) => /^Who decides: [A-Z][^:]*$/.test(t)));

  // 4. Read-only words are the same on every read-only page, and the file is named.
  const ro: string[] = [];
  for (const t of ["accuracy", "policies", "setup", "status"]) {
    await p.goto(base + "/#" + t);
    await p.waitForTimeout(t === "status" ? 2000 : 900);
    ro.push(await p.$eval("#tab-" + t + " .note", (e) => (e as HTMLElement).innerText.split(".")[0]));
  }
  check(kind + ": 4. Accuracy, Policies, Setup and Status open with 'Read only.'", ro.every((x) => x === "Read only"), ro.join(" | "));
  check(kind + ": 4. Policies and Setup name the policies file", pt.includes("projects/demo/policies.ts") && (await text(p, "setup")).includes("projects/demo/policies.ts"));

  // 5. Status: the quick model runs in plain words.
  const st = await text(p, "status");
  check(kind + ": 5. Status says what the quick model runs are", /Quick model runs\nToday: \d+ runs?, cost \$\d/.test(st) && /when the Predictor is not available/.test(st) && /midnight Pacific time/.test(st) && !/Stand-in model runs/.test(st));

  // 6-8. Help: what Antifeed is, the path as a numbered list, mixed examples.
  await p.goto(base + "/#help");
  await p.waitForTimeout(1000);
  const ht = await text(p, "help");
  // 6a50d54: on a phone a tab behind More opens with its own name; a desktop hides that heading.
  check(kind + ": 6. Help opens with what Antifeed is" + (kind === "phone" ? ", after its name" : ""), ht.trimStart().replace(kind === "phone" ? /^Help\s*\n/ : /^$/, "").trimStart().startsWith("What Antifeed is"), ht.trimStart().slice(0, 40));
  const steps = await p.$$eval("#tab-help ol.steps > li", (es) => es.map((e) => (e as HTMLElement).getBoundingClientRect()));
  const helpBox = await p.$eval("#tab-help", (e) => e.getBoundingClientRect());
  check(kind + ": 7. the path is a numbered list of 6 steps, one under the other, inside the page", steps.length === 6 && steps.every((r, i) => i === 0 || r.top >= steps[i - 1].bottom) && steps.every((r) => r.right <= helpBox.right + 1), String(steps.length));
  check(kind + ": 7. no old row of boxes and arrows", !(await p.$(".cycle, .darrow")));
  check(kind + ": 7. each step name ends with a colon, and no step body has a dotted word", (await p.$$eval("#tab-help ol.steps > li b", (es) => es.every((e) => (e as HTMLElement).innerText.endsWith(":")))) && (await p.$$eval("#tab-help ol.steps > li a.term", (es) => es.every((a) => !!a.closest("b")))));
  check(kind + ": 6. the terms list is as wide as the top part, and has no Decision card or Action card", (await p.$eval("#tab-help dl.terms", (e) => e.getBoundingClientRect().width)) <= 821 && !/Decision card|Action card/.test(ht) && /sends a command to an actor \(an agent, a small program inside Antifeed, or you\) to carry out your call/.test(ht));
  check(kind + ": 8. the examples come from more than one source", /asks you a question/.test(ht) && /merge finishes/.test(ht) && /task is filed/.test(ht));

  // 9. Terms: a dotted word in headings and labels, once per region, with its line as the tip.
  const dup = await p.evaluate(() => {
    const out: string[] = [];
    for (const tab of document.querySelectorAll(".tab")) {
      const seen = new Map<Element, Set<string>>();
      for (const a of tab.querySelectorAll("a.term")) {
        const r = a.closest(".tregion, [data-part]")!;
        const s = seen.get(r) ?? new Set();
        if (s.has((a as HTMLElement).dataset.term!)) out.push(tab.id + ":" + (a as HTMLElement).dataset.term);
        s.add((a as HTMLElement).dataset.term!);
        seen.set(r, s);
      }
    }
    return out;
  });
  check(kind + ": 9. a word is dotted once per region", !dup.length, dup.join(","));
  await p.goto(base + "/#policies");
  await p.waitForTimeout(1000);
  const term = "#tab-policies a.term[data-term=event]";
  if (kind === "phone") {
    await p.tap(term);
    await p.waitForTimeout(400);
    const pop = await p.$eval(".termpop", (e) => ({ hidden: (e as HTMLElement).hidden, text: (e as HTMLElement).innerText }));
    check("phone: 9. More in Help is at least 44 px high", (await p.$eval(".termpop [data-goto]", (e) => e.getBoundingClientRect().height)) >= 44);
    check("phone: 9. a tap on a dotted word shows its line, and the page stays", !pop.hidden && /^Event: A fact that happened/.test(pop.text) && p.url().endsWith("#policies"), pop.text);
    await p.tap(".termpop [data-goto]");
    await p.waitForTimeout(800);
    check("phone: 9. More in Help opens its entry", p.url().endsWith("#help-event") && (await p.$eval(".termpop", (e) => (e as HTMLElement).hidden)), p.url());
  } else {
    await p.hover(term);
    await p.waitForTimeout(700);
    const tip = await p.$eval(".tip", (e) => ({ hidden: (e as HTMLElement).hidden, text: e.textContent }));
    check("desk: 9. a dotted word shows its line as a tooltip", !tip.hidden && /^Event: A fact that happened/.test(tip.text ?? ""), tip.text ?? "");
  }

  // 10. G0 on these pages; 11. nothing wider than a phone.
  const bad: string[] = [];
  const wide: string[] = [];
  for (const t of ["decided", "accuracy", "policies", "setup", "status", "help"]) {
    await p.goto(base + "/#" + t);
    await p.waitForTimeout(900);
    const x = await text(p, t);
    for (const w of [/consult agent/i, /\bauthor\b/i, /Premover/, /\bFlow\b/, /\bTerms tab\b/]) if (w.test(x)) bad.push(t + ":" + w.source);
    if (kind === "phone" && (await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1))) wide.push(t);
  }
  check(kind + ": 10. no 'consult agent', 'author', 'Premover' or 'Flow' on these pages", !bad.length, bad.join(", "));
  if (kind === "phone") check("phone: 11. no page is wider than the phone", !wide.length, wide.join(","));
  await p.context().close();
}
await browser.close();
console.log(fails ? fails + " FAILED" : "ALL PASS");
process.exit(fails ? 1 : 0);
