// The checks for the confirm guard, Undo and the call bar (review rounds 5 to 9).
// Each part uses up demo cards, so run each on its own fresh walkthrough copy:
//   PORT=21199 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data1 ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/guard-checks.ts http://localhost:21199 main    (Z, V, W checks)
//   bun tools/guard-checks.ts http://localhost:21199 x1      (X1, X2: a stray second press)
//   bun tools/guard-checks.ts http://localhost:21199 touch   (Z2, Y1, V1, W1 and N1 with touch)
// An act on a card is a tap on a fold, field or chip; a tap on plain text is none (X1).
import { chromium, devices, type Page } from "playwright-core";

const base = process.argv[2];
const part = process.argv[3] ?? "main";
const H = { "X-Isomux-Member-Id": "m0000000" };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const view = async () => (await (await fetch(base + "/api/view", { headers: H })).json()) as any;
const bySubject = async (s: string) => (await view()).cards.find((c: any) => c.subject === s);
const decided = async () => (await view()).cards.filter((x: any) => x.decision).length;
const post = (path: string, body?: unknown) => fetch(base + path, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const hasBasis = (k: any) => k.kind === "decision" && k.prediction && !(k.prediction.standin && k.prediction.standin.basis === "none");
let fails = 0;
// Round q1 (H1 put the chat between the Premove and Your call): the card's
// own Confirm is hidden while the call bar shows (Round 11), so a click on it
// first brings it into view, and the bar goes.
// Nil, 2026-10-29: the packet comes before the Premove, so a reader passes the Premove on the
// way to Your call; the check shows it first, as Confirm waits until it was seen.
async function clickConfirm(pg: Page, scope: string): Promise<void> {
  await pg.evaluate((sc) => document.querySelector(sc)?.closest("[data-card]")?.querySelector(".zone.premove")?.scrollIntoView({ block: "center" }), scope);
  await pg.waitForTimeout(400);
  const b = pg.locator(`${scope} .actions [data-confirm]`).first();
  await b.evaluate((e: HTMLElement) => e.scrollIntoView({ block: "center" }));
  await pg.waitForTimeout(400);
  await b.click();
}

const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
};
async function desk(height = 1000) {
  const c = await browser.newContext({ viewport: { width: 1400, height }, extraHTTPHeaders: H });
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  return { c, p };
}
// Touch with no mobile flag (pointer: fine), as the reviewer's Z2 runs.
async function touch(mobile = false) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: mobile, extraHTTPHeaders: H });
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  return { c, p };
}
async function load(p: any, wait = 1800) {
  await p.goto(base + "/");
  await p.waitForSelector("[data-card]");
  await p.waitForTimeout(wait);
}
const open = async (p: any, subject: string, tap = false) => {
  const id = (await bySubject(subject)).id;
  if (await p.$(`[data-card="${id}"]`)) return id;
  if (tap) await p.tap(`.row[data-cur="${id}"]`);
  else await p.click(`.row[data-cur="${id}"]`);
  await p.waitForTimeout(900);
  return id;
};
const noBasisShown = async (p: any) => /No basis/.test((await p.$eval("[data-card] .pcall", (e: any) => e.textContent).catch(() => "")) || "");
// Steps past the action card and a card with no basis.
async function toDecision(p: any, tap: boolean) {
  while ((await p.$("[data-card] [data-done]")) || (await noBasisShown(p))) {
    if (tap) await p.tap("[data-card] [data-step='1']");
    else await p.click("[data-card] [data-step='1']");
    await p.waitForTimeout(1700);
  }
}
const barState = (p: any) => p.$eval("[data-sticky]", (e: any) => e.hidden + " " + e.dataset.state).catch(() => "none");
const barHint = (p: any) => p.$eval("[data-sticky] .sbhint", (e: any) => e.textContent).catch(() => "");
// The phone's bottom bar shows while the card's Confirm row is off the screen: the Premove at the top.
async function premoveTop(p: any) {
  await p.$eval("[data-card] .premove", (e: any) => e.scrollIntoView({ block: "start" }));
  await p.waitForTimeout(300);
}

