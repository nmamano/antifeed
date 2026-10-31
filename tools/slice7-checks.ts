// Slice 7, the Inbox (DESIGN.md section 14): Nil's asks and pages as cards,
// on a walkthrough copy, whose fake office (/fake-office) plays the agents.
// It uses up Inbox cards and waits out two Undo times, so run it on a fresh copy:
//   PORT=21199 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/slice7-checks.ts http://localhost:21199
import { readFileSync } from "node:fs";
import { chromium, devices, type Page } from "playwright-core";

const base = process.argv[2];
const H = { "X-Isomux-Member-Id": "m0000000", "Content-Type": "application/json" };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const view = async () => (await (await fetch(base + "/api/view", { headers: H })).json()) as any;
const office = async (path: string, body?: unknown) => (await (await fetch(base + "/fake-office/control/" + path, body === undefined ? {} : { method: "POST", headers: H, body: JSON.stringify(body) })).json()) as any;
const api = async (path: string, body: unknown) => {
  const r = await fetch(base + path, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
// Round q1 (H1 put the chat between the Premove and Your call): the card's
// own Confirm is hidden while the call bar shows (Round 11), so a click on it
// first brings it into view, and the bar goes.
async function clickConfirm(pg: Page, scope: string): Promise<void> {
  const b = pg.locator(`${scope} .actions [data-confirm]`).first();
  await b.evaluate((e: HTMLElement) => e.scrollIntoView({ block: "center" }));
  await pg.waitForTimeout(400);
  await b.click();
}

const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
};
const inboxCards = async () => (await view()).cards.filter((c: any) => c.project === "inbox");
for (let i = 0; i < 60 && (await inboxCards()).filter((c: any) => c.state === "open").length < 5; i++) await sleep(500);
for (let i = 0; i < 60 && (await view()).cards.some((k: any) => k.state === "predicting"); i++) await sleep(500);
const byQ = async (start: string) => (await inboxCards()).find((c: any) => c.state === "open" && c.packet?.question.startsWith(start));

async function page(kind: "desk" | "phone") {
  const o = kind === "phone" ? { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } : { viewport: { width: 1400, height: 1000 } };
  const c = await browser.newContext({ ...o, extraHTTPHeaders: { "X-Isomux-Member-Id": H["X-Isomux-Member-Id"] }, permissions: ["clipboard-read", "clipboard-write"] });
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
    await p.waitForTimeout(900);
  }
  return `[data-card="${id}"]`;
}

// 1. Every ask and page comes in; the seeded secret request does not, and
// nor do an ask and a page for another member.
await office("ask", { agentId: "agent-demo-worker", prompt: "The deploy key, please", secret: { requestId: "s1" } });
await office("ask", { agentId: "agent-demo-worker", prompt: "For another member", memberUserId: "member-other" });
await office("page", { title: "A page for another member", targetUserId: "member-other" });
await sleep(11_000);
{
  const cs = await inboxCards();
  check("1. three asks and two pages come in as cards; a secret request never does", cs.filter((c: any) => c.policy === "ask").length === 3 && cs.filter((c: any) => c.policy === "page" && c.kind === "action").length === 2 && !cs.some((c: any) => /deploy key/.test(c.packet?.question ?? "")), cs.map((c: any) => c.packet?.question).join(" | "));
  check("1. an ask and a page for another member never come in", !cs.some((c: any) => /another member/.test(c.packet?.question ?? "")));
}

