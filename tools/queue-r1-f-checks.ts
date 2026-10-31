// Queue round 1, package F (Nil's feedback, 2026-10-28, /tmp/af-queue-r1/SPEC.md):
// the filters and sorts of the Queue tab. Run on a fresh walkthrough copy:
//   PORT=21061 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/queue-r1-f-checks.ts http://localhost:21061 [shots dir]
import { chromium, type Page } from "playwright-core";

const base = process.argv[2];
const shots = process.argv[3];
const H = { "X-Isomux-Member-Id": "m0000000" };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const view = async () => (await (await fetch(base + "/api/view", { headers: H })).json()) as any;
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
};
for (let i = 0; i < 60 && (await view()).cards.some((k: any) => k.state === "predicting" || k.state === "preparing"); i++) await new Promise((r) => setTimeout(r, 500));

const ev = (p: Page, js: string) => p.evaluate((s) => (window as any).eval(s), js);
// The facts of the shown list, as the page has them, and whether the rows show it in that order.
const facts = (p: Page) =>
  p.evaluate(() => {
    const w = window as any;
    const { list, total } = w.eval("queueLists()");
    const rest = [...document.querySelectorAll("[data-cur]")].map((e) => (e as HTMLElement).dataset.cur);
    const cur = (document.querySelector("[data-card]") as HTMLElement | null)?.dataset.card;
    const nA = list.filter((c: any) => c.kind === "action").length;
    return {
      total,
      domOk: JSON.stringify(list.map((c: any) => c.id).filter((x: string) => x !== cur)) === JSON.stringify(rest),
      actionsFirst: list.slice(0, nA).every((c: any) => c.kind === "action"),
      rows: list
        .filter((c: any) => c.kind !== "action")
        .map((c: any) => ({ id: c.id, pri: w.eval("premoveRank")(c), eff: w.eval("SORT_VALUE").effort(c), conf: w.eval("confOf")(c), age: c.meta?.openedAt || null })),
    };
  });