if (part === "main") {
  // Z24: Ctrl+Enter 300 ms after the load does nothing.
  {
    const { c, p } = await desk();
    const n0 = await decided();
    await p.goto(base + "/", { waitUntil: "load" });
    await p.waitForTimeout(300);
    await p.keyboard.press("Control+Enter");
    await p.waitForTimeout(600);
    check("Z24 Ctrl+Enter 300 ms after load decides nothing", (await decided()) === n0);
    await c.close();
  }
  // Z1, Z4, Z9, Z3, Z16.
  {
    const { c, p } = await desk();
    await load(p, 1000);
    const id = await open(p, "demo-1");
    const z = `[data-card="${id}"] .yourcall`;
    // Round Q1, C2: the list of changes is gone; a change shows as "Back to the Premove" at the heading.
    const reset = () => p.$(`${z} [data-reset]:not([disabled])`).then((e: unknown) => !!e);
    await p.fill(`${z} [data-text=title]`, "Renamed");
    check("Z4 a typed title shows at once (Back to the Premove)", await reset());
    await p.fill(`${z} [data-text=title]`, "");
    check("Z4 a cleared title is no change", !(await reset()));
    await p.fill(`${z} [data-note]`, "go big");
    check("Z4 a note shows as a change", await reset());
    await p.click(`${z} [data-field=priority][data-v='"P0"']`);
    await p.fill(`${z} [data-text=title]`, "Renamed");
    await p.click(`${z} [data-reset]`);
    await p.waitForTimeout(200);
    await p.click("h1");
    await p.keyboard.press("a");
    await p.waitForTimeout(200);
    await clickConfirm(p, z);
    await p.waitForTimeout(1200);
    const d = (await bySubject("demo-1")).decision;
    check("Z1 Back, Back, Confirm sends the Premove", d && d.call.choice === "go" && d.call.priority === "P1" && !d.call.title && !d.call.note, JSON.stringify(d && d.call));
    await p.click("[data-toast-undo]");
    await p.waitForTimeout(1000);
    await open(p, "demo-1");
    await p.click(`${z} [data-field=choice][data-v='"backlog"']`, { delay: 0 });
    await p.click(`${z} [data-field=priority][data-v='"P3"']`, { delay: 0 });
    const on = await p.$$eval(`${z} .chip.on`, (es) => es.map((e) => e.textContent).join(","));
    check("Z9 a quick second tap counts", on === "backlog,P3", on);
    // The taps above add a line under the chips; the stray-press guard drops a press right after the page moves.
    await p.waitForTimeout(800);
    await p.click(`${z} [data-field=choice][data-v='"go"']`);
    await p.click(`${z} [data-field=priority][data-v='"P0"']`);
    await p.fill(`${z} [data-note]`, "ship it today");
    await p.waitForTimeout(800);
    await clickConfirm(p, z);
    await p.waitForTimeout(1200);
    await c.close();
    const b = await desk();
    await b.p.goto(base + "/#decided");
    await b.p.waitForSelector(`[data-undo="${id}"]`);
    await b.p.waitForTimeout(800);
    await b.p.click(`[data-undo="${id}"]`);
    await b.p.waitForTimeout(1200);
    await b.p.click("[data-tab=queue]");
    await b.p.waitForTimeout(600);
    const cur = await b.p.$eval("[data-card]", (e) => (e as HTMLElement).dataset.card);
    const chips = await b.p.$$eval(`[data-card="${id}"] .yourcall .chip.on`, (es) => es.map((e) => e.textContent).join(","));
    const note = await b.p.$eval(`[data-card="${id}"] [data-note]`, (e) => (e as HTMLTextAreaElement).value);
    check("Z3 Undo in another browser brings back the call", chips === "go,P0" && note === "ship it today", chips + " / " + note);
    check("Z16 the undone card is the current card", cur === id);
    await b.c.close();
  }
  // V4 on a phone: the warning for unticked steps does not scroll the page or move Done.
  {
    const c = await browser.newContext({ ...devices["Pixel 7"], extraHTTPHeaders: H });
    const p = await c.newPage();
    await load(p);
    const a = (await view()).cards.find((k: any) => k.kind === "action" && k.state === "open" && !k.held);
    const id = await open(p, a.subject, true);
    await p.$eval(`[data-card="${id}"] .yourcall [data-done]`, (e) => e.scrollIntoView({ block: "center" }));
    await p.waitForTimeout(1700);
    await p.tap(`[data-card="${id}"] [data-note]`);
    const y0 = await p.evaluate(() => window.scrollY);
    const b0 = (await (await p.$(`[data-card="${id}"] .yourcall [data-done]`))!.boundingBox())!;
    await p.tap(`[data-card="${id}"] .yourcall [data-done]`);
    await p.waitForTimeout(500);
    const y1 = await p.evaluate(() => window.scrollY);
    const b1 = (await (await p.$(`[data-card="${id}"] .yourcall [data-done]`))!.boundingBox())!;
    const warned = !!(await p.$(`[data-card="${id}"] .yourcall [data-armwarn]:not([hidden])`));
    check("V4 phone: the warning shows, with no scroll and Done in place", warned && y0 === y1 && Math.abs(b0.y - b1.y) < 1, "scroll " + y0 + " -> " + y1 + ", Done y " + b0.y + " -> " + b1.y);
    await c.close();
  }
  // V2: an action is never finished by Ctrl+Enter; d warns; the second press passes only on the card's Done, after 1 s. Round 9: the words name Done. Z6: one tap on Done after typing.
  {
    const { c, p } = await desk();
    await load(p, 1000);
    const a = (await view()).cards.find((k: any) => k.kind === "action" && k.state === "open" && !k.held);
    const id = await open(p, a.subject);
    const held = async () => !!(await view()).cards.find((k: any) => k.id === id).held;
    const hint0 = await p.$eval(`[data-card="${id}"] [data-cfhint]`, (e) => e.textContent);
    check("Round 9, 4: the action card's lock line names Done", /Done/.test(hint0!) && !/[Cc]onfirm/.test(hint0!), hint0!);
    await p.click(`[data-card="${id}"] [data-note]`);
    await p.waitForTimeout(800);
    await p.click("h1");
    await p.keyboard.press("Control+Enter");
    await p.waitForTimeout(500);
    check("V2 Ctrl+Enter never finishes an action", !(await held()));
    const b0 = (await (await p.$(`[data-card="${id}"] .yourcall [data-done]`))!.boundingBox())!;
    await p.keyboard.press("d");
    await p.waitForTimeout(300);
    const warn = await p.$eval(`[data-card="${id}"] [data-armwarn]`, (e) => ((e as HTMLElement).hidden ? "" : e.textContent));
    const b1 = (await (await p.$(`[data-card="${id}"] .yourcall [data-done]`))!.boundingBox())!;
    check("V4 the warning does not move Done", Math.abs(b0.y - b1.y) < 1, b0.y + " -> " + b1.y);
    check("Round 9, 4: the step warning says press, not tap", /press Done again/.test(warn!) && !/\btap\b/.test(warn!), warn!);
    await p.keyboard.press("d");
    await p.waitForTimeout(300);
    check("V2 a second d does not pass unticked steps", !(await held()));
    await p.click(`[data-card="${id}"] .yourcall [data-done]`);
    await p.waitForTimeout(300);
    check("V2 the card's Done does not pass them within 1 s of the warning", !(await held()));
    await p.waitForTimeout(1100);
    await p.click(`[data-card="${id}"] .yourcall [data-done]`);
    await p.waitForTimeout(800);
    check("V2 the card's Done after 1 s passes them", await held());
    // Z5: the held action's toast comes back after a reload, and stays on another tab.
    await p.reload();
    await p.waitForSelector("[data-card], .empty");
    await p.waitForTimeout(800);
    const t = await p.$eval("#toast", (e) => ((e as HTMLElement).hidden ? "" : e.textContent));
    check("Z5 the held action's toast comes back after a reload", /Undo \(\d+ s\)/.test(t!), t!);
    await p.click("[data-tab=decided]");
    await p.waitForTimeout(300);
    check("Z5 the toast stays on another tab", !(await p.$eval("#toast", (e) => (e as HTMLElement).hidden)));
    await p.click("[data-toast-undo]");
    await p.waitForTimeout(1000);
    await p.click("[data-tab=queue]");
    await p.waitForTimeout(600);
    // Z6: type a note, tick every step, then one click on Done sends it.
    await open(p, a.subject);
    await p.waitForTimeout(800);
    await p.fill(`[data-card="${id}"] [data-note]`, "approved");
    for (const box of await p.$$(`[data-card="${id}"] [data-tick]`)) if (!(await box.isChecked())) await box.click();
    await p.click(`[data-card="${id}"] .yourcall [data-done]`);
    await p.waitForTimeout(800);
    check("Z6 one tap on Done after typing", await held());
    await post("/api/cards/" + id + "/undo");
    await c.close();
  }
  // V5: a card decided in another session: the notice shows before the next card.
  {
    const { c, p } = await desk();
    await load(p, 1000);
    await toDecision(p, false);
    const id = await p.$eval("[data-card]", (e) => (e as HTMLElement).dataset.card);
    const k = (await view()).cards.find((x: any) => x.id === id);
    await post("/api/cards/" + id + "/decide", { version: k.version, call: { ...(k.prediction ? k.prediction.call : { choice: "backlog", priority: null }), note: "" } });
    await p.waitForTimeout(4000);
    const notice = await p.$eval("[data-remote-ok]", (e) => e.closest(".remote")!.textContent).catch(() => "");
    const cardNow = await p.$("[data-card]");
    check("V5 a card decided elsewhere: a notice, and no next card yet", /Decided on another device/.test(notice!) && !cardNow, notice!);
    await p.click("[data-remote-ok]");
    await p.waitForTimeout(500);
    check("V5 Show the next card shows it", !!(await p.$("[data-card]")));
    await post("/api/cards/" + id + "/undo");
    await c.close();
  }
  // W2: Ctrl+Enter is under the act rule; W7: plain names; W6: the header keeps its height with the toast; W3: an Undo right after.
  {
    const { c, p } = await desk();
    await load(p, 1000);
    await toDecision(p, false);
    check("W7 the Confirm button's name is Confirm", (await p.getByRole("button", { name: "Confirm", exact: true }).count()) >= 1);
    const n0 = await decided();
    await p.click("h1");
    for (let i = 0; i < 4; i++) {
      await p.keyboard.press("Control+Enter");
      await p.waitForTimeout(1000);
    }
    const n1 = await decided();
    const hint = await p.$eval("[data-card] [data-cfhint]", (e) => e.textContent).catch(() => "");
    check("W2 Ctrl+Enter 4 times 1 s apart with no act decides nothing", n1 === n0, n0 + " -> " + n1 + ", hint: " + hint);
    const h0 = await p.$eval("header", (e) => e.getBoundingClientRect().height);
    // Nil, 2026-10-29: the packet comes before the Premove; it is shown first.
    await p.$eval("[data-card] .premove", (e) => e.scrollIntoView({ block: "center" }));
    await p.waitForTimeout(300);
    const box = (await (await p.$("[data-card] .premove"))!.boundingBox())!;
    await p.mouse.move(box.x + 10, box.y + 10);
    await p.mouse.wheel(0, 30);
    await p.waitForTimeout(400);
    await p.keyboard.press("Control+Enter");
    await p.waitForTimeout(1000);
    const n2 = await decided();
    check("W2 after a scroll on the card, Ctrl+Enter decides", n2 === n1 + 1, n1 + " -> " + n2);
    const h1 = await p.$eval("header", (e) => e.getBoundingClientRect().height);
    check("W6 the header keeps its height with the toast", h0 === h1, h0 + " -> " + h1);
    await p.click("[data-toast-undo]", { delay: 0 }).catch(() => {});
    await p.waitForTimeout(1200);
    check("W3 an Undo right after the call takes it back", (await decided()) === n1, n2 + " -> " + (await decided()));
    await c.close();
  }
  // W4: another device's call gives this page no Undo toast for it. W5, W8: a refused call reads the view at once, and the notice names the pick that was not sent.
  {
    const a = await desk();
    const b = await desk();
    await load(b.p, 1500);
    const x = (await view()).cards.find((k: any) => k.state === "open" && hasBasis(k));
    await load(a.p, 800);
    const other = (await view()).cards.find((k: any) => k.state === "open" && k.kind === "decision" && k.id !== x.id);
    await open(b.p, other.subject);
    await post("/api/cards/" + x.id + "/decide", { version: x.version, call: { ...x.prediction.call, note: "" } });
    await b.p.waitForTimeout(4000);
    const t = await b.p.$eval("#toast", (e) => ((e as HTMLElement).hidden ? "" : e.textContent));
    const xq = String(x.packet.question).replace(/^[A-Za-z ]{2,24}:\s+/, "").slice(0, 30);
    check("W4 another device's call gives no Undo toast here", !(/Undo/.test(t || "") && (t || "").includes(xq)), (t || "(none)") + " | card x: " + xq);
    await post("/api/cards/" + x.id + "/undo");
    // W5, W8: page a has card y open and changes a pick; y is decided elsewhere; a's Confirm is refused.
    const y = (await view()).cards.find((k: any) => k.state === "open" && hasBasis(k) && k.policy === "demo-reply") ?? (await view()).cards.find((k: any) => k.state === "open" && hasBasis(k));
    await a.p.goto(base + "/");
    await a.p.waitForSelector("[data-card]");
    await a.p.waitForTimeout(800);
    const yid = await open(a.p, y.subject);
    await a.p.waitForTimeout(800);
    // A locator finds the button again at the click: a redraw under load
    // detaches a handle (Antifeed Reviewer, 2026-10-26).
    await a.p.locator(`[data-card="${yid}"] .yourcall [data-field]:not(.on)`).first().click();
    await a.p.waitForTimeout(300);
    await post("/api/cards/" + yid + "/decide", { version: y.version, call: { ...y.prediction.call, note: "" } });
    await clickConfirm(a.p, `[data-card="${yid}"] .yourcall`);
    await a.p.waitForTimeout(1500);
    const notice = await a.p.$eval(".remote", (e) => e.textContent).catch(() => "");
    check("W5 after a refused call, the notice shows at once", /Decided on another device/.test(notice || ""), notice || "(none)");
    check("W8 the notice names the pick that was not sent", /Your pick here \(.+\) was not sent/.test(notice || ""), notice || "");
    await a.c.close();
    await b.c.close();
  }
  // V3: on the last card, a second click 400 ms after the call bar's Confirm is no Undo.
  {
    let v = await view();
    if (!v.cards.some((k: any) => k.state === "open" && !k.held && hasBasis(k))) {
      const d = v.cards.find((k: any) => k.decision && hasBasis(k));
      await post("/api/cards/" + d.id + "/undo");
      v = await view();
    }
    const left = v.cards.filter((k: any) => k.state === "open" && !k.held);
    const keep = left.find(hasBasis);
    for (const k of left) {
      if (k.id === keep.id) continue;
      if (k.kind === "action") await post("/api/cards/" + k.id + "/action", { ok: true });
      else {
        const nb = !hasBasis(k);
        const call = nb ? (k.policy === "demo-reply" ? { choice: "hold" } : { choice: "backlog", priority: null }) : k.prediction.call;
        await post("/api/cards/" + k.id + "/decide", { version: k.version, call: { ...call, note: "" } });
      }
    }
    // Round Q1, C1: the call bar shows once the whole of Your call is off the screen. Nil, 2026-10-29:
    // Your call is last on the card, so the check scrolls it to just under the screen.
    const { c, p } = await desk(600);
    await load(p, 1000);
    await p.mouse.move(700, 400);
    // The Premove on the screen first (half of it, or 40% of a 600 px window), then a scroll of Nil's.
    await p.$eval("[data-card] .zone.premove", (e) => e.scrollIntoView({ block: "center" }));
    await p.mouse.wheel(0, 40);
    await p.waitForTimeout(300);
    await p.evaluate(() => window.scrollBy(0, document.querySelector("[data-card] .yourcall")!.getBoundingClientRect().top - innerHeight - 10));
    await p.waitForTimeout(800);
    const bar = await p.$("[data-sticky]:not([hidden]) [data-confirm]:not([disabled])");
    if (bar) {
      const b = (await bar.boundingBox())!;
      await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      await p.waitForTimeout(400);
      await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      await p.waitForTimeout(1500);
      check("V3 a second click 400 ms after Confirm is no Undo", !!(await bySubject(keep.subject)).decision);
    } else check("V3 the call bar's Confirm is ready", false, (await p.$eval("[data-sticky]", (e) => (e as HTMLElement).dataset.state + " hidden=" + (e as HTMLElement).hidden).catch(() => "no bar")) + " why=" + (await p.evaluate("readyFor(cardById(cur))")));
    await c.close();
  }
}

