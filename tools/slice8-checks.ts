// Slice 8, Wall Game triage (DESIGN.md section 16), on a walkthrough copy:
// the fake office's Wall Game board gives the cards, and the checks play
// Wall Game PM. It waits out a 3-minute burst, so it takes about 7 minutes.
// Run it on a fresh copy:
//   PORT=21199 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/slice8-checks.ts http://localhost:21199
import { chromium, devices } from "playwright-core";

const base = process.argv[2];
const H = { "X-Isomux-Member-Id": "m0000000", "Content-Type": "application/json" };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const view = async () => (await (await fetch(base + "/api/view", { headers: H })).json()) as any;
const office = async (path: string, body?: unknown) => (await (await fetch(base + "/fake-office/control/" + path, body === undefined ? {} : { method: "POST", headers: H, body: JSON.stringify(body) })).json()) as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
};
const GO_LINE = "go allows the work up to a deploy, push, prod write or bot restart. Those still need your word in an ask.";
const wg = async () => (await view()).cards.filter((c: any) => c.project === "wallgame");
const byTitle = async (start: string) => (await wg()).filter((c: any) => c.packet?.question.startsWith(start)).at(-1);
for (let i = 0; i < 60 && (await wg()).filter((c: any) => c.state === "open").length < 4; i++) await sleep(1000);
for (let i = 0; i < 60 && (await view()).cards.some((k: any) => k.state === "predicting"); i++) await sleep(500);
const taskId = async (title: string) => (await office("state")).tasks.find((t: any) => t.title.startsWith(title)).id as string;
const ptDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

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
  await p.click(`[data-tab=${name}]`);
  await p.waitForTimeout(800);
  return p.evaluate(() => document.body.innerText) as Promise<string>;
};

// 1. Which tasks get a card.
{
  const cs = await wg();
  const titles = cs.map((c: any) => c.packet.question).sort();
  check("1. five cards: Nil's report, the move, the share button, the task with no priority, and the long status log (round Q1, C8); none for a claimed, in-progress or decided task", JSON.stringify(titles) === JSON.stringify(["Daily video: post to a second account", "Move the old Wallwars site off Fly", "Puzzle of the day: a share button", "The campaign level list shows the old stars after a win", "The engine moves to the server"]), titles.join(" | "));
}

// 2. The card on a desktop: its chip, the go line under the call, the packet.
const camp = await byTitle("The campaign level list");
const desk = await page("desk");
{
  const sel = await open(desk, camp.id);
  const r = await desk.evaluate((s: string) => {
    const c = document.querySelector(s)!;
    const top = (q: string) => Math.round(c.querySelector(q)?.getBoundingClientRect().top ?? -1);
    return { chip: c.querySelector(".kind")?.textContent, help: [...c.querySelectorAll(".fhelp")].map((e) => e.textContent), text: (c as HTMLElement).innerText, chipTop: top(".kind"), navTop: top(".cardnav"), note: c.querySelector("[data-note]")?.getAttribute("placeholder") };
  }, sel);
  check("2. desk: Previous and Next sit on the chip's row", r.navTop >= 0 && Math.abs(r.navTop - r.chipTop) <= 8, r.chipTop + " / " + r.navTop);
  check("2. the note says it goes to Wall Game PM", r.note === "Note: goes to Wall Game PM as you write it", String(r.note));
  check("2. the chip names the project where two triage kinds show", r.chip === "Triage (Wall Game)", String(r.chip));
  check("2. the go line shows under the call's choices", r.help.includes(GO_LINE), JSON.stringify(r.help));
  check("2. the packet says the board's priority and the task", /Priority on the board: P2\. Task t[0-9a-f]+/.test(r.text) && /until a reload/.test(r.text), r.text.slice(0, 300));
}

