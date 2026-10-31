// Antifeed Reviewer's probe (round 11, V3): after the card's own Confirm, a second tap on the same point must not hit the toast's Undo.
// Usage, on a fresh walkthrough copy: node tools/toast-retap.cjs http://localhost:21199/   (the URL ends with a slash)
const { chromium } = require('playwright-core');
const U = process.argv[2];
const H = { 'X-Isomux-Member-Id': 'm0000000' };
const decided = async () => (await (await fetch(U + 'api/view', { headers: H })).json()).cards.filter((c) => c.decision && String(c.decision.by).startsWith('human:')).length;
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  let fail = 0;
  for (const mobile of [true, false]) for (const target of [560, 620, 680, 720]) for (const gap of [400, 1000]) {
    const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: mobile, hasTouch: true, extraHTTPHeaders: H });
    const p = await c.newPage();
    await p.goto(U); await p.waitForSelector('[data-card], .empty', { timeout: 20000 }); await p.waitForTimeout(800);
    const row = p.locator('text=/Premove: /').first();
    if (!(await row.count())) { console.log('no decision card left'); break; }
    await row.tap();
    // Waits for the card and then for its Confirm to unlock, not fixed times, so a
    // loaded box does not stop the run (Antifeed PM, 2026-10-26). On a phone the
    // card's Confirm is hidden while the call bar is up: it is waited for as attached.
    await p.locator('article.card[data-card] .actions [data-confirm]').first().waitFor({ state: 'attached', timeout: 20000 });
    // The page's guard time after a card opens (fresh(), in the page's script), with the Premove on screen.
    await p.waitForFunction(() => !fresh(), null, { timeout: 20000 });
    await p.waitForTimeout(300);
    // The act: focus the note, then leave it.
    await p.locator('article.card[data-card] textarea').first().tap(); await p.waitForTimeout(300);
    await p.evaluate(() => document.activeElement.blur());
    // Put the card's Confirm at y = target.
    const btn = p.locator('article.card[data-card] .actions [data-confirm]').first();
    await p.evaluate(([t]) => { const e = document.querySelector('article.card[data-card] .actions [data-confirm]'); const r = e.getBoundingClientRect(); scrollBy(0, r.top + r.height / 2 - t); }, [target]);
    await p.waitForTimeout(700);
    await p.locator('article.card[data-card] .actions [data-confirm]:not(.locked)').first().waitFor({ state: 'attached', timeout: 20000 });
    const bb = await btn.boundingBox();
    const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
    const n0 = await decided();
    await p.touchscreen.tap(x, y);
    await p.waitForTimeout(gap);
    const tb = await p.locator('#toast [data-toast-undo]').boundingBox().catch(() => null);
    const hit = await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? (e.closest('#toast') ? 'TOAST' : e.tagName + '.' + (e.className || '')) : 'none'; }, [x, y]);
    await p.touchscreen.tap(x, y);
    await p.waitForTimeout(800);
    const n1 = await decided();
    const ok = n1 === n0 + 1;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'} mobile=${mobile} confirm y=${Math.round(y)} retap +${gap}ms: decided ${n0} -> ${n1}; under the retap: ${hit}; toast Undo box x ${tb ? Math.round(tb.x) + "-" + Math.round(tb.x + tb.width) : ""} confirm x ${Math.round(bb.x)}-${Math.round(bb.x + bb.width)} y ${tb ? Math.round(tb.y) + '-' + Math.round(tb.y + tb.height) : 'none'}`);
    // Undo it again for the next run, through the Decided list if it stands.
    if (n1 > n0) { const id = (await (await fetch(U + 'api/view', { headers: H })).json()).cards.filter((c) => c.decision && String(c.decision.by).startsWith('human:')).sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || ''))[0]?.id; if (id) await fetch(U + 'api/cards/' + id + '/undo', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' }); }
    await c.close();
  }
  console.log(fail ? fail + ' FAILED' : 'ALL PASS');
  await b.close();
})();