if (part === "x1") {
  // X1: Confirm on card A, then a stray press on the same point 1 s later, then Ctrl+Enter (desktop) or the bar (phone):
  // the stray press is no act and changes no pick on card B, so B is not decided. X2: mouse travel starts again on each card.
  for (const phone of [false, true]) {
    const c = await browser.newContext(phone ? { ...devices["Pixel 7"], extraHTTPHeaders: H } : { viewport: { width: 1400, height: 900 }, extraHTTPHeaders: H });
    const p = await c.newPage();
    await load(p);
    await toDecision(p, phone);
    await p.$eval("[data-card] .premove", (e) => e.scrollIntoView({ block: "center" }));
    await p.waitForTimeout(500);
    const onChip = await p.$("[data-card] .yourcall .chip.on");
    if (phone) await onChip!.tap();
    else await onChip!.click();
    await p.$eval("[data-card] .yourcall [data-confirm]", (e) => e.scrollIntoView({ block: "center" }));
    await p.waitForTimeout(400);
    const btn = (await (await p.$("[data-card] .yourcall [data-confirm]"))!.boundingBox())!;
    const X = btn.x + btn.width / 2;
    const Y = btn.y + btn.height / 2;
    const n0 = await decided();
    if (phone) await p.touchscreen.tap(X, Y);
    else await p.mouse.click(X, Y);
    await p.waitForTimeout(500);
    const B = await p.$eval("[data-card]", (e) => (e as HTMLElement).dataset.card);
    const pk = () => p.$$eval(`[data-card="${B}"] .yourcall .chip.on, [data-card="${B}"] .yourcall .option.on`, (es) => es.map((e) => e.textContent).join(","));
    const picks0 = await pk();
    await p.waitForTimeout(500);
    if (phone) await p.touchscreen.tap(X, Y);
    else await p.mouse.click(X, Y);
    await p.waitForTimeout(500);
    const picks1 = await pk();
    const bar = await p.$("[data-sticky]:not([hidden]) [data-confirm]");
    if (phone && bar) {
      const bb = (await bar.boundingBox())!;
      await p.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    } else if (!phone) await p.keyboard.press("Control+Enter");
    await p.waitForTimeout(800);
    const n1 = await decided();
    check("X1 " + (phone ? "phone" : "desktop") + ": a stray press 1 s after Confirm is no act: one call only", n1 - n0 === 1, n0 + " -> " + n1 + (phone && !bar ? " (no bar on screen)" : ""));
    check("X1 " + (phone ? "phone" : "desktop") + ": the stray press changes no pick on the next card", picks0 === picks1, picks0 + " / " + picks1);
    if (!phone) {
      const box = (await (await p.$("[data-card] .premove"))!.boundingBox())!;
      await p.mouse.move(box.x + 20, box.y + 20);
      await p.mouse.move(box.x + 70, box.y + 20, { steps: 5 });
      await p.keyboard.press("j");
      await p.waitForTimeout(1000);
      await p.mouse.move(box.x + 20, box.y + 20, { steps: 5 });
      const why = await p.$eval("[data-card] [data-cfhint]", (e) => e.textContent).catch(() => "");
      check("X2 mouse travel starts again on a new card", /Read the (packet|steps)/.test(why || ""), why || "(no reason shown)");
    }
    await c.close();
  }
}