// 3. Nil's call with a note, on the page; a second call through the API.
{
  const sel = `[data-card="${camp.id}"]`;
  // The note box, not the chat box (round q1, H1: the chat is the card's first textarea).
  const note = desk.locator(`${sel} [data-note]`).first();
  await note.evaluate((e: HTMLElement) => e.scrollIntoView({ block: "center" }));
  await note.click();
  await note.fill("This one first.");
  await desk.mouse.wheel(0, 200);
  await desk.waitForTimeout(600);
  await desk.locator(`[data-callzone="${camp.id}"] .actions [data-confirm]`).first().evaluate((e: HTMLElement) => e.scrollIntoView({ block: "center" }));
  await desk.waitForTimeout(600);
  await desk.locator(`[data-callzone="${camp.id}"] .actions [data-confirm]`).first().click();
  await desk.waitForTimeout(800);
  const mv = await byTitle("Move the old Wallwars site");
  const r = await fetch(base + "/api/cards/" + mv.id + "/decide", { method: "POST", headers: H, body: JSON.stringify({ version: mv.version, call: { choice: "obsolete", priority: null, note: "" } }) });
  // A third call, on a task that Wall Game Worker 3 claims inside the burst (4).
  let dv = await byTitle("Daily video");
  for (let i = 0; i < 60 && dv.state !== "open"; i++) (await sleep(1000), (dv = await byTitle("Daily video")));
  const r3 = await fetch(base + "/api/cards/" + dv.id + "/decide", { method: "POST", headers: H, body: JSON.stringify({ version: dv.version, call: { choice: "go", priority: "P3", note: "" } }) });
  check("3. the three calls are taken", (await byTitle("The campaign level list")).state === "decided" && r.ok && r3.ok);
  await sleep(26_000);
  const d = await tab(desk, "decided");
  check("3. after the Undo time, Decided says the call waits for a pause, and Undo still works", /Goes out once you make no new call of this kind for 3 minutes; you can undo it until then\./.test(d) && !!(await desk.$(`[data-undo="${camp.id}"]`)), d.slice(0, 400));
}

// 4. A waiting card withdraws when its task is claimed.
{
  const share = await byTitle("Puzzle of the day");
  await office("task/edit", { id: await taskId("Puzzle of the day"), patch: { assignee: "Wall Game Worker 2" } });
  for (let i = 0; i < 80 && (await byTitle("Puzzle of the day")).state !== "withdrawn"; i++) await sleep(1000);
  await desk.reload();
  await desk.waitForTimeout(1500);
  const d = await tab(desk, "decided");
  check("4. a claimed task's card leaves the queue, and Decided says who took it", (await byTitle("Puzzle of the day")).id === share.id && /Wall Game Worker 2 took the task on the board\./.test(d), d.match(/.{0,60}took the task.{0,20}/)?.[0] ?? "");
  // F1: a decided call whose task is claimed before the send does not go out.
  await office("task/edit", { id: await taskId("Daily video"), patch: { assignee: "Wall Game Worker 3" } });
  // The board source reads every 60 s; the page reads again after a reload, as in 4 and 5.
  const notSent = async () => {
    await desk.reload();
    await desk.waitForTimeout(1500);
    return /Not sent\. Wall Game Worker 3 took the task on the board\./.test(await tab(desk, "decided"));
  };
  let seen = false;
  for (let i = 0; i < 30 && !(seen = await notSent()); i++) await sleep(2000);
  check("4. a decided call whose task is claimed inside the burst: Decided says it was not sent, and why", seen);
}

// 5. One message to Wall Game PM for the burst; no Undo after it.
{
  for (let i = 0; i < 300 && !(await office("state")).messages.length; i++) await sleep(1000);
  const st = await office("state");
  const m = st.messages;
  check("5. one message, to Wall Game PM by its id, with the two calls and not the claimed one", m.length === 1 && m[0].to === "agent-0000000000002-aaab" && /^Antifeed: the Antifeed app sends you 2 triage calls that Nil made in Antifeed/.test(m[0].text) && !/Daily video/.test(m[0].text), m.map((x: any) => x.text.slice(0, 60)).join(" | "));
  const day = ptDay();
  const campTask = await taskId("The campaign level list");
  check(
    "5. each call's block: task, call with its PT time, Nil's note, the board line, the Check line",
    m.length === 1 && new RegExp(`${campTask} "The campaign level list shows the old stars after a win"\\nCall: go P2 \\(Nil, ${day} \\d{1,2}:\\d\\d [AP]M PT\\)\\nNote: This one first\\.\\nBoard line: Nil, ${day}: go P2\\. This one first\\.\\nCheck: curl -s http://127\\.0\\.0\\.1:\\d+/api/cards/${camp.id}/context`).test(m[0].text) && /Board line: Nil, \d{4}-\d\d-\d\d: obsolete\.\n/.test(m[0].text),
    m[0]?.text,
  );
  await desk.reload();
  await desk.waitForTimeout(1500);
  const d = await tab(desk, "decided");
  check("5. Decided: sent to Wall Game PM, cannot be taken back, not on the board yet; no Undo", /Sent to Wall Game PM .*; it cannot be taken back\. Not on the board yet\./.test(d) && !(await desk.$(`[data-undo="${camp.id}"]`)), d.match(/.{0,40}Sent to Wall Game PM.{0,90}/)?.[0] ?? d.slice(0, 300));
  const s = await tab(desk, "status");
  check("5. Status lists the two sent calls, neither on the board yet", /Calls sent \(2\)/.test(s) && (s.match(/Not on the board yet\./g) ?? []).length === 2, s.match(/Calls sent[\s\S]{0,300}/)?.[0] ?? "");
}