for (const [kind, vp] of [["desk", { width: 1400, height: 1000 }], ["phone", { width: 390, height: 844 }]] as const) {
  const c = await browser.newContext({ viewport: vp, extraHTTPHeaders: H, ...(kind === "phone" ? { isMobile: true, hasTouch: true } : {}) });
  const p = await c.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  // F8: a view saved before the round maps to the new keys; the filters that went are dropped.
  await p.addInitScript(() => {
    if (!sessionStorage.getItem("af-q1f-seeded")) {
      sessionStorage.setItem("af-q1f-seeded", "1");
      localStorage.removeItem("af.view4");
      localStorage.setItem("af.view3", JSON.stringify({ sort: "oldest", kinds: [], floor: "", q: "", calls: ["go"], efforts: [], change: ["up"], by: ["Demo Worker"] }));
    }
  });
  await p.goto(base + "/");
  await p.waitForSelector("[data-card]");
  const v0 = await ev(p, "JSON.stringify(view)");
  check(`${kind} F8: an old saved view (sort "oldest") maps to Age, oldest first; the old filters go`, JSON.stringify(JSON.parse(v0)) === JSON.stringify({ sort: "age", dir: "old", kinds: [], floor: "", q: "", efforts: [], conf: [] }), v0);
  // A view the page does not know falls back to the default, with no error.
  await p.evaluate(() => localStorage.setItem("af.view4", JSON.stringify({ sort: "board", dir: 7, floor: "P9", efforts: "x", conf: null, q: 3 })));
  await p.reload();
  await p.waitForSelector("[data-card]");
  const v1 = JSON.parse(await ev(p, "JSON.stringify(view)"));
  const sortNow = await ev(p, "sortOf()[0] + ':' + dirOf()[0]");
  check(`${kind} F8: the old view is read once: af.view3 is gone`, (await p.evaluate(() => localStorage.getItem("af.view3"))) === null);
  check(`${kind} F8: an unknown saved view falls back to the default (Priority, highest first)`, sortNow === "priority:high" && v1.sort === "priority" && v1.dir === "high" && v1.floor === "" && Array.isArray(v1.efforts) && Array.isArray(v1.conf) && v1.q === "", sortNow + " " + JSON.stringify(v1));
  await p.evaluate(() => localStorage.removeItem("af.view4"));
  await p.reload();
  await p.waitForSelector("[data-card]");

  // F8 and G1: the summary line; its dynamic words have the tint (.dv).
  const head = await p.$eval(".qhead", (e) => ({ text: (e.querySelector("span") as HTMLElement).textContent, bold: [...e.querySelectorAll(".dv")].map((b) => b.textContent), fg: [...e.querySelectorAll("b")].map((b) => getComputedStyle(b).color), body: getComputedStyle(document.body).color }));
  const n = (await facts(p)).total;
  check(`${kind} F8/G1: the summary reads "${n} packets, highest priority first." with ${n} and the order in the tint`, head.text === n + " packets, highest priority first." && JSON.stringify(head.bold) === JSON.stringify([String(n), "highest priority first"]) && head.fg.every((x) => x === head.body), JSON.stringify(head));

  await p.click("[data-filters]");
  await p.waitForTimeout(250);
  // F1-F4, F6, G2: the rows.
  const labels = await p.$$eval(".controls .clabel", (es) => es.map((e) => e.textContent));
  check(`${kind} F1-F6/G0: the rows are Kind, Predictor's priority, Packet creator's effort, Confidence, Sort`, labels.join(",") === "Kind,Predictor's priority,Packet creator's effort,Confidence,Sort", labels.join(","));
  const ctext = await p.$eval(".controls", (e) => e.textContent + " " + [...e.querySelectorAll("[title]")].map((x) => x.getAttribute("title")).join(" "));
  check(`${kind} G2: no filter, sort or tip says "board"`, !/board/i.test(ctext), (ctext.match(/.{0,40}board.{0,40}/i) || [""])[0]);
  check(`${kind} F3/F4: no "Premove's call", "Filed by" or "against"`, !/Premove's call|Filed by|against/i.test(ctext));
  const gtext = ctext + " " + (await p.$eval(".qhead", (e) => e.textContent));
  check(`${kind} G0: no control, tip or summary says "author", "Premover" or "consult"`, !/author|premover|consult/i.test(gtext), (gtext.match(/.{0,40}(author|premover|consult).{0,40}/i) || [""])[0]);
  // One look for "on": a picked chip with no kind color (All) is filled as a picked segment is.
  const onLook = await p.evaluate(() => [".kchip.all.on", ".seg button.on"].map((q) => { const e = document.querySelector(q); return e ? getComputedStyle(e).backgroundColor + "/" + getComputedStyle(e).color : "none"; }));
  check(`${kind}: a picked All chip and a picked segment look the same`, onLook[0] !== "none" && onLook[0] === onLook[1], onLook.join(" vs "));
  // Each label has its own line on a phone, and no chip is alone on a line.
  if (kind === "phone") {
    const lone = await p.$$eval(".controls .control", (es) => es.flatMap((e) => {
      const tops: Record<number, number> = {};
      for (const b of e.querySelectorAll(":scope > button, :scope > .seg")) tops[Math.round((b as HTMLElement).getBoundingClientRect().top)] = (tops[Math.round((b as HTMLElement).getBoundingClientRect().top)] || 0) + 1;
      const l = e.querySelector(".clabel") as HTMLElement | null;
      const first = e.querySelector(":scope > button, :scope > .seg") as HTMLElement | null;
      const own = !l || !first || first.getBoundingClientRect().top >= l.getBoundingClientRect().bottom - 1;
      // F2: with the counts a row may wrap (Confidence 3+2), but no chip or segment breaks inside.
      const n = Object.values(tops);
      return (!own ? [l!.textContent + ": the label shares its line"] : []).concat([...e.querySelectorAll("button")].filter((b) => (b as HTMLElement).getBoundingClientRect().height > 50).map((b) => l?.textContent + ": " + b.textContent + " breaks inside"));
    }));
    check(`${kind}: each label on its own line; no chip or segment breaks inside`, lone.length === 0, lone.join(" ; "));
  }
  // No small text (PM's look): every word in the bar and the summary is 16 px or more.
  const small = await p.$$eval(".controls *, .qhead *", (es) => es.filter((e) => (e as HTMLElement).offsetParent && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) && parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.textContent + " " + getComputedStyle(e).fontSize));
  check(`${kind}: no text under 16 px in the filters and the summary`, small.length === 0, small.slice(0, 4).join(" ; "));
  // G3: All goes last in every chip row and selector.
  const lasts = await p.$$eval(".controls .control", (es) => es.map((e) => [e.querySelector(".clabel")?.textContent, [...e.querySelectorAll("button")].map((b) => [...b.childNodes].filter((n) => !(n.nodeType === 1 && (n as Element).classList.contains("cnt"))).map((n) => n.textContent).join("").trim())]));
  for (const [l, bs] of lasts as [string, string[]][]) if (l && l !== "Sort") check(`${kind} G3: ${l}: All is last`, bs[bs.length - 1] === "All" && bs.filter((x) => x === "All").length === 1, bs.join(","));
  const pri = await p.$$eval("[data-seg=floor]", (es) => es.map((e) => [...e.childNodes].filter((n) => !(n.nodeType === 1 && (n as Element).classList.contains("cnt"))).map((n) => n.textContent).join("").trim()));
  check(`${kind} F1: Priority reads P0, P0-P1, P0-P2, P0-P3, All`, pri.join(",") === "P0,P0-P1,P0-P2,P0-P3,All", pri.join(","));
  const conf = await p.$$eval("[data-multi=conf]", (es) => es.map((e) => [...e.childNodes].filter((n) => !(n.nodeType === 1 && (n as Element).classList.contains("cnt"))).map((n) => n.textContent).join("").trim()));
  check(`${kind} F2.1: Confidence reads 70%+, 50-69%, Under 50%, None, All (sentence case)`, conf.join(",") === "70%+,50-69%,Under 50%,None,All", conf.join(","));
  // F2.2: each chip and priority segment shows how many cards it would show, at its own text size, and a 0 chip is not faint.
  {
    const chips = await p.evaluate(() => {
      const w = window as any;
      // All has no count (Antifeed PM, 2026-10-29: the summary has the total).
      const alls = [...document.querySelectorAll('.controls [data-multi][data-v=""], .controls [data-kind=""], .controls [data-seg=floor][data-v=""]')].filter((e) => e.querySelector(".cnt")).length;
      if (alls) return [{ label: "an All with a count", n: null, want: 0, shown: 0, size: ["", ""], color: ["", "", "1"] }];
      return [...document.querySelectorAll('.controls [data-multi]:not([data-v=""]), .controls [data-kind]:not([data-kind=""]), .controls [data-seg=floor]:not([data-v=""])')].map((e) => {
        const el = e as HTMLElement;
        const cnt = el.querySelector(".cnt") as HTMLElement | null;
        const d = el.dataset;
        const patch = d.multi ? { [d.multi]: d.v ? [d.v] : [] } : d.kind !== undefined ? { kinds: d.kind ? [d.kind] : [] } : { floor: d.v };
        const want = w.eval("countWith")(patch, d.kind !== undefined);
        // What the pick shows: the same matcher, over the open cards, as queueLists uses.
        const v2 = { ...w.eval("view"), ...patch };
        const shown = w.eval("openCards")().filter((c: any) => (d.kind !== undefined || c.kind !== "action") && w.eval("matcher")(v2)(c)).length;
        // Nil, 2026-10-29: a count has the tint of a dynamic value (.dv), or its chip's color on a filled chip.
        const probe = document.createElement("span");
        probe.className = "dv";
        document.body.append(probe);
        const dv = getComputedStyle(probe).color;
        probe.remove();
        return { dv, label: el.textContent, n: cnt ? Number(cnt.textContent) : null, want, shown, size: cnt ? [getComputedStyle(cnt).fontSize, getComputedStyle(el).fontSize] : null, color: cnt ? [getComputedStyle(cnt).color, getComputedStyle(el).color, getComputedStyle(cnt).opacity] : null };
      });
    });
    const bad = chips.filter((c: any) => c.n === null || c.n !== c.want || c.n !== c.shown || c.size[0] !== c.size[1] || (c.color[0] !== c.color[1] && c.color[0] !== c.dv) || c.color[2] !== "1");
    check(`${kind} F2.2: every chip and priority segment but All shows its count (${chips.length}), at its size, in the tint or its chip's color; All has none`, chips.length > 10 && bad.length === 0, JSON.stringify(bad.slice(0, 3)));
    const zero = chips.find((c: any) => c.n === 0);
    check(`${kind} F2.2: a chip with 0 is there (the walkthrough has one)`, !!zero, zero ? zero.label : chips.map((c: any) => c.label).join(","));
  }
  // F2.2: a pick shows exactly its count of cards (actions apart).
  {
    await p.click(`[data-multi=conf][data-v="low"]`);
    await p.waitForTimeout(200);
    const shownN = (await facts(p)).rows.length;
    const said = await p.$eval(`[data-multi=conf][data-v="low"] .cnt`, (e) => Number(e.textContent));
    check(`${kind} F2.2: Under 50% said ${said} and shows ${said} cards`, shownN === said, shownN + " vs " + said);
    await p.click(`[data-multi=conf][data-v=""]`);
    await p.waitForTimeout(200);
  }
  // PM's look: Search is on the first row, right of the summary, on a desktop; last in the filters on a phone.
  const sbox = await p.evaluate(() => { const q = document.querySelector("[data-view=q]") as HTMLElement; const s = document.querySelector(".qhead > span") as HTMLElement; return { inHead: !!q.closest(".qhead"), inBar: !!q.closest(".controls"), right: q.getBoundingClientRect().left >= s.getBoundingClientRect().right - 1, sameRow: Math.abs(q.getBoundingClientRect().top + q.getBoundingClientRect().height / 2 - (s.getBoundingClientRect().top + s.getBoundingClientRect().height / 2)) < 12, last: q.closest(".control") === document.querySelector(".controls > .control:last-child") }; });
  check(`${kind}: Search is ${kind === "desk" ? "on the first row, right of the summary" : "last in the filters"}`, kind === "desk" ? sbox.inHead && sbox.right && sbox.sameRow : sbox.inBar && sbox.last, JSON.stringify(sbox));
  const effTip = await p.$eval(".controls .control:nth-child(3) .clabel", (e) => e.getAttribute("title") || e.getAttribute("data-tip") || "");
  check(`${kind} F5: the effort tip names the packet creator`, /packet creator/.test(effTip), effTip);
  const priTip = await p.$eval(".controls .control:nth-child(2) .clabel", (e) => e.getAttribute("title") || e.getAttribute("data-tip") || "");
  check(`${kind} F1: the priority tip says where backlog and obsolete go`, /Backlog and obsolete count as below P3/.test(priTip), priTip);

  // F1: the priority floor reads the Premove's priority; a card with no Premove priority always shows.
  await p.click("[data-seg=floor][data-v=P1]");
  await p.waitForTimeout(250);
  {
    const f = await facts(p);
    const all = (await view()).cards.filter((x: any) => x.state === "open" && !x.held);
    const ranks = await p.evaluate((ids) => ids.map((id: string) => (window as any).eval("premoveRank")((window as any).eval("cardById")(id))), all.map((x: any) => x.id));
    const want = all.filter((x: any, i: number) => x.kind === "action" || ranks[i] === null || ranks[i] <= 1).map((x: any) => x.id).sort();
    const got = (await ev(p, "JSON.stringify(queueLists().list.map((c) => c.id))")) as string;
    const nNull = f.rows.filter((r) => r.pri === null).length;
    check(`${kind} F1: P0-P1 shows exactly the cards at Premove P0-P1, the cards with no Premove priority, and the actions`, JSON.stringify(JSON.parse(got).sort()) === JSON.stringify(want) && f.rows.every((r) => r.pri === null || r.pri <= 1) && nNull > 0 && f.rows.length < all.length, f.rows.length + " shown, " + nNull + " with no Premove priority, of " + all.length);
    const tab = await p.$eval("[data-tab=queue]", (e) => e.textContent);
    const note = await p.$eval(".qhead", (e) => ({ t: e.textContent, b: [...e.querySelectorAll("span .dv")].map((b) => b.textContent) }));
    const backlog = all.filter((x: any, i: number) => ranks[i] !== null && ranks[i] >= 4);
    check(`${kind} F1: a floor hides a card the Predictor put in backlog or obsolete`, backlog.length > 0 && backlog.every((x: any) => !JSON.parse(got).includes(x.id)), backlog.length + " such cards");
    check(`${kind} G1: the filter line tints the floor and the counts`, note.b.includes("P0-P1") && note.b.includes(String(JSON.parse(got).length)) && tab === "Queue (" + JSON.parse(got).length + " of " + all.length + ")", JSON.stringify(note) + " " + tab);
  }
  await p.click("[data-seg=floor][data-v='']");
  await p.waitForTimeout(200);

  // F6: each confidence band shows only its cards.
  const bands: [string, (x: number | null) => boolean][] = [["70", (x) => x !== null && x >= 70], ["50", (x) => x !== null && x >= 50 && x < 70], ["low", (x) => x !== null && x < 50], ["none", (x) => x === null]];
  const total = (await facts(p)).rows.length;
  let covered = 0;
  for (const [v, ok] of bands) {
    await p.click(`[data-multi=conf][data-v="${v}"]`);
    await p.waitForTimeout(200);
    const f = await facts(p);
    covered += f.rows.length;
    check(`${kind} F6: confidence ${v} shows only its cards`, f.rows.every((r) => ok(r.conf)), f.rows.length + " cards: " + f.rows.map((r) => r.conf).join(","));
    await p.click(`[data-multi=conf][data-v="${v}"]`);
    await p.waitForTimeout(150);
  }
  check(`${kind} F6: the four bands hold every card once`, covered === total, covered + " of " + total);
  await p.click(`[data-multi=conf][data-v="70"]`);
  await p.click(`[data-multi=conf][data-v="none"]`);
  await p.waitForTimeout(200);
  check(`${kind} F6: two picks show both bands`, (await facts(p)).rows.every((r) => r.conf === null || r.conf >= 70));
  await p.click(`[data-multi=conf][data-v=""]`);
  await p.waitForTimeout(200);
  check(`${kind} F6: All clears the row`, (await ev(p, "view.conf.length")) === 0);
  // F2.1/G4: a band reads the confidence as its "n% sure" text rounds it: 0.695 reads "70% sure" and is in 70%+; 0.495 is in 50-69%.
  {
    const edge = await p.evaluate(() => {
      const w = window as any;
      const ps = w.eval("V").cards.filter((x: any) => x.state === "open" && x.prediction && x.prediction.by !== "code:standin" && typeof x.prediction.confidence === "number");
      const [a, b] = ps;
      a.prediction.confidence = 0.695;
      b.prediction.confidence = 0.495;
      const inBand = (id: string, v: string) => {
        w.eval("view").conf = [v];
        const r = w.eval("queueLists()").list.some((x: any) => x.id === id);
        w.eval("view").conf = [];
        return r;
      };
      // The packet creator's pick shows no percent, so it is in No confidence (Antifeed PM, 2026-10-28).
      const cc = w.eval("V").cards.find((x: any) => x.state === "open" && x.kind === "decision" && x.id !== a.id && x.id !== b.id);
      cc.prediction = { by: "code:standin", standin: { basis: "author" }, call: { ...(a.prediction.call || {}) }, confidence: 0, why: "The author's pick: test", against: "" };
      return { text: w.eval("confText")(a.prediction), a70: inBand(a.id, "70"), a50: inBand(a.id, "50"), b50: inBand(b.id, "50"), blow: inBand(b.id, "low"), pickNone: inBand(cc.id, "none"), pickLow: inBand(cc.id, "low") };
    });
    check(`${kind} F2.1/G4: 0.695 reads "70% sure" and is in 70%+; 0.495 (50%) is in 50-69%`, edge.text === "70% sure" && edge.a70 && !edge.a50 && edge.b50 && !edge.blow, JSON.stringify(edge));
    check(`${kind} F6: the packet creator's pick is in None, not under 50%`, edge.pickNone && !edge.pickLow, JSON.stringify(edge));
    await p.reload();
    await p.waitForSelector("[data-card]");
    await p.click("[data-filters]");
    await p.waitForTimeout(250);
  }

  // F7: four keys, two directions each; a card with no value comes last; ties: older first.
  const rules: Record<string, (a: any, b: any) => number> = {
    priority: (a, b) => a.pri - b.pri,
    effort: (a, b) => b.eff - a.eff,
    confidence: (a, b) => b.conf - a.conf,
    age: (a, b) => b.age.localeCompare(a.age),
  };
  for (const key of ["priority", "age", "effort", "confidence"]) {
    await p.click(`[data-seg=sort][data-v=${key}]`);
    await p.waitForTimeout(200);
    const dirs = await p.$$eval("[data-seg=dir]", (es) => es.map((e) => e.textContent + (e.classList.contains("on") ? "*" : "")));
    for (const [i, d] of dirs.entries()) {
      await p.click(`[data-seg=dir] >> nth=${i}`);
      await p.waitForTimeout(200);
      const f = await facts(p);
      const k = key === "priority" ? "pri" : key === "effort" ? "eff" : key === "confidence" ? "conf" : "age";
      const cmp = (a: any, b: any) => {
        if (a[k] === null || b[k] === null) return (a[k] === null ? 1 : 0) - (b[k] === null ? 1 : 0);
        return i === 0 ? rules[key](a, b) : -rules[key](a, b);
      };
      const bad = f.rows.findIndex((r, j) => j > 0 && (cmp(f.rows[j - 1], r) > 0 || (cmp(f.rows[j - 1], r) === 0 && key !== "age" && f.rows[j - 1].age > r.age)));
      const line = await p.$eval(".qhead span", (e) => e.textContent);
      check(`${kind} F7: ${key}, ${d.replace("*", "")}: in order, no value last, ties older first, actions first, rows as the list`, bad < 0 && f.domOk && f.actionsFirst, bad < 0 ? line! : JSON.stringify(f.rows.slice(Math.max(0, bad - 1), bad + 1)));
    }
    check(`${kind} F7: ${key} starts on its first direction`, dirs[0].endsWith("*"), dirs.join(","));
  }
  const dirLabels: string[] = [];
  for (const key of ["priority", "age", "effort", "confidence"]) {
    await p.click(`[data-seg=sort][data-v=${key}]`);
    await p.waitForTimeout(150);
    dirLabels.push((await p.$$eval("[data-seg=dir]", (es) => es.map((e) => e.textContent))).join("/"));
  }
  check(`${kind} F7: the directions follow the key: Highest/Lowest, Newest/Oldest, Largest/Smallest, Most sure/Least sure first`, dirLabels.join(",") === "Highest first/Lowest first,Newest first/Oldest first,Largest first/Smallest first,Most sure first/Least sure first", dirLabels.join(","));
  await p.click(`[data-seg=sort][data-v=priority]`);
  await p.waitForTimeout(200);
  // PM's look 6: the None chip reads "no confidence"; with a band, "confidence 70%+ or none".
  await p.click(`[data-multi=conf][data-v="none"]`);
  await p.waitForTimeout(200);
  const n1 = await p.$eval(".qhead > span", (e) => [e.textContent, [...e.querySelectorAll(".dv")].map((b) => b.textContent)]);
  await p.click(`[data-multi=conf][data-v="70"]`);
  await p.waitForTimeout(200);
  const n2 = await p.$eval(".qhead > span", (e) => [e.textContent, [...e.querySelectorAll(".dv")].map((b) => b.textContent)]);
  check(`${kind} PM 6: None reads "Filters on: no confidence."; with 70%+, "confidence 70%+ or none"`, String(n1[0]).startsWith("Filters on: no confidence. ") && (n1[1] as string[]).includes("no confidence") && String(n2[0]).startsWith("Filters on: confidence 70%+ or none. ") && (n2[1] as string[]).includes("70%+") && (n2[1] as string[]).includes("none"), n1[0] + " | " + n2[0]);
  await p.click(`[data-multi=conf][data-v=""]`);
  await p.waitForTimeout(200);
  // F2.3: a change of the sort or a filter opens the first card of the new
  // order; a card with a call started on it (a note typed here) stays open, and the summary says so.
  {
    const curNow = () => ev(p, "cur");
    const first = () => ev(p, "queueLists().list[0].id");
    const pick = await ev(p, "queueLists().list.filter((c) => c.kind === 'decision' && c.prediction && !policyOf(c).noNote)[1].id");
    await p.evaluate((id) => { (window as any).eval("setCur")(id); (window as any).eval("redraw")(); }, pick);
    await p.waitForTimeout(200);
    await p.click(`[data-seg=sort][data-v=age]`);
    await p.waitForTimeout(250);
    const a = [await curNow(), await first(), (await p.$("[data-kept]")) !== null];
    check(`${kind} F2.3: with no call started, a new sort opens the first card of the new order`, a[0] === a[1] && a[0] !== pick && !a[2], JSON.stringify(a));
    await p.evaluate((id) => { (window as any).eval("setCur")(id); (window as any).eval("redraw")(); }, pick);
    await p.waitForTimeout(200);
    const note = `[data-card="${pick}"] [data-note]`;
    await p.locator(note).first().scrollIntoViewIfNeeded();
    await p.locator(note).first().fill("my own note");
    await p.waitForTimeout(150);
    await p.locator("[data-filters]").first().scrollIntoViewIfNeeded();
    await p.click(`[data-seg=dir][data-v=old]`);
    await p.waitForTimeout(250);
    const b = [await curNow(), await first(), await p.$eval("[data-kept]", (e) => e.textContent).catch(() => "")];
    check(`${kind} F2.3: with a note typed, the open card stays and the summary says so`, b[0] === pick && b[1] !== pick && b[2] === "The open packet stays open: you started a call on it.", JSON.stringify(b));
    const eff = await p.evaluate((id) => (window as any).eval("effortOf")((window as any).eval("cardById")(id)), pick);
    await p.click(`[data-multi=efforts][data-v="${eff}"]`);
    await p.waitForTimeout(250);
    const c2 = [await curNow(), await first()];
    check(`${kind} F2.3: a filter that keeps it in the list keeps it open too`, c2[0] === pick, JSON.stringify(c2) + " effort " + eff);
    await p.click(`[data-multi=efforts][data-v=""]`);
    await p.waitForTimeout(200);
    await p.evaluate((id) => { const w = window as any; delete w.eval("picks")[id]; }, pick);
    await p.click(`[data-seg=sort][data-v=priority]`);
    await p.waitForTimeout(250);
  }
  // F2.3: Search moves the open card only when the typing stops, not at each key.
  {
    const other = await ev(p, "queueLists().list[2].id");
    await p.evaluate((id) => { (window as any).eval("setCur")(id); (window as any).eval("redraw")(); }, other);
    await p.waitForTimeout(150);
    const box = p.locator("[data-view=q]").first();
    await box.click();
    await box.pressSequentially("   ", { delay: 150 });
    const typing = await ev(p, "cur");
    await p.waitForTimeout(1100);
    const after = [await ev(p, "cur"), await ev(p, "queueLists().list[0].id")];
    check(`${kind} F2.3: while Nil types in Search the open card stays; when the typing stops it is the first`, typing === other && after[0] === after[1], JSON.stringify([other, typing, ...after]));
    await box.fill("");
    await p.waitForTimeout(1000);
  }
  // F2.3: after a reorder, Later (l) acts on the card that is open now.
  if (kind === "desk") {
    await p.click(`[data-seg=sort][data-v=age]`);
    await p.waitForTimeout(250);
    const now = await ev(p, "cur");
    await p.locator(`[data-card="${now}"] h2, [data-card="${now}"] .q`).first().click().catch(() => {});
    await p.keyboard.press("Escape");
    await p.keyboard.press("l");
    await p.waitForTimeout(300);
    const later = JSON.parse((await p.evaluate(() => sessionStorage.getItem("af.later"))) || "[]");
    check("desk F2.3: after a reorder, Later moves the open card (the first of the new order)", later.includes(now) && (await ev(p, "cur")) !== now, JSON.stringify([now, later]));
    await p.evaluate(() => sessionStorage.removeItem("af.later"));
    await p.click(`[data-seg=sort][data-v=priority]`);
    await p.waitForTimeout(250);
  }
  // The sort stays after a reload.
  await p.click(`[data-seg=sort][data-v=effort]`);
  await p.click(`[data-seg=dir][data-v=low]`);
  await p.reload();
  await p.waitForSelector("[data-card]");
  const kept = await p.$eval(".qhead span", (e) => e.textContent);
  check(`${kind} F8: the sort stays after a reload`, /smallest effort first\.$/.test(kept || ""), kept!);
  await p.evaluate(() => localStorage.removeItem("af.view4"));
  await p.reload();
  await p.waitForSelector("[data-card]");
  await p.click("[data-filters]");
  await p.waitForTimeout(250);
  const wide = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  check(`${kind}: the open filters fit the screen's width`, wide[0] <= wide[1], wide.join(" > "));
  const over = await p.$$eval(".controls .seg, .controls .kchip", (es) => es.filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5).map((e) => e.textContent + " ends at " + Math.round(e.getBoundingClientRect().right)));
  check(`${kind}: no chip or segment row runs past the screen's right edge`, over.length === 0, over.join(" ; "));
  if (shots) await p.screenshot({ path: `${shots}/f-${kind}-filters.png`, fullPage: false });
  check(`${kind}: no page error`, errors.length === 0, errors.join(" ; "));
  await c.close();
}
// PM's look 7: a stored view or Later list that is not JSON falls back to the default; the queue shows, with no page error.
{
  const c = await browser.newContext({ viewport: { width: 1400, height: 1000 }, extraHTTPHeaders: H });
  await c.addInitScript(() => {
    localStorage.setItem("af.view4", "{");
    localStorage.setItem("af.view3", "{");
    sessionStorage.setItem("af.later", "{");
  });
  const p = await c.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(base + "/");
  const ok = await p.waitForSelector("[data-card]", { timeout: 10_000 }).then(() => true).catch(() => false);
  const sortNow = ok ? await ev(p, "sortOf()[0] + ':' + dirOf()[0]") : "";
  check("PM 7: \"{\" in af.view4, af.view3 and af.later: the queue shows the default view, with no page error", ok && sortNow === "priority:high" && errors.length === 0, sortNow + " " + errors.join(" ; "));
  await c.close();
}
await browser.close();
console.log(fails ? fails + " FAIL" : "all pass");
process.exit(fails ? 1 : 0);