const p = await page("desk");
// 2. The ask with options: the agent's pick, letters, the screenshot, the command to copy, no note box, the Premove's words in the reply box.
{
  const c = await byQ("Ship the new sign-in footer");
  const sel = await open(p, c.id);
  const r = await p.$eval(sel, (e: Element) => ({
    opts: [...e.querySelectorAll(".option")].map((o) => o.textContent),
    pick: e.querySelector(".option.pm")?.textContent ?? "",
    img: !!e.querySelector(".packet img"),
    code: e.querySelector(".codeline pre")?.textContent,
    note: !!e.querySelector("[data-note]"),
    words: (e.querySelector("textarea[data-text=text]") as HTMLTextAreaElement)?.value,
    pm: [...e.querySelectorAll(".option.pm")].map((o) => o.textContent),
    on: [...e.querySelectorAll(".option.on")].map((o) => o.textContent),
    tid: !!e.querySelector(".tid"),
  }));
  check("2. options as the agent wrote them, the Premove's option marked, a screenshot, a command line, no note box, no ask id", r.opts.length === 3 && /Behind a flag first/.test(r.pick) && r.img && r.code === "bun run deploy --flag signin-footer" && !r.note && !r.tid, JSON.stringify(r));
  // Round Q1, C2: the Premove's option has the Premove's mark, and it is the pick.
  check("2. the Premove fills the reply with the option's words, and marks option B", r.words === "Behind a flag first" && r.pm.length === 1 && /^Behind a flag first/.test(r.pm[0] ?? "") && r.on.join() === r.pm.join(), JSON.stringify({ words: r.words, pm: r.pm, on: r.on }));
  await p.click(`${sel} .codeline [data-copy]`);
  await p.waitForTimeout(300);
  check("2. Copy puts the command on the clipboard", (await p.evaluate(() => navigator.clipboard.readText())) === "bun run deploy --flag signin-footer");
  // Round Q1, C2: no help line under the options; an option that fills like every other shows no pill.
  const help = await p.$$eval(`${sel} .options ~ .fhelp, ${sel} .options .fhelp`, (es: Element[]) => es.map((e) => e.textContent).filter((t) => /option/i.test(t ?? "")));
  check("2. the options do not repeat what they fill, and no help line explains them", r.opts[0] === "Ship it to everyone now" && !help.length, JSON.stringify({ opt: r.opts[0], help }));
  const head = await p.$eval(`${sel}`, (e: Element) => e.textContent ?? "");
  check("2. the card names the agent once (no Asked by row)", !/Asked by/.test(head), "");
}
// 3. A reply needs words.
{
  const c = await byQ("What should the error say");
  const sel = await open(p, c.id);
  const before = await p.$eval(`${sel} textarea[data-text=text]`, (e: HTMLTextAreaElement) => e.value);
  check("3. a free-text ask: the Premove's draft is in the reply box", /This link has expired/.test(before), before);
  await p.fill(`${sel} textarea[data-text=text]`, "");
  await p.$eval(`${sel} .premove`, (e: Element) => e.scrollIntoView({ block: "center" }));
  await p.waitForTimeout(1500);
  await clickConfirm(p, sel);
  await p.waitForTimeout(400);
  const err = await p.$eval(sel, (e: Element) => e.querySelector(".frow.ftext .rowerr")?.textContent ?? "");
  check("3. Confirm with no words says what is missing, on the reply box", err === "Reply needs words: write them here.", err);
  // 4. Nil's own words go out after the Undo time, and then the Undo is gone.
  await p.fill(`${sel} textarea[data-text=text]`, "Make it: This link has expired. Check your email.");
  await p.waitForTimeout(200);
  await clickConfirm(p, sel);
  await p.waitForTimeout(1000);
  let st = await office("state");
  check("4. nothing goes to the agent inside the Undo time", st.answers.length === 0, JSON.stringify(st.answers));
  await sleep(26_000);
  st = await office("state");
  check("4. after it, the reply goes to the agent once, with Nil's words", st.answers.length === 1 && st.answers[0].how === "reply" && st.answers[0].text === "Make it: This link has expired. Check your email.", JSON.stringify(st.answers));
  const d = (await view()).cards.find((x: any) => x.id === c.id);
  check("4. the call counts as edited (own words both), not changed", d.outcome === "edited", d.outcome);
  await p.click("[data-tab=decided]");
  await p.waitForTimeout(600);
  const line = await p.$$eval(".dline", (es: Element[], q: string) => { const e = es.find((x) => x.textContent!.includes(q)); return e ? { text: e.textContent, undo: !!e.querySelector("[data-undo]") } : null; }, "What should the error say");
  check("4. Decided says it was sent and offers no Undo", !!line && /Sent just now; it cannot be taken back/.test(line.text) && !/<span/.test(line.text) && !line.undo, JSON.stringify(line));
  const u = await api(`/api/cards/${c.id}/undo`, {});
  check("4. an Undo after the send is refused with the reason", u.status === 409 && u.body.error === "Your answer went to the agent; it cannot be taken back.", JSON.stringify(u));
  await p.click("[data-tab=queue]");
  await p.waitForTimeout(400);
}
// 5. Answered in the Inbox first: the card withdraws and says why.
{
  const c = await byQ("Run the database migration");
  const st = await office("state");
  const a = st.asks.find((x: any) => x.prompt.startsWith("Run the database migration"));
  await office("ask/close", { id: a.id });
  await sleep(11_000);
  const d = (await view()).cards.find((x: any) => x.id === c.id);
  check("5. an ask answered in the Inbox withdraws its card, with the reason", d.state === "withdrawn" && d.withdrawn?.reason === "Answered in the Isomux Inbox, or taken back by its agent, so it no longer waits for you.", JSON.stringify(d.withdrawn));
}
// 6. An agent edits its ask: the old card goes, a new one has the new words.
{
  const c = await byQ("Ship the new sign-in footer");
  const st = await office("state");
  const a = st.asks.find((x: any) => x.prompt.startsWith("Ship the new sign-in footer"));
  await office("ask/edit", { id: a.id, patch: { prompt: "Ship the new sign-in footer to every member now, or behind a flag first? (The flag now costs an hour.)" } });
  await sleep(11_000);
  const cs = await inboxCards();
  const old = cs.find((x: any) => x.id === c.id);
  const now = cs.find((x: any) => x.state !== "withdrawn" && /costs an hour/.test(x.packet?.question ?? ""));
  check("6. an edited ask: the old card withdraws with the reason, a new card has the new words", old.state === "withdrawn" && /changed the ask/.test(old.withdrawn?.reason ?? "") && !!now, JSON.stringify({ old: old.withdrawn, now: now?.packet?.question }));
}
// 7. A page: Done acks it after the Undo time; acked in the Inbox withdraws the other.
{
  const cs = await inboxCards();
  const disk = cs.find((x: any) => x.state === "open" && x.packet?.question.startsWith("The build box disk"));
  const backup = cs.find((x: any) => x.state === "open" && x.packet?.question.startsWith("Restart the stuck nightly backup"));
  const r = await api(`/api/cards/${disk.id}/action`, { ok: true });
  const st0 = await office("state");
  const bp = st0.pages.find((x: any) => x.title.startsWith("Restart the stuck"));
  await office("page/state", { id: bp.id, state: "acked" });
  await sleep(26_000);
  const st = await office("state");
  const dp = st.pages.find((x: any) => x.title.startsWith("The build box disk"));
  check("7. a page's Done acks it in the office after its Undo time", r.status === 200 && st.acks.includes(dp.id) && dp.state === "acked", JSON.stringify({ status: r.status, acks: st.acks }));
  const b = (await view()).cards.find((x: any) => x.id === backup.id);
  check("7. a page acked in the Inbox withdraws its card, with the reason", b.state === "withdrawn" && b.withdrawn?.reason === "Acked in the Isomux Inbox, so it no longer waits for you.", JSON.stringify(b.withdrawn));
}
// 8. The phone: the reply box is full width, the command line fits, nothing runs off the screen.
{
  const ph = await page("phone");
  const c = await byQ("Ship the new sign-in footer");
  const sel = await open(ph, c.id);
  const r = await ph.$eval(sel, (e: Element) => ({
    words: (e.querySelector("textarea[data-text=text]") as HTMLElement).getBoundingClientRect().width,
    card: e.getBoundingClientRect().width,
    wide: document.documentElement.scrollWidth,
  }));
  check("8. phone: the reply box spans the call zone and the page has no sideways scroll", r.words > r.card * 0.8 && r.wide <= 390, JSON.stringify(r));
}
// 8b. Slice 7 walk, round 2: an ask the consult does not answer, a page
// raised again, Could not do it, the words on Status, a reply refused while
// Inbox access is off.
{
  const png = readFileSync(new URL("../projects/demo/assets/after.png", import.meta.url));
  await office("ask", { agentId: "agent-demo-ops", prompt: "Restart the stuck export job?", options: ["Clear it and restart", "Only restart"], recommended: "Only restart", files: [{ name: "export.png", type: "image/png", base64: png.toString("base64") }] });
  await office("page", { title: "The export job is stuck", key: "export", agentId: "agent-demo-ops", agentName: "Demo Ops", roomId: "room-ops" });
  await sleep(11_000);
  for (let i = 0; i < 60 && (await inboxCards()).some((x: any) => x.state === "predicting"); i++) await sleep(500);
  const a = await byQ("Restart the stuck export job");
  check("8b. no Premove from the consult: the stand-in fills in the author's pick with its words", a?.prediction?.by === "code:standin" && a.prediction.call.action === "reply" && a.prediction.call.text === "Only restart", JSON.stringify(a?.prediction?.call));
  const q = await page("desk");
  const sel = await open(q, a.id);
  const head = await q.$eval(sel, (e: Element) => ({
    chip: e.querySelector(".kind")?.textContent,
    // Round q1, H2: the agent is a chip with its initials; the words leave the avatar out.
    from: [...e.querySelectorAll(".meta span, .cardmeta span, span")].map((x) => { const y = x.cloneNode(true) as Element; y.querySelectorAll(".av").forEach((v) => v.remove()); return y.textContent ?? ""; }).find((t) => /^From /.test(t)) ?? "",
    img: (() => { const i = e.querySelector(".packet .thumb.wide img") as HTMLImageElement; const t = i?.parentElement as HTMLElement; if (!i || !t) return null; const room = t.clientWidth - parseFloat(getComputedStyle(t).paddingLeft) - parseFloat(getComputedStyle(t).paddingRight); return { shown: Math.round(i.getBoundingClientRect().width), height: Math.round(i.getBoundingClientRect().height), natural: i.naturalWidth, naturalH: i.naturalHeight, room: Math.round(room) }; })(),
  }));
  check("8b. an ask's chip says Ask for you, its head says From the agent", head.chip === "Ask for you" && head.from === "From Demo Ops", JSON.stringify(head));
  // Round Q1, C8: the packet fits one screen, so the image also stops at 480 px tall (its shape kept).
  const want = head.img ? Math.min(head.img.natural, head.img.room, (480 * head.img.natural) / head.img.naturalH) : 0;
  check("8b. an ask's image shows at its own size up to the card's width and 480 px tall, never larger", !!head.img && Math.abs(head.img.shown - want) <= 2 && head.img.height <= 481, JSON.stringify(head.img));
  // The page: raised again with the same words, the card shows the count; its chip and border match; Details, not Steps.
  await office("page", { title: "The export job is stuck", key: "export", agentId: "agent-demo-ops", agentName: "Demo Ops", roomId: "room-ops" });
  await sleep(11_000);
  const pg = await byQ("The export job is stuck");
  const psel = await open(q, pg.id);
  const look = await q.$eval(psel, (e: Element) => ({
    chip: getComputedStyle(e.querySelector(".kind")!).getPropertyValue("--kc").trim() || e.getAttribute("style"),
    border: getComputedStyle(e).borderLeftColor,
    dot: getComputedStyle(e.querySelector(".kind")!, "::before").backgroundColor,
    label: e.querySelector(".zone.packet .zlabel")?.textContent,
    raised: e.textContent!.includes("2 times"),
    version: /Version 2/.test(e.textContent!),
  }));
  check("8b. a page raised again with the same words shows the new count on its card, and no Version chip", look.raised && pg.version === 2 && !look.version, JSON.stringify({ v: pg.version, chip: look.version }));
  check("8b. a page card: Details, not Steps; its left border has the chip's color", look.label === "Details" && look.border === look.dot, JSON.stringify(look));
  // Could not do it on the page, and a reply to the ask that goes out while Inbox access is off.
  await api(`/api/cards/${pg.id}/action`, { ok: false, note: "no access to the box" });
  const dr = await api(`/api/cards/${a.id}/decide`, { version: a.version, call: { action: "reply", text: "Only restart" } });
  await office("reach", { switch: false });
  await q.click("[data-tab=status]");
  await q.waitForTimeout(1500);
  const st1 = await q.$eval("body", (e: Element) => e.textContent ?? "");
  check("8b. Status names a held answer in words: Your reply to the agent, with the ask, no ids", dr.status === 200 && /Your reply to Demo Ops · “Restart the stuck export job\?”: goes out in/.test(st1) && /Reads your Inbox in the office/.test(st1), st1.match(/Your reply[^.]*\./)?.[0] ?? "");
  await sleep(28_000);
  const v = await view();
  const failed = v.cards.find((x: any) => x.policy === "command-failed" && x.state !== "withdrawn" && /^Your reply to Demo Ops did not go out/.test(x.packet?.question ?? ""));
  check("8b. a reply refused while Inbox access is off: the failure card says so in words, and its Premove is not a retry", !!failed && /the office did not let Antifeed answer this ask/.test(failed.packet.question) && failed.prediction?.call?.choice === "drop", JSON.stringify({ q: failed?.packet?.question, pre: failed?.prediction?.call }));
  const status = await (await fetch(base + "/api/status", { headers: H })).json();
  // Walk round 3: the failure card on a phone fits the screen (no command id in its head).
  {
    const ph = await page("phone");
    const fsel = await open(ph, failed.id);
    const w = await ph.evaluate(() => ({ wide: document.documentElement.scrollWidth, inner: innerWidth }));
    const tid = await ph.$(`${fsel} .tid`);
    check("8b. phone: the failure card fits the screen (scrollWidth), with no command id in its head", w.wide <= 390 && !tid, JSON.stringify(w));
    await ph.context().close();
  }
  check("8b. Could not do it on a page is not a failed command on Status", !status.failed.some((k: any) => k.type === "inbox.page"), JSON.stringify(status.failed.map((k: any) => k.type)));
  await q.click("[data-tab=decided]");
  await q.waitForTimeout(800);
  const dl = await q.$$eval(".dline", (es: Element[]) => es.map((e) => e.textContent ?? "").find((t) => t.includes("The export job is stuck")) ?? "");
  check("8b. Decided: Could not do it on a page sent nothing", /nothing sent; the page stays open in the office/.test(dl), dl);
  await q.click("[data-tab=queue]");
  await q.waitForTimeout(800);
  // Queue round 1 (S1): the access state is on the Sources tab, not in the queue.
  const qtext = await q.$eval("#tab-queue", (e: Element) => e.textContent ?? "");
  await q.click("[data-tab=sources]");
  await q.waitForTimeout(800);
  const alert = await q.$eval('[data-source^="inbox:"]', (e: Element) => e.textContent).catch(() => "");
  check("8b. with Inbox access off, Sources says so in the Inbox line, with no switch and no step; the queue does not", /^Office Inbox: read .*\. Your asks do not come into Antifeed yet\. Your pages do\.$/.test(alert ?? "") && !qtext.includes("asks do not come"), alert ?? "");
  await q.click("[data-tab=queue]");
  await office("reach", { switch: true });
}
// 8c. Desktop, walk round 3: after a mouse Confirm the toast's Undo does not
// move for 2 s while the mouse moves, with the call bar showing and not.
for (const bar of [true, false]) {
  const q = await page("desk");
  const c = (await inboxCards()).find((x: any) => x.state === "open" && x.kind === "decision" && x.policy === "ask" && x.prediction) ?? (await view()).cards.find((x: any) => x.state === "open" && x.kind === "decision" && x.prediction && x.policy !== "command-failed");
  if (!c) { check("8c. a card to confirm", false); break; }
  const sel = await open(q, c.id);
  await q.mouse.move(700, 500);
  await q.mouse.wheel(0, 300);
  await q.waitForTimeout(400);
  await q.mouse.wheel(0, -300);
  await q.waitForTimeout(1500);
  const btn = await q.evaluate((s: string) => { const b = document.querySelector(s + " .actions [data-confirm]") as HTMLElement; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
  await q.waitForTimeout(300);
  await q.mouse.move(btn.x, btn.y, { steps: 3 });
  await q.mouse.down();
  await q.mouse.up();
  // The next card: its Confirm below the fold shows the bar; scrolled to the top, the bar may show or not.
  // Without the bar: the next card's own Confirm in view hides the bar.
  if (!bar) {
    await q.waitForTimeout(150);
    await q.evaluate(() => (document.querySelector("[data-card] .actions [data-confirm], [data-card] .actions [data-done]") as HTMLElement)?.scrollIntoView({ block: "center" }));
  }
  const boxes: string[] = [];
  for (let t = 0; t < 10; t++) {
    await q.mouse.move(300 + t * 40, 400 + (t % 2) * 60, { steps: 2 });
    boxes.push(await q.evaluate(() => { const u = document.querySelector("#toast [data-toast-undo]") as HTMLElement | null; if (!u) return "none"; const r = u.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}`; }));
    await q.waitForTimeout(200);
  }
  const barShown = await q.evaluate(() => { const b = document.querySelector(".stickybar") as HTMLElement | null; return !!b && !b.hidden; });
  check(`8c. desk: the toast's Undo stays put for 2 s after a mouse Confirm (bar ${barShown ? "showing" : "not showing"})`, boxes[0] !== "none" && boxes.every((b) => b === boxes[0]), boxes.join(" | "));
  const h = await q.evaluate(() => [...document.querySelectorAll("#hdrdock .toast, #hdrdock .stickybar:not([hidden])")].map((e) => Math.round(e.getBoundingClientRect().height)));
  check("8c. desk: the toast and the bar keep one line in the header", h.every((x) => x <= 46), JSON.stringify(h));
  await api(`/api/cards/${c.id}/undo`, {});
  await q.context().close();
}
// 9. Nil's Inbox access off (isomux task 4a1e58c9): Status says so, a new
// ask does not open, a new page does. With no live owner agent, Status says
// that, and nothing new opens.
{
  const status = async () => {
    await p.click("[data-more]").catch(() => {});
    await p.click("[data-tab=status]");
    await p.waitForTimeout(800);
    return (await p.$eval("[data-inbox-status]", (e: Element) => e.textContent).catch(() => "")) ?? "";
  };
  await office("reach", { switch: false });
  await office("ask", { agentId: "agent-demo-worker", prompt: "One more question" });
  await office("page", { title: "One more page" });
  await sleep(11_000);
  const t = await status();
  const cs = await inboxCards();
  check("9. access off: Status says so, the new ask does not open, the new page does", /^Inbox: your asks do not come into Antifeed yet\. Your pages do\./.test(t) && !cs.some((x: any) => x.packet?.question === "One more question") && cs.some((x: any) => x.packet?.question === "One more page"), t);
  await office("reach", { switch: true, owner: false });
  await office("page", { title: "A page nobody reads" });
  await sleep(11_000);
  const t2 = await status();
  check("9. no live owner agent: Status says so, and nothing new opens", /no live owner agent/.test(t2) && !(await inboxCards()).some((x: any) => x.packet?.question === "A page nobody reads"), t2);
}
// 10. A page has its own chip, not "Action for you".
{
  await p.goto(base + "/");
  await p.waitForSelector("[data-card]");
  const sel = await open(p, (await byQ("One more page")).id);
  const chip = await p.$eval(`${sel} .kind`, (e: Element) => e.textContent);
  check("10. a page's chip says Page for you", chip === "Page for you", chip ?? "");
}

await browser.close();
console.log(fails ? `${fails} FAILED` : "ALL PASS");