if (part === "touch") {
  // Z2: a double tap, then 3 taps 300 ms apart, on the bar's Confirm: 1 decision. Y1: re-taps at 0.8 s and 1.2 s. V1: no act, no call; a scroll, then a tap, decides.
  {
    const { c, p } = await touch();
    await load(p);
    await toDecision(p, true);
    await premoveTop(p);
    await p.waitForTimeout(1500);
    await p.tap("[data-card] .premove details > summary");
    await p.waitForTimeout(200);
    const state = await barState(p);
    const n0 = await decided();
    const box = (await (await p.$("[data-sticky] [data-confirm]"))!.boundingBox())!;
    const tap = () => p.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await tap();
    await p.waitForTimeout(100);
    await tap();
    for (let i = 0; i < 3; i++) {
      await p.waitForTimeout(300);
      await tap();
    }
    await p.waitForTimeout(800);
    const n1 = await decided();
    check("Z2 a double tap and 3 taps 300 ms apart give 1 decision", n1 - n0 === 1, "bar before: " + state + ", decisions " + n0 + " -> " + n1);
    await toDecision(p, true);
    await premoveTop(p);
    await p.waitForTimeout(1500);
    await p.tap("[data-card] .premove details > summary");
    await p.waitForTimeout(200);
    const box2 = (await (await p.$("[data-sticky] [data-confirm]"))!.boundingBox())!;
    const tap2 = () => p.touchscreen.tap(box2.x + box2.width / 2, box2.y + box2.height / 2);
    const m0 = await decided();
    const t0 = Date.now();
    await tap2();
    await p.waitForTimeout(800 - (Date.now() - t0));
    await tap2();
    await p.waitForTimeout(1200 - (Date.now() - t0));
    await tap2();
    await p.waitForTimeout(600);
    const m1 = await decided();
    check("Y1 re-taps at 0.8 s and 1.2 s give 1 decision", m1 - m0 === 1, m0 + " -> " + m1);
    const t1 = Date.now();
    await p.waitForTimeout(2000 - (Date.now() - t1));
    await tap2();
    await p.waitForTimeout(3000 - (Date.now() - t1));
    await tap2();
    await p.waitForTimeout(600);
    const v1 = await decided();
    check("V1 re-taps at 2 s and 3 s with no act on the new card decide nothing", v1 === m1, m1 + " -> " + v1 + ", hint: " + (await barHint(p)));
    const cdp = await c.newCDPSession(p);
    await cdp.send("Input.synthesizeScrollGesture", { x: 200, y: 500, yDistance: -120, gestureSourceType: "touch", speed: 600 });
    await p.waitForTimeout(400);
    await premoveTop(p);
    // The emulator does not always send touchmove for a synthesized swipe: a fold tap is the act then (N2).
    if ((await p.$eval("[data-sticky]", (e) => (e as HTMLElement).dataset.state).catch(() => "")) !== "ready") await p.tap("[data-card] .premove details > summary");
    await p.waitForTimeout(300);
    if (await noBasisShown(p)) await p.tap("[data-card] [data-safe]");
    await p.waitForTimeout(300);
    const st = await barState(p);
    const box3 = (await (await p.$("[data-sticky] [data-confirm]"))!.boundingBox())!;
    await p.touchscreen.tap(box3.x + box3.width / 2, box3.y + box3.height / 2);
    await p.waitForTimeout(800);
    check("V1 a scroll, then a tap, decides", (await decided()) === v1 + 1, v1 + " -> " + (await decided()) + ", bar before the tap: " + st + " (" + (await barHint(p)) + ")");
    await c.close();
  }
  // W1: a drag that starts on the call bar is no act; a tap after it decides nothing.
  {
    const { c, p } = await touch();
    await load(p);
    await toDecision(p, true);
    await premoveTop(p);
    await p.waitForTimeout(1500);
    await p.tap("[data-card] .premove details > summary");
    await p.waitForTimeout(300);
    const box = (await (await p.$("[data-sticky] [data-confirm]"))!.boundingBox())!;
    const n0 = await decided();
    await p.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await p.waitForTimeout(3000);
    await premoveTop(p);
    const cdp = await c.newCDPSession(p);
    const bar = (await (await p.$("[data-sticky]"))!.boundingBox())!;
    await cdp.send("Input.synthesizeScrollGesture", { x: bar.x + 30, y: bar.y + 10, yDistance: -20, gestureSourceType: "touch", speed: 400 });
    await p.waitForTimeout(500);
    const b2 = (await (await p.$("[data-sticky] [data-confirm]"))!.boundingBox())!;
    await p.touchscreen.tap(b2.x + b2.width / 2, b2.y + b2.height / 2);
    await p.waitForTimeout(800);
    check("W1 a drag that starts on the bar, then a tap: only the first call", (await decided()) - n0 === 1, n0 + " -> " + (await decided()));
    await c.close();
  }
  // N1: phone, a call from the bar, a scroll on the new card after its guard, then a tap on the bar 2.5 s after the call decides.
  {
    const { c, p } = await touch(true);
    await load(p);
    await toDecision(p, true);
    await premoveTop(p);
    await p.tap("[data-card] .premove details > summary");
    await p.waitForTimeout(400);
    const st0 = await barState(p);
    const n0 = await decided();
    const box = (await (await p.$("[data-sticky] [data-confirm]"))!.boundingBox())!;
    const t0 = Date.now();
    await p.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await p.waitForTimeout(400);
    const n1 = await decided();
    await premoveTop(p);
    await p.waitForTimeout(Math.max(0, 1700 - (Date.now() - t0)));
    const cdp = await c.newCDPSession(p);
    await cdp.send("Input.synthesizeScrollGesture", { x: 200, y: 300, yDistance: -60, gestureSourceType: "touch", speed: 800 });
    await p.waitForTimeout(200);
    if ((await p.$eval("[data-sticky]", (e) => (e as HTMLElement).dataset.state).catch(() => "")) !== "ready") await p.tap("[data-card] .premove details > summary");
    await p.waitForTimeout(Math.max(0, 2500 - (Date.now() - t0)));
    const st = await barState(p);
    const b2 = (await (await p.$("[data-sticky] [data-confirm]"))!.boundingBox())!;
    const at = Date.now() - t0;
    await p.touchscreen.tap(b2.x + b2.width / 2, b2.y + b2.height / 2);
    await p.waitForTimeout(800);
    const n2 = await decided();
    check("N1 a ready bar's Confirm, tapped " + at + " ms after the last call at the same place, decides", n1 === n0 + 1 && n2 === n1 + 1 && Math.hypot(b2.x - box.x, b2.y - box.y) < 32 && at < 3000, "bar " + st0 + " -> " + st + " (" + (await barHint(p)) + "), decisions " + n0 + " -> " + n1 + " -> " + n2);
    await c.close();
  }
}

await browser.close();
console.log(fails ? fails + " FAILED" : "ALL PASS");