// 5b. Accuracy names the kind as the queue does.
{
  const a = await tab(desk, "accuracy");
  check("5b. Accuracy names the kind Triage (Wall Game)", a.includes("Triage (Wall Game)"), a.match(/Triage[^\n]{0,30}/g)?.slice(0, 4).join(" | ") ?? "");
}

// 6. Wall Game PM writes the call line: the call lands. After 24 h without it, a call says so.
{
  const id = await taskId("The campaign level list");
  const t = (await office("state")).tasks.find((x: any) => x.id === id);
  await office("task/edit", { id, patch: { description: `Nil, ${ptDay()}: go P2. This one first.\n\n${t.description}` } });
  for (let i = 0; i < 80 && !(await view()).landing.find((l: any) => l.card === camp.id)?.landedAt; i++) await sleep(1000);
  await desk.reload();
  await desk.waitForTimeout(1500);
  const s = await tab(desk, "status");
  check("6. Status: the campaign call is on the board; the obsolete call is not yet", /The campaign level list shows the old stars after a win: go P2, sent to Wall Game PM .*\. On the board /.test(s) && /Move the old Wallwars site off Fly: obsolete, sent to Wall Game PM .*\. Not on the board yet\./.test(s), s.match(/Calls sent[\s\S]{0,400}/)?.[0] ?? "");
  // The page counts 24 h from the send: an older send stands in for a day's wait.
  // polling = true: the page's next read does not replace the changed copy before the check reads it.
  await desk.evaluate("polling = true; for (const l of V.landing) if (!l.landedAt) l.sentAt = new Date(Date.now() - 25 * 3600000).toISOString(); redraw();");
  await desk.waitForTimeout(500);
  const late = await desk.evaluate(() => document.body.innerText);
  check("6. 24 h after the send without its line, Status says the call is not on the board", /Calls sent \(2, 1 not on the board\)/.test(late) && /Not on the board: Wall Game PM has not written its line in 24 h\./.test(late), late.match(/Calls sent[\s\S]{0,400}/)?.[0] ?? "");
}
await desk.context().close();

// 7. A phone: the Wall Game card and Status keep the page's width.
{
  // A new task: the four first cards are decided or withdrawn by now. The board source reads every 60 s.
  await office("task", { title: "Bot names on the phone leaderboard", priority: "P3", description: "Long bot names push the score column off the screen on a phone." });
  let vid = await byTitle("Bot names on the phone");
  for (let i = 0; i < 150 && vid?.state !== "open"; i++) (await sleep(1000), (vid = await byTitle("Bot names on the phone")));
  const p = await page("phone");
  await open(p, vid.id);
  // Slice 8 walk: on a phone the head is two rows (the kind with Previous / Next, then one fold) before the title.
  const head = await p.$eval(`[data-card="${vid.id}"]`, (c: Element) => {
    const kids = [...c.children];
    const qi = kids.findIndex((x) => x.classList.contains("question"));
    const rows = kids.slice(0, qi).map((x) => (x.tagName === "DETAILS" ? (x.querySelector("summary") as HTMLElement).getBoundingClientRect().height : x.getBoundingClientRect().height));
    return { n: rows.length, rows: rows.map(Math.round), sum: c.querySelector(".metamore > summary")?.textContent ?? "" };
  });
  check("7. phone: two rows of head before the title, the second a fold with the board priority", head.n === 2 && head.rows.every((h: number) => h <= 60) && /^Board P3/.test(head.sum), JSON.stringify(head));
  const wide1 = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  // On a phone Status is under the tab bar's "more": open it by its address.
  await p.goto(base + "/#status");
  await p.waitForSelector("[data-landing]");
  const wide2 = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  check("7. phone: no sideways scroll on a Wall Game card or on Status", !wide1 && !wide2, JSON.stringify([wide1, wide2]));
  await p.context().close();
}

await browser.close();
console.log(fails ? `${fails} FAIL` : "ALL PASS");
process.exit(fails ? 1 : 0);
