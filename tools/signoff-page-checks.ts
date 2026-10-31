// Part J's page (item 6, Nil's sign-off rulings A to G): on an Antifeed
// walkthrough copy with ANTIFEED_LOOP_URL at a Loop app copy, every waiting
// item gets the Scout's packet (played here), and the page is checked at
// 1280 x 1000 and 390 x 844. Read only on the copies but the packets; never
// the live apps.
//   bun tools/signoff-page-checks.ts http://localhost:21199 http://localhost:21198 [shots dir]
import { chromium, devices } from "playwright-core";
const [af, loop, shots] = process.argv.slice(2);
if (!af || !loop || /:(21025|21042)\b/.test(af + loop)) throw new Error("give the two copies' bases, never the live apps");
const H = { "X-Isomux-Member-Id": "m0000000", "Content-Type": "application/json" };
let fails = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + n + (d ? " | " + d : ""));
};
const get = async (u: string) => (await fetch(u, { headers: H })).json() as Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waiting = ((await get(`${loop}/api/signoff`)).items as any[]).filter((i) => i.state === "waiting");
// The Scout, for every waiting item: stamp on the first, look or push back on the rest, with suggestions where it has copy or images.
for (let t = 0; t < 60; t++) {
  const st = await get(`${af}/api/status`);
  if ((st.inFlight as any[]).filter((x) => x.type === "signoff.prepare").length >= waiting.length) break;
  await sleep(1000);
}
const prepares = ((await get(`${af}/api/status`)).inFlight as any[]).filter((x) => x.type === "signoff.prepare");
for (const [n, k] of prepares.entries()) {
  const it = waiting.find((w) => w.taskId === k.subject);
  if (!it) continue;
  await fetch(`${af}/api/commands/${k.id}/start`, { method: "POST", headers: H });
  const verdict = n === 0 ? "stamp" : n % 3 === 1 ? "pushback" : "look";
  const pair = (k.params.images as any[]).filter((m) => m.pair);
  const shot = pair.length ? pair.filter((m) => m.pair === pair[0].pair).slice(0, 2) : (k.params.images as any[]).slice(0, 1);
  const suggestions = { copy: it.copy.length ? { "0": "Say it in fewer words: \"Asks first\"." } : {}, images: k.params.images.length ? { [String(k.params.images.length - 1)]: "Box the part that changed in red." } : {} };
  const packet = {
    question: "Sign-off item " + (n + 1) + ": " + (it.title.replace(/^\[[^\]]*\]\s*/, "").split(":")[0].replace(/[`/]/g, " ")).slice(0, 80),
    blocks: [{ type: "markdown", text: verdict === "stamp" ? "Copy only, as you asked." : "The new label is longer than the old one." }, ...shot.map((m) => ({ type: "image", blob: m.blob, caption: m.caption.slice(0, 120), ...(m.pair ? { pair: { name: m.pair, side: m.side } } : {}), focus: { x: 0.05, y: 0.05, w: 0.5, h: 0.3 } }))],
    options: [{ id: "pick", label: "Approve", fill: { call: "approve" } }],
    recommended: "pick",
  };
  const r = await fetch(`${af}/api/cards`, { method: "POST", headers: H, body: JSON.stringify({ command: k.id, packet, meta: { raw: "https://office.example.com/loop", commit: k.params.commit, scout: { verdict, confidence: 0.8, suggestions } } }) });
  if (r.status !== 201) console.log("INFO packet refused for " + k.subject + ": " + (await r.text()));
}
await sleep(1500);
const sign = ((await get(`${af}/api/cards?state=open&policy=signoff`)).cards as any[]);
console.log(`INFO ${sign.length} open sign-off cards`);
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
for (const [kind, o, height] of [["desk", { viewport: { width: 1280, height: 1000 } }, 1000], ["phone", { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }, 844]] as const) {
  const ctx = await browser.newContext({ ...o, extraHTTPHeaders: { "X-Isomux-Member-Id": "m0000000" } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await p.goto(af + "/");
  await p.waitForSelector("[data-card]");
  await p.waitForTimeout(800);
  if (await p.$("[data-remote-ok]")) await p.click("[data-remote-ok]");
  // Every sign-off card made current in turn, from the top of the page.
  const rows: any[] = [];
  for (const c of sign) {
    await p.evaluate((id: string) => { (window as any).setCur(id); (window as any).redraw(); window.scrollTo(0, 0); }, c.id);
    await p.waitForTimeout(500);
    rows.push(await p.$eval("[data-card]", (card: Element) => {
      const kids = [...card.children];
      const call = kids.findIndex((x) => x.matches(".loopcall"));
      const imgs = [...card.querySelectorAll(".lshot .crop, .lshot .thumb > img")].map((x) => Math.round(x.getBoundingClientRect().height));
      const cr = card.getBoundingClientRect();
      const inside = [...card.querySelectorAll(".lshot .thumb")].every((x) => x.getBoundingClientRect().right <= cr.right + 1);
      return {
        id: (card as HTMLElement).dataset.card, so: card.classList.contains("so"), above: kids.slice(0, call).map((x) => x.className),
        confirm: Math.round(card.querySelector("[data-confirm]")!.getBoundingClientRect().bottom), imgs, inside,
        chips: [...card.querySelectorAll("[data-frow=call] .chip")].map((b) => b.textContent + (b.classList.contains("on") ? "*" : "") + (b.classList.contains("pm") ? "." : "")),
        copyOpen: !!card.querySelector('details[data-dkey^="socopy:"][open]'), copyFold: !!card.querySelector('details[data-dkey^="socopy:"]'),
        reason: (card.querySelector(".lreason") as HTMLElement | null)?.innerText ?? null, sug: (card.querySelector(".sosugline") as HTMLElement | null)?.innerText ?? null,
      };
    }));
  }
  const low = rows.reduce((a, b) => (b.confirm > a.confirm ? b : a));
  console.log(`INFO ${kind}: ${rows.length} cards, lowest Confirm bottom ${low.confirm} px (${low.id}); image heights ${JSON.stringify(rows.map((r) => r.imgs))}`);
  check(`${kind}: every sign-off card is the sign-off kind with Approve and Revert, the Scout's pick on and marked`, rows.every((r) => r.so && r.chips.length === 2 && r.chips[0] === "Approve*." && r.chips[1] === "Revert"), JSON.stringify(rows[0]?.chips));
  check(`${kind}: above the chips only the head, the title, the reason (not stamp), the suggestions line and the image`, rows.every((r) => r.above.every((x: string) => /lhead|question|lreason|sosugline|lshot/.test(x))), JSON.stringify(rows.map((r) => r.above)));
  check(`${kind}: images at most ${kind === "desk" ? 260 : 120} px tall, inside the card`, rows.every((r) => r.inside && r.imgs.every((h: number) => h <= (kind === "desk" ? 261 : 121))));
  const stamp = rows.find((r) => r.reason === null);
  check(`${kind}: the reason shows when the verdict is not stamp, and not on a stamp`, !!stamp && rows.filter((r) => r !== stamp).every((r) => !!r.reason));
  check(`${kind}: the Copy changes fold starts open when the verdict is not stamp, closed with stamp`, rows.every((r) => !r.copyFold || r.copyOpen === (r !== stamp)), JSON.stringify(rows.map((r) => [r.copyFold, r.copyOpen])));
  check(`${kind}: "n suggested comments" shows above the chips when there are any`, rows.filter((r) => r.sug).length > 0 && rows.filter((r) => r.sug).every((r) => /^\d+ suggested comments?$/.test(r.sug)), JSON.stringify(rows.map((r) => r.sug)));
  if (kind === "desk") check("desk: Confirm in the 1280 x 1000 window with no scroll on every card", low.confirm <= height, `${low.confirm} px`);
  else console.log(`INFO phone: lowest Confirm bottom ${low.confirm} px of 844${low.confirm > 844 ? " (a scroll of " + (low.confirm - 844) + " px)" : ""}`);
  if (kind === "desk") {
    // Keys: a and r; a Revert with no note does not go; the Use button fills a comment; a reload keeps it.
    const withCopy = sign.find((c) => rows.find((r) => r.id === c.id)?.copyFold && rows.find((r) => r.id === c.id)?.sug) ?? sign[1];
    await p.evaluate((id: string) => { (window as any).setCur(id); (window as any).redraw(); window.scrollTo(0, 0); }, withCopy.id);
    await p.waitForTimeout(1700);
    await p.click("h1").catch(() => {});
    await p.keyboard.press("r");
    await p.waitForTimeout(200);
    const yours = await p.$eval("[data-card] [data-yours]", (e) => e.textContent);
    check("desk: r picks Revert; the head line says it", yours === "Revert", String(yours));
    await p.click("h1").catch(() => {});
    await p.keyboard.press("Control+Enter");
    await p.waitForTimeout(400);
    const err = await p.$eval("[data-card] .loopcall", (e) => (e as HTMLElement).innerText);
    check("desk: a Revert with no note does not go", /Revert needs a note/.test(err), err.split("\n").find((l) => /note/i.test(l)) ?? "");
    await p.click("h1").catch(() => {});
    await p.keyboard.press("a");
    await p.waitForTimeout(200);
    check("desk: a picks Approve", (await p.$eval("[data-card] [data-yours]", (e) => e.textContent)) === "Approve");
    const use = await p.$("[data-card] [data-souse]");
    if (use) {
      await p.evaluate(() => { for (const d of document.querySelectorAll("[data-card] details")) (d as HTMLDetailsElement).open = true; });
      await p.click("[data-card] [data-souse]");
      await p.waitForTimeout(300);
      const key = await use.getAttribute("data-souse");
      const v = await p.$eval(`[data-card] [data-socomment="${key}"]`, (e) => (e as HTMLTextAreaElement).value);
      const sugText = await p.$eval("[data-card] .sosugtext", (e) => (e as HTMLElement).innerText);
      check("desk: Use fills the comment field with the suggestion, which is selectable text", v === sugText && (await p.$eval("[data-card] .sosugtext", (e) => getComputedStyle(e).userSelect)) !== "none", JSON.stringify({ key, v, sugText }));
      await p.fill(`[data-card] [data-socomment="${key}"]`, "My own comment");
      await p.fill("[data-card] [data-note]", "A note that must survive");
      await p.waitForTimeout(600);
      await p.reload();
      await p.waitForSelector("[data-card]");
      await p.waitForTimeout(800);
      await p.evaluate((id: string) => { (window as any).setCur(id); (window as any).redraw(); }, withCopy.id);
      await p.waitForTimeout(400);
      await p.evaluate(() => { for (const d of document.querySelectorAll("[data-card] details")) (d as HTMLDetailsElement).open = true; });
      await p.waitForTimeout(200);
      const after = { c: await p.$eval(`[data-card] [data-socomment="${key}"]`, (e) => (e as HTMLTextAreaElement).value), n: await p.$eval("[data-card] [data-note]", (e) => (e as HTMLTextAreaElement).value) };
      check("desk: the comment and the note survive a reload in the same tab", after.c === "My own comment" && after.n === "A note that must survive", JSON.stringify(after));
      // Copy changes: member entries first, then agent entries dimmed; old and new as a word diff.
      const entries = await p.$$eval("[data-card] .soentry", (es) => es.map((e) => ({ agent: e.classList.contains("agent"), opacity: getComputedStyle(e).opacity, marks: e.querySelectorAll("ins, del").length })));
      const firstAgent = entries.findIndex((e) => e.agent);
      check("desk: copy entries for members first, agent entries after and dimmed; a word diff", entries.length > 0 && (firstAgent < 0 || entries.slice(firstAgent).every((e) => e.agent && Number(e.opacity) < 1)) && entries.some((e) => e.marks > 0), JSON.stringify(entries.slice(0, 4)));
    }
    if (shots) await p.screenshot({ path: shots + "/desk.png", fullPage: false });
    // j and k move.
    const a = await p.$eval("[data-card]", (e) => (e as HTMLElement).dataset.card);
    await p.click("h1").catch(() => {});
    await p.keyboard.press("j");
    await p.waitForTimeout(300);
    check("desk: j moves to the next card", (await p.$eval("[data-card]", (e) => (e as HTMLElement).dataset.card)) !== a);
  } else if (shots) {
    await p.evaluate((id: string) => { (window as any).setCur(id); (window as any).redraw(); window.scrollTo(0, 0); }, low.id);
    await p.waitForTimeout(500);
    await p.screenshot({ path: shots + "/phone.png", fullPage: true });
  }
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
