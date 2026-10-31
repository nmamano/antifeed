// Loop-kind card checks (Antifeed PM, 2026-10-30, parts B5 and H), on a walkthrough
// copy whose /api/view is the live view with isomux triage as cardKind loop
// and each open triage card's packet made a loop packet (the pick).
//   bun tools/loop-checks.ts http://localhost:21199 <a saved GET /api/view of live>
import { readFileSync } from "node:fs";
import { chromium, devices } from "playwright-core";
// shots: a folder for the desk and phone screenshots (optional).
const [base, file, shots] = process.argv.slice(2);
const H = { "X-Isomux-Member-Id": "m0000000" };
const live = JSON.parse(readFileSync(file, "utf8"));
const pol = live.policies.find((p: any) => p.id === "triage");
pol.cardKind = "loop";
const tri = live.cards.filter((c: any) => c.policy === "triage" && (c.state === "open" || c.state === "predicting"));
for (const c of tri) {
  c.subjectInfo ??= { title: c.packet.question, priority: c.meta.priority ?? "P2", description: "The task's description as the board has it.\n\nSecond paragraph.", createdAt: Date.now() - 3 * 86400000 };
  // A packet the Curator wrote as a loop packet stays as it is.
  if (c.packet.options?.length === 1 && c.packet.recommended) continue;
  const rec = c.packet.options.find((o: any) => o.id === c.packet.recommended) || c.packet.options[0];
  const pr = c.prediction?.call?.priority ?? "P2";
  const fill = { choice: rec.fill.choice, priority: ["go", "design", "hold"].includes(rec.fill.choice) ? pr : null, ...(rec.fill.scope ? { scope: rec.fill.scope } : {}) };
  const why = c.packet.blocks.find((b: any) => b.type === "markdown")?.text.split("\n")[0].replace(/^Issue:\s*/, "") ?? "";
  c.packet = { question: c.packet.question, blocks: [{ type: "markdown", text: why }, ...c.packet.blocks.filter((b: any) => b.type === "fold")], options: [{ id: "pick", label: (fill.priority ? fill.priority + " · " : "") + fill.choice, fill }], recommended: "pick" };
}
// One card waits for its Premove: it is open to Nil all the same.
tri[1].state = "predicting";
tri[1].prediction = null;
const view = { ...live, cards: tri };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
// Part I: a real image on one card (a non-go one when there is one: it has the
// reason line too), a screenshot of this copy's page, with a focus; a second
// image goes to the Evidence fold.
const shotCard = tri.find((c: any) => c.packet.options.find((o: any) => o.id === c.packet.recommended)?.fill.choice !== "go") ?? tri[0];
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: H });
  const p = await ctx.newPage();
  await p.goto(base + "/");
  await p.waitForTimeout(800);
  const png = await p.screenshot();
  await ctx.close();
  const r = await fetch(base + "/api/blobs", { method: "POST", headers: { "Content-Type": "image/png" }, body: png });
  const { blob } = (await r.json()) as { blob: string };
  const img = (caption: string) => ({ type: "image", blob, focus: { x: 0.02, y: 0.02, w: 0.4, h: 0.5 }, caption });
  shotCard.packet.blocks = [...shotCard.packet.blocks, img("The tabs at the top of the page"), img("The same page, a second image")];
}
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
};
async function page(kind: "desk" | "phone") {
  const o = kind === "phone" ? { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } : { viewport: { width: 1280, height: 1000 } };
  const ctx = await browser.newContext({ ...o, extraHTTPHeaders: H });
  const decided: string[] = [];
  await ctx.route("**/api/view*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...view, cards: view.cards.filter((c: any) => !decided.includes(c.id)) }) }));
  await ctx.route("**/api/cards/*/shown", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await ctx.route("**/api/cards/*/decide", (r) => { decided.push(r.request().url().split("/").at(-2)!); r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await p.goto(base + "/");
  await p.waitForSelector("[data-card]");
  await p.waitForTimeout(500);
  await p.evaluate(() => (window as any).poll(true));
  await p.waitForTimeout(500);
  if (await p.$("[data-remote-ok]")) await p.click("[data-remote-ok]");
  await p.evaluate((id: string) => { (window as any).setCur(id); (window as any).redraw(); }, tri[0].id);
  await p.waitForTimeout(800);
  return { p, decided };
}
const { p: desk, decided } = await page("desk");
const cur = () => desk.$eval("[data-card]", (e: Element) => (e as HTMLElement).dataset.card);
// Part H (Nil, 2026-10-30): the call is in reach with no scroll. Every card,
// made current in turn with j, from the top of the page.
async function eachCard(p: any, label: string, height: number) {
  await p.click("h1").catch(() => {});
  for (let i = 0; i < 100; i++) {
    const before = await p.$eval("[data-card]", (e: Element) => (e as HTMLElement).dataset.card);
    await p.keyboard.press("k");
    await p.waitForTimeout(80);
    if ((await p.$eval("[data-card]", (e: Element) => (e as HTMLElement).dataset.card)) === before) break;
  }
  const rows: any[] = [];
  for (let i = 0; i < tri.length; i++) {
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.waitForTimeout(120);
    rows.push(await p.$eval("[data-card]", (card: Element) => {
      const kids = [...card.children];
      const call = kids.findIndex((x) => x.matches(".loopcall"));
      const above = kids.slice(0, call);
      const text = above.filter((x) => !x.matches(".lreason, .lshot")).map((x) => (x as HTMLElement).innerText.replace(/\b(Previous|Next)\b|‹|›|\(j\)|\(k\)/g, "")).join(" ");
      const chips = card.querySelector("[data-frow=choice]")!.getBoundingClientRect().bottom;
      return { id: (card as HTMLElement).dataset.card, above: above.map((x) => x.className), reason: (card.querySelector(".lreason") as HTMLElement | null)?.innerText ?? null, words: text.split(/\s+/).filter(Boolean).length, chips: Math.round(chips), confirm: Math.round(card.querySelector("[data-confirm]")!.getBoundingClientRect().bottom) };
    }));
    await p.keyboard.press("j");
    await p.waitForTimeout(150);
  }
  const ids = new Set(rows.map((r) => r.id));
  const low = rows.reduce((a, b) => (b.confirm > a.confirm ? b : a));
  const most = rows.reduce((a, b) => (b.words > a.words ? b : a));
  console.log(`INFO ${label}: ${ids.size} cards; lowest Confirm bottom ${low.confirm} px (${low.id}), viewport ${height} px; most words in the head line and title ${most.words} (${most.id})`);
  return { rows, ids, low, most };
}
const dk = await eachCard(desk, "desk 1280 x 1000", 1000);
await desk.evaluate((id: string) => { (window as any).setCur(id); (window as any).redraw(); }, tri[0].id);
await desk.waitForTimeout(300);
check("H5. every isomux card is visited with j", dk.ids.size === tri.length, `${dk.ids.size} of ${tri.length}`);
check("H5. on every card the bottom of Confirm is in the 1280 x 1000 window with no scroll", dk.low.confirm <= 1000, `lowest ${dk.low.confirm} px on ${dk.low.id}`);
// Part I: the image above the chips, cropped, at most 260 px tall; a click opens it whole; the second one is in Evidence.
await desk.evaluate((id: string) => { (window as any).setCur(id); (window as any).redraw(); }, shotCard.id);
await desk.waitForTimeout(800);
const shotInfo = (p: any) => p.$eval("[data-card]", (card: Element) => {
  const s = card.querySelector(".lshot");
  const crop = s?.querySelector(".crop");
  const ev = [...card.querySelectorAll("details")].find((d) => /Evidence/.test(d.querySelector("summary")!.textContent!));
  return { id: (card as HTMLElement).dataset.card, shot: !!s, h: s ? Math.round(s.querySelector(".thumb")!.getBoundingClientRect().height) : 0, imgH: crop ? Math.round(crop.getBoundingClientRect().height) : 0, ready: !!crop?.classList.contains("ready"), box: crop ? (crop.querySelector(".redbox") as HTMLElement).getBoundingClientRect().width > 0 : false, inEvidence: ev ? ev.querySelectorAll("[data-lb]").length : 0, confirm: Math.round(card.querySelector("[data-confirm]")!.getBoundingClientRect().bottom) };
});
const si = await shotInfo(desk);
if (shots) await desk.screenshot({ path: shots + "/desk-image.png" });
console.log("INFO image card " + JSON.stringify(si));
check("I1. the image shows above the chips, cropped with its red box, at most 260 px tall", si.shot && si.ready && si.box && si.imgH > 0 && si.imgH <= 261, JSON.stringify(si));
check("I1. the second image is in the Evidence fold", si.inEvidence === 1, String(si.inEvidence));
await desk.click("[data-card] .lshot [data-lb]");
await desk.waitForTimeout(300);
const lbOpen = await desk.$eval("#lb", (e: Element) => (e as HTMLElement).offsetHeight > 0 && !!e.querySelector("img")).catch(() => false);
check("I1. one click opens the whole image", lbOpen);
await desk.keyboard.press("Escape");
await desk.waitForTimeout(300);
await desk.evaluate((id: string) => { (window as any).setCur(id); (window as any).redraw(); }, tri[0].id);
await desk.waitForTimeout(300);
const pickOf = (id: string) => tri.find((c: any) => c.id === id).packet.options.find((o: any) => o.id === tri.find((c: any) => c.id === id).packet.recommended).fill.choice;
const extra = dk.rows.filter((r: any) => r.above.join("|") !== ["meta lhead", "question", ...(pickOf(r.id) === "go" ? [] : ["lreason"]), ...(r.id === shotCard.id ? ["lshot"] : [])].join("|"));
check("H1. above the chips only the head line, the title, for a pick that is not go its reason line, and the image", extra.length === 0, extra.length ? JSON.stringify(extra[0]) : "");
// H (3): the reason line is the why's first sentence, cut at 20 words.
const expected = (id: string) => {
  const c = tri.find((x: any) => x.id === id);
  const first = (c.packet.blocks.find((b: any) => b.type === "markdown")?.text ?? "").trim().split(/(?<=[.!?])\s+/)[0] ?? "";
  const w = first.split(/\s+/).filter(Boolean);
  return w.length > 20 ? w.slice(0, 20).join(" ") + "…" : first;
};
const nonGo = dk.rows.filter((r: any) => pickOf(r.id) !== "go");
for (const r of nonGo) console.log(`INFO not go: ${r.id} (${pickOf(r.id)}): ${r.reason?.split(/\s+/).length} words: ${r.reason}`);
check("H3. a pick that is not go shows its why's first sentence (cut at 20 words) under the title; a go pick shows none", nonGo.every((r: any) => r.reason === expected(r.id)) && dk.rows.every((r: any) => pickOf(r.id) !== "go" || r.reason === null), `${nonGo.length} not go`);
// The 50 words are the head line and the title; a reason line (H3) adds up to 20 more.
check("H5. 50 words or fewer in the head line and the title", dk.most.words <= 50, `${dk.most.words} on ${dk.most.id}`);
const after = await desk.$eval("[data-card]", (card: Element) => {
  const kids = [...card.children];
  const call = kids.findIndex((x) => x.matches(".loopcall"));
  return { below: kids.slice(call + 1).map((x) => x.tagName + "." + x.className), open: kids.slice(call + 1).filter((x) => x.matches("details[open]")).length, summaries: kids.slice(call + 1).filter((x) => x.matches("details")).map((x) => x.querySelector("summary")!.textContent) };
});
check("H2. below Confirm only closed folds (Why, Proposed scope, Current description, Evidence)", after.below.length > 0 && after.open === 0 && after.below.every((x: string) => x.startsWith("DETAILS")), JSON.stringify(after));
const zones = await desk.$$eval("[data-card] .zone.premove, [data-card] .zone.against, [data-card] .options, [data-card] .chatpanel", (e: Element[]) => e.length);
check("B2. no Premove, Against, options list or chat on the card", zones === 0, String(zones));
const chips = await desk.$$eval("[data-card] [data-frow=choice] .chip", (e: Element[]) => e.map((b) => b.textContent + (b.classList.contains("on") ? "*" : "") + (b.classList.contains("pm") ? "." : "")));
check("B2. Choice chips: go design hold backlog obsolete rewrite, the pick on and marked", chips.length === 6 && chips.filter((x) => x.includes("*")).length === 1 && chips.filter((x) => x.endsWith(".")).length === 1, chips.join(" "));
// Keys: d picks design; 0 picks P0; j and k move.
const first = await cur();
await desk.click("h1").catch(() => {});
await desk.keyboard.press("j");
await desk.waitForTimeout(300);
const second = await cur();
await desk.keyboard.press("k");
await desk.waitForTimeout(300);
check("B3. j and k move the current card", second !== first && (await cur()) === first, [first, second].join(" "));
// The stray-press guard holds keys for 1.5 s after a card change.
await desk.waitForTimeout(1700);
await desk.keyboard.press("d");
await desk.keyboard.press("0");
await desk.waitForTimeout(200);
const yours = await desk.$eval("[data-card] [data-yours]", (e: Element) => e.textContent);
check("B3. d and 0 pick design and P0; the head line says it", yours === "P0 · design", String(yours));
await desk.keyboard.press("w");
await desk.waitForTimeout(200);
await desk.keyboard.press("Control+Enter");
await desk.waitForTimeout(300);
const err = await desk.$eval("[data-card] .loopcall", (e: Element) => (e as HTMLElement).innerText);
check("B3. a rewrite with no note does not confirm", /needs a note/.test(err) && decided.length === 0, err.slice(0, 120));
// The refused rewrite put the cursor in the note: a click on go, then the keys again.
await desk.click('[data-card] [data-field=choice][data-v=\'"go"\']');
await desk.waitForTimeout(200);
await desk.click("h1").catch(() => {});
await desk.keyboard.press("Control+Enter");
await desk.waitForTimeout(900);
const toastTxt = await desk.$eval("#toast", (e: Element) => (e as HTMLElement).innerText).catch(() => "");
check("B3. the call went as go, not as a rewrite", /Decided/.test(toastTxt) && !/new packet/.test(toastTxt), toastTxt);
check("B3. Ctrl+Enter decides the current card and the next one comes", decided[0] === first && (await cur()) !== first, JSON.stringify({ decided, now: await cur() }));
// The card that waits for its Premove is open and decidable.
const wait = tri[1].id;
check("A3. a card waiting for its Premove is in the queue", !!(await desk.$(`.row[data-cur="${wait}"]`)) || (await cur()) === wait);
const rowTxt = await desk.$$eval(".row .rp", (e: Element[]) => e.map((x) => (x as HTMLElement).innerText));
check("B1. the rows show the pick, never a Premove", rowTxt.length > 0 && rowTxt.every((t) => /^Yours: /.test(t)), rowTxt.slice(0, 3).join(" | "));
if (shots) await desk.screenshot({ path: shots + "/desk.png" });
const { p: phone } = await page("phone");
const ph = await phone.$eval("[data-card]", (e: Element) => ({ chips: e.querySelectorAll(".chip").length, confirm: !!e.querySelector("[data-confirm]") }));
check("B4. on a phone the same card, chips and Confirm", ph.chips >= 6 && ph.confirm, JSON.stringify(ph));
await phone.evaluate((id: string) => { (window as any).setCur(id); (window as any).redraw(); }, shotCard.id);
await phone.waitForTimeout(800);
const psi = await shotInfo(phone);
if (shots) await phone.screenshot({ path: shots + "/phone-image.png" });
console.log("INFO phone image card " + JSON.stringify(psi));
check("I1. phone: the image at most 120 px tall", psi.shot && psi.ready && psi.imgH <= 121, JSON.stringify(psi));
// The rare card with a long title, a reason line and an image may need a small scroll on a phone (Antifeed PM, 2026-10-30): recorded, not a failure.
console.log(`INFO phone: Confirm bottom on the image card ${psi.confirm} px of 844${psi.confirm > 844 ? " (a scroll of " + (psi.confirm - 844) + " px)" : ""}`);
const pk = await eachCard(phone, "phone 390 x 844", 844);
const plain = pk.rows.filter((r: any) => r.id !== shotCard.id).reduce((a: any, b: any) => (b.confirm > a.confirm ? b : a));
check("H5. phone: on every card with no image the chips and Confirm are in the first 844 px with no scroll", plain.confirm <= 844, `lowest Confirm bottom ${plain.confirm} px on ${plain.id}`);
if (shots) await phone.screenshot({ path: shots + "/phone.png", fullPage: true });
await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
