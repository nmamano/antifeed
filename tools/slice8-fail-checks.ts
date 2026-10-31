// Slice 8 walk: a Wall Game send that fails, on a walkthrough copy. The fake
// office fails only POST /api/app/message, in one mode: 403, 404, 502 or
// hang (no answer; the copy gives up after 5 s). Mode 502 also sends the
// calls again and checks that the page and Status follow the retry. It waits
// out a 3-minute burst (502: two), so run the four modes on four copies at once:
//   PORT=21199 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/slice8-fail-checks.ts http://localhost:21199 502
import { chromium, devices } from "playwright-core";

const base = process.argv[2];
const mode = process.argv[3] === "hang" ? "hang" : Number(process.argv[3]);
if (![403, 404, 502, "hang"].includes(mode)) throw new Error("mode: 403, 404, 502 or hang");
const H = { "X-Isomux-Member-Id": "m0000000", "Content-Type": "application/json" };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const view = async () => (await (await fetch(base + "/api/view", { headers: H })).json()) as any;
const status = async () => (await (await fetch(base + "/api/status", { headers: H })).json()) as any;
const office = async (path: string, body?: unknown) => (await (await fetch(base + "/fake-office/control/" + path, body === undefined ? {} : { method: "POST", headers: H, body: JSON.stringify(body) })).json()) as any;
const decide = (c: any, call: unknown) => fetch(base + "/api/cards/" + c.id + "/decide", { method: "POST", headers: H, body: JSON.stringify({ version: c.version, call }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + `[${mode}] ` + name + (detail ? " | " + detail : ""));
};
const wg = async () => (await view()).cards.filter((c: any) => c.project === "wallgame");
const byTitle = async (start: string) => (await wg()).filter((c: any) => c.packet?.question.startsWith(start)).at(-1);
const failCard = async () => (await view()).cards.filter((c: any) => c.policy === "command-failed").at(-1);
async function page(kind: "desk" | "phone") {
  const o = kind === "phone" ? { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } : { viewport: { width: 1400, height: 1000 } };
  const c = await browser.newContext({ ...o, extraHTTPHeaders: { "X-Isomux-Member-Id": H["X-Isomux-Member-Id"] } });
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await p.goto(base + "/");
  await p.waitForSelector("[data-card]");
  await p.waitForTimeout(1200);
  return p;
}
async function open(p: any, id: string) {
  if (!(await p.$(`[data-card="${id}"]`))) {
    await p.click(`.row[data-cur="${id}"]`);
    await p.waitForSelector(`[data-card="${id}"]`);
    await p.waitForTimeout(1500);
  }
  return `[data-card="${id}"]`;
}
const tab = async (p: any, name: string) => {
  await p.reload();
  await p.waitForTimeout(1500);
  await p.click(`[data-tab=${name}]`);
  await p.waitForTimeout(800);
  return p.evaluate(() => document.body.innerText) as Promise<string>;
};

for (let i = 0; i < 60 && (await wg()).filter((c: any) => c.state === "open").length < 4; i++) await sleep(1000);
await office("sendfail", { mode });

// Two calls in one burst; the send fails in the mode.
const camp = await byTitle("The campaign level list");
const mv = await byTitle("Move the old Wallwars site");
const r1 = await decide(camp, { choice: "go", priority: "P2", note: "" });
const r2 = await decide(mv, { choice: "obsolete", priority: null, note: "" });
check("the two calls are taken", r1.ok && r2.ok);
let f: any;
for (let i = 0; i < 300 && !(f = await failCard()); i++) await sleep(1000);
for (let i = 0; i < 30 && f && !f.prediction; i++) (await sleep(1000), (f = await failCard()));

const maybe = mode === 502 || mode === "hang";
const why = mode === 403 ? "The Antifeed app has no live owner agent in the office (set one on the Apps page), so the office refused it." : mode === 404 ? "The office found no Wall Game PM to send to, so nothing was sent." : "The office gave no clear answer; check with Wall Game PM before you send them again.";
const title = `Your 2 calls to Wall Game PM ${maybe ? "may not have gone out" : "did not go out"}. ${why}`;
check("one failure card for the burst, in Nil's words", f?.packet?.question === title, f?.packet?.question);
check("its Premove is drop", f?.prediction?.call?.choice === "drop", JSON.stringify(f?.prediction?.call));
check("no message reached the office", (await office("state")).messages.length === 0);

// The card on a desk: the rule that applied, buttons named as the note says, no reassign, no ids in view.
const desk = await page("desk");
{
  const sel = await open(desk, f.id);
  const r = await desk.$eval(sel, (e: Element) => ({
    text: (e as HTMLElement).innerText,
    // The option's own words, without its marks (the Premove) and its fill line.
    opts: [...e.querySelectorAll("[data-opt]")].map((x) => [...x.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("")),
    chips: [...e.querySelectorAll("[data-field]")].map((x) => x.textContent),
    actor: !!e.querySelector('[data-text="actor"]'),
    q: e.querySelector(".question")?.textContent ?? "",
  }));
  const rule = mode === 403 || mode === 404 ? "a retry rule: no retry while the cause holds" : "a retry rule: no retry when it may have gone out";
  check("the Premove names the rule that applied", r.text.includes(rule), r.text.match(/a rule:[^\n]*/)?.[0] ?? "");
  check("the options are Send them again and Drop them, and the note uses those names", JSON.stringify(r.opts) === '["Send them again","Drop them"]' && /pick Send them again/.test(r.text), JSON.stringify(r.opts));
  check("no reassign and no New actor", !r.chips.includes("reassign") && !r.actor && !/New actor/.test(r.text), JSON.stringify(r.chips));
  check("the title holds no ids or raw errors", !/wgpm|wallgame\)|k_0|answered|operation timed out/i.test(r.q), r.q);
  check("each call's row names its task", /Task\s*The campaign level list/.test(r.text) && /Task\s*Move the old Wallwars site/.test(r.text), r.text.match(/Task[^\n]*\n?[^\n]*/)?.[0] ?? "");
}
{
  const d = await tab(desk, "decided");
  const want = (maybe ? "May have gone: " : "Not sent: ") + why.charAt(0).toLowerCase() + why.slice(1, -1) + ". A card for it is in the queue.";
  check("Decided: the call's line says what happened, in words", d.includes(want), d.match(/(Not sent|May have gone):[^\n]*/)?.[0] ?? "");
}
{
  const ph = await page("phone");
  await open(ph, f.id);
  const wide = await ph.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  check("phone: no sideways scroll on the failure card", !wide);
  await ph.context().close();
}

// 502: send them again. One message with both; the page and Status follow the retry; no Undo after it went.
if (mode === 502) {
  await office("sendfail", { mode: null });
  const rr = await decide(f, { choice: "retry" });
  check("the retry is taken", rr.ok);
  for (let i = 0; i < 300 && !(await office("state")).messages.length; i++) await sleep(1000);
  await sleep(2000);
  const m = (await office("state")).messages;
  check("one message with both calls", m.length === 1 && /sends you 2 triage calls/.test(m[0].text), String(m.length));
  const d = await tab(desk, "decided");
  check("Decided: both calls read as sent, none as failed", (d.match(/Sent to Wall Game PM/g) ?? []).length >= 2 && !/May have gone/.test(d), d.match(/.{0,40}(Sent to Wall Game PM|May have gone).{0,60}/g)?.join(" | ") ?? "");
  const st = await status();
  check("Status: no failed command left", st.failed.length === 0, JSON.stringify(st.failed.map((k: any) => k.id)));
  const s = await tab(desk, "status");
  check("Status page: Failed commands (0) and Calls sent (2)", /Failed commands \(0\)/.test(s) && /Calls sent \(2\)/.test(s), s.match(/Failed commands[^\n]*|Calls sent[^\n]*/g)?.join(" | ") ?? "");
  const undo = await fetch(base + "/api/cards/" + f.id + "/undo", { method: "POST", headers: H, body: "{}" });
  check("the failure card's call cannot be undone once the retry went", undo.status === 409 && !(await desk.$(`[data-undo="${f.id}"]`)), String(undo.status));
  await sleep(1000);
  check("still one message", (await office("state")).messages.length === 1);
}

// 404, walk 2: a drop keeps the Undo time of every other call; the tasks are free only after it.
if (mode === 404) {
  const openOf = async (start: string) => (await wg()).filter((c: any) => c.packet?.question.startsWith(start) && c.state === "open").length;
  const undo = () => fetch(base + "/api/cards/" + f.id + "/undo", { method: "POST", headers: H, body: "{}" });
  check("drop is taken", (await decide(await failCard(), { choice: "drop" })).ok);
  let d = await tab(desk, "decided");
  check("Decided: the drop frees the tasks when its Undo time ends, and has an Undo", d.includes("Frees their tasks when its Undo time ends; you can undo it until then.") && !!(await desk.$(`[data-undo="${f.id}"]`)), d.match(/Frees[^\n]*/)?.[0] ?? "");
  check("inside the Undo time, no task has a new card", (await openOf("The campaign level list")) + (await openOf("Move the old Wallwars site")) === 0);
  check("Undo inside the Undo time is taken, and the failure card is back whole", (await undo()).ok && (await failCard()).state === "open" && JSON.stringify((await failCard()).packet) === JSON.stringify(f.packet));
  await sleep(31_000);
  check("after the Undo, still no new card", (await openOf("The campaign level list")) + (await openOf("Move the old Wallwars site")) === 0);
  check("drop again is taken", (await decide(await failCard(), { choice: "drop" })).ok);
  await sleep(31_000);
  d = await tab(desk, "decided");
  check("Decided: the drop freed the tasks, with no Undo", d.includes("Your drop freed their tasks; it cannot be taken back. Each task may have a new packet.") && !(await desk.$(`[data-undo="${f.id}"]`)), d.match(/Your drop[^\n]*/)?.[0] ?? "");
  const u = await undo();
  check("Undo after the Undo time is refused", u.status === 409 && /freed their tasks/.test(await u.text()), String(u.status));
  check("each task has a new card", (await openOf("The campaign level list")) === 1 && (await openOf("Move the old Wallwars site")) === 1);
}

await browser.close();
console.log(fails ? `${fails} FAIL` : "ALL PASS");
process.exit(fails ? 1 : 0);
