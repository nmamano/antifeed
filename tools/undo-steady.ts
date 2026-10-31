// Antifeed Reviewer's check (slice 7 walk round 3, item 1): after a mouse Confirm on desktop,
// the toast's Undo box stays put from 0 to 2 s while the pointer moves to it, and a click
// at 2 s at the place it had at 0 ms is an Undo (the card comes back, nothing is sent).
// Each run prints the next card and the bar hint at 100 ms. The PM's case (shift asks) is judged by its condition,
// not the hint's text: the next card is another shift ask whose Confirm is still locked at 100 ms (PM, 2026-10-26).
// Usage, on a fresh walkthrough copy: bun tools/undo-steady.ts http://localhost:21199   (no trailing slash).
// A failed run leaves its screenshot in /tmp/af-undo-steady/.
import { chromium } from "playwright-core";
const U = process.argv[2];
const H = { "X-Isomux-Member-Id": "m0000000" };
const view = async () => (await (await fetch(U + "/api/view", { headers: H })).json()) as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60 && (await view()).cards.some((k: any) => k.state === "predicting"); i++) await sleep(500);
// The PM's case (2026-10-26): the next card is an ask with a reply call, its Confirm still locked,
// so the call bar shows "Confirm is ready in a moment." beside the call and wraps.
const office = async (path: string, body?: unknown) => (await (await fetch(U + "/fake-office/control/" + path, body === undefined ? {} : { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()) as any;
for (let i = 1; i <= 6; i++) await office("ask", { agentId: "agent-demo-worker", prompt: `Ship the new sign-in footer, shift s${i}: now or flag?`, options: ["Ship it to everyone now", "Behind a flag first"], recommended: "Behind a flag first" });
for (let i = 0; i < 60; i++) { const v = await view(); if (v.cards.filter((k: any) => k.policy === "ask" && /shift s\d/.test(k.packet?.question ?? "") && k.state === "open").length >= 6) break; await sleep(1000); }
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
let fail = 0;
const check = (name: string, ok: boolean, info = "") => { if (!ok) fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${info ? " | " + info : ""}`); };
for (const which of ["first ask", "PM's shift ask"])
for (const vp of [{ width: 1400, height: 1000 }, { width: 1280, height: 720 }])
  for (const where of ["bar", "card", "bar, long words"])
    for (const path of ["straight", "from below"]) {
      const dark = path === "from below";
      const ctx = await b.newContext({ viewport: vp, colorScheme: dark ? "dark" : "light", extraHTTPHeaders: H });
      const p = await ctx.newPage();
      p.on("pageerror", (e) => console.log("PAGEERROR", e.message));
      await p.goto(U + "/");
      await p.waitForSelector("[data-card]");
      await p.waitForTimeout(1000);
      const c = (await view()).cards.find((k: any) => k.project === "inbox" && k.policy === "ask" && k.state === "open" && (which === "first ask" || /shift s\d/.test(k.packet?.question ?? "")));
      if (!c) { console.log("no open ask left"); break; }
      if (!(await p.$(`[data-card="${c.id}"]`))) { await p.click(`.row[data-cur="${c.id}"]`); await p.waitForSelector(`[data-card="${c.id}"]`); }
      await p.evaluate(() => scrollTo(0, 0));
      await p.waitForTimeout(1200);
      // The act: a wheel inside the card.
      await p.mouse.move(vp.width / 2, vp.height / 2);
      await p.mouse.wheel(0, 120); await p.waitForTimeout(300); await p.mouse.wheel(0, -120); await p.waitForTimeout(900);
      if (where === "bar, long words") {
        const ta = p.locator(`[data-callzone="${c.id}"] textarea`).first();
        await ta.evaluate((e) => e.scrollIntoView({ block: "center" })); await p.waitForTimeout(400);
        await ta.click(); await ta.fill("Behind a flag first, and then watch the error rate and the sign-in count for a full day before it goes to every member of the office");
        await p.mouse.move(vp.width / 2, vp.height / 2); await p.mouse.wheel(0, -3000); await p.waitForTimeout(900);
      }
      // Round Q1, C1 (Antifeed PM, 2026-10-29): on a desktop the bar shows only when none of Your call
      // is on the screen, so the bar cases scroll Your call away above the header.
      if (where.startsWith("bar")) {
        await p.evaluate((id) => { const z = document.querySelector(`[data-card="${id}"] .yourcall`)!.getBoundingClientRect(); scrollBy(0, z.bottom - document.querySelector("header")!.getBoundingClientRect().bottom + 40); }, c.id);
        await p.waitForTimeout(900);
      }
      const sel = where.startsWith("bar") ? `[data-sticky="${c.id}"] [data-confirm]` : `[data-callzone="${c.id}"] .actions [data-confirm]`;
      if (where === "card") { await p.locator(sel).first().evaluate((e) => e.scrollIntoView({ block: "center" })); await p.waitForTimeout(700); }
      const cb = await p.locator(sel).first().boundingBox();
      if (!cb) { check(`${which}, ${vp.width}x${vp.height} ${where} Confirm, ${dark ? "dark" : "light"}, pointer ${path}: Confirm in view`, false); await ctx.close(); continue; }
      await p.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2, { steps: 5 });
      await p.waitForTimeout(200);
      await p.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
      const t0 = Date.now();
      const nextAt100 = p.waitForTimeout(100).then(() => p.evaluate(() => ({ card: (document.querySelector("[data-card]") as HTMLElement | null)?.dataset.card, hint: document.querySelector("[data-sticky]:not([hidden]) .sbhint")?.textContent ?? "(no bar)", locked: (() => { const id = (document.querySelector("[data-card]") as HTMLElement | null)?.dataset.card; const bar = document.querySelector(`[data-sticky="${id}"]`) as HTMLElement | null; const own = document.querySelector(`[data-callzone="${id}"] .actions [data-confirm]`) as HTMLButtonElement | null; return (bar ? bar.dataset.state === "locked" : true) && (own ? own.classList.contains("locked") || own.disabled : true) && !!(bar || own); })() })));
      const box = () => p.evaluate(() => { const e = document.querySelector("#toast [data-toast-undo]") as HTMLElement | null; const t = document.querySelector("#toast") as HTMLElement | null; if (!e || !t || t.hidden) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      let b0 = await box();
      for (let i = 0; !b0 && i < 20; i++) { await p.waitForTimeout(20); b0 = await box(); }
      if (!b0) { await p.screenshot({ path: `/tmp/af-undo-steady/notoast-${vp.width}-${where.replace(/\W+/g, "-")}.png` }); console.log("hint:", await p.evaluate(() => document.querySelector("[data-sticky]")?.textContent?.slice(0, 200))); check(`${which}, ${vp.width}x${vp.height} ${where} Confirm, ${dark ? "dark" : "light"}, pointer ${path}: a toast with Undo`, false); await ctx.close(); continue; }
      const tx = b0.x + b0.w / 2, ty = b0.y + b0.h / 2;
      let worst = 0, worstAt = 0, worstBox = b0;
      const sample = async () => { const bx = await box(); const d = bx ? Math.max(Math.abs(bx.x - b0!.x), Math.abs(bx.y - b0!.y), Math.abs(bx.w - b0!.w), Math.abs(bx.h - b0!.h)) : 9999; if (d > worst) { worst = d; worstAt = Date.now() - t0; worstBox = bx ?? worstBox; } };
      // The pointer goes from Confirm to the place Undo had at 0 ms, as a hand does (about 700 ms).
      const from = path === "straight" ? { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 } : { x: tx - 60, y: ty + 200 };
      if (path === "from below") await p.mouse.move(from.x, from.y, { steps: 3 });
      for (let i = 1; i <= 14; i++) { await p.mouse.move(from.x + ((tx - from.x) * i) / 14, from.y + ((ty - from.y) * i) / 14); await sample(); await p.waitForTimeout(40); }
      while (Date.now() - t0 < 2000) { await sample(); await p.waitForTimeout(50); }
      const hit = await p.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest("[data-toast-undo]"), [tx, ty]);
      await p.mouse.click(tx, ty);
      await p.waitForTimeout(800);
      const n100 = await nextAt100;
      const nextCard = (await view()).cards.find((k: any) => k.id === n100.card);
      console.log(`  at 100 ms: next card ${nextCard?.policy ?? "?"} "${(nextCard?.packet?.question ?? "").slice(0, 50)}", bar hint: ${n100.hint || "(none)"}`);
      if (which !== "first ask") check(`${which}, ${vp.width}x${vp.height} ${where} Confirm: the PM's case holds (the next card is another shift ask, its Confirm locked at 100 ms)`, n100.card !== c.id && /shift s\d/.test(nextCard?.packet?.question ?? "") && n100.locked, `next ${n100.card}, locked ${n100.locked}`);
      const after = (await view()).cards.find((k: any) => k.id === c.id);
      const sent = (after?.sends ?? []).filter((s: any) => s.state !== "cancelled");
      const name = `${which}, ${vp.width}x${vp.height} ${where} Confirm, ${dark ? "dark" : "light"}, pointer ${path}`;
      check(`${name}: the Undo box stays put 0-2 s after Confirm`, worst <= 1, `worst ${Math.round(worst)} px at ${worstAt} ms: ${JSON.stringify(b0, (k, v) => (typeof v === "number" ? Math.round(v) : v))} -> ${JSON.stringify(worstBox, (k, v) => (typeof v === "number" ? Math.round(v) : v))}`);
      check(`${name}: a click at its 0 ms place is an Undo`, hit && after?.state === "open" && sent.length === 0, `under the pointer at 2 s: ${hit ? "Undo" : "not Undo"}; card ${after?.state}; sends ${JSON.stringify(sent)}`);
      if (after?.state !== "open") await fetch(U + "/api/cards/" + c.id + "/undo", { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: "{}" });
      await ctx.close();
    }
await b.close();
console.log(fail ? `${fail} FAIL` : "ALL PASS");
process.exit(fail ? 1 : 0);
