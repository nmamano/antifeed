// Queue round 1, package S (Nil's feedback, 2026-10-28, /tmp/af-queue-r1/SPEC.md S1):
// the Sources tab, and one line in the queue only while a source is broken.
// It waits out a board read (1 min), so it takes about 3 minutes. Run on a fresh walkthrough copy:
//   PORT=21061 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/queue-r1-s-checks.ts http://localhost:21061 [shots dir]
import { chromium, type Page } from "playwright-core";

const base = process.argv[2];
const shots = process.argv[3];
const H = { "X-Isomux-Member-Id": "m0000000" };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const view = async () => (await (await fetch(base + "/api/view", { headers: H })).json()) as any;
const office = async (path: string, body: unknown) => (await (await fetch(base + "/fake-office/control/" + path, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()) as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
};
for (let i = 0; i < 60 && (await view()).cards.some((k: any) => k.state === "predicting" || k.state === "preparing"); i++) await sleep(500);
// Wait until every declared source has been read once.
const declared = (await view()).projects.flatMap((d: any) => (d.sources || []).filter((s: any) => s.kind === "isomux-board" || s.kind === "isomux-inbox").map((s: any) => (s.kind === "isomux-board" ? "board:" : "inbox:") + d.project + "/" + s.id));
for (let i = 0; i < 40; i++) {
  const st = await (await fetch(base + "/api/status", { headers: H })).json();
  if (declared.every((k: string) => st.timers[k] && !st.timers[k].error)) break;
  await sleep(500);
}

const page = async (kind: "desk" | "phone") => {
  const c = await browser.newContext({ viewport: kind === "phone" ? { width: 390, height: 844 } : { width: 1400, height: 1000 }, extraHTTPHeaders: H, ...(kind === "phone" ? { isMobile: true, hasTouch: true } : {}) });
  const p = await c.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(base + "/");
  await p.waitForSelector("[data-card]");
  return { c, p, errors };
};
let moreRow = "";
const toSources = async (p: Page, phone: boolean) => {
  if (phone) {
    await p.tap("[data-more]");
    await p.waitForTimeout(300);
    moreRow = JSON.stringify(await p.$$eval("#tabs button", (es) => es.filter((e) => getComputedStyle(e).display !== "none").map((e) => [e.textContent, Math.round(e.getBoundingClientRect().top)])));
  }
  await (phone ? p.tap("[data-tab=sources]") : p.click("[data-tab=sources]"));
  await p.waitForSelector("[data-source]");
  await p.waitForTimeout(300);
};
const lines = (p: Page) => p.$$eval("[data-source]", (es) => es.map((e) => ({ key: (e as HTMLElement).dataset.source, text: e.textContent || "", bold: [...e.querySelectorAll(".dv")].map((b) => b.textContent), warn: e.classList.contains("warn"), plain: [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("") })));
const queueAlert = (p: Page) => p.$eval("#tab-queue", (e) => [e.querySelector("[data-source-alert]")?.textContent ?? "", e.textContent || ""]);

// 1. All sources read: the queue has no source line; the Sources tab has one line per source.
for (const kind of ["desk", "phone"] as const) {
  const { c, p, errors } = await page(kind);
  const [alert, qtext] = await queueAlert(p);
  check(`${kind} S1: with every source read, the queue has no source line and no Inbox line`, !alert && !/asks do not come|Inbox:/.test(qtext), alert);
  await toSources(p, kind === "phone");
  const ls = await lines(p);
  check(`${kind} S1: Sources has one line per declared source`, JSON.stringify(ls.map((l) => l.key).sort()) === JSON.stringify([...declared].sort()), ls.map((l) => l.key).join(","));
  const v = await view();
  for (const l of ls) {
    const proj = l.key!.split(":")[1].split("/")[0];
    const n = v.cards.filter((x: any) => x.project === proj && x.state === "open" && !x.held).length;
    const name = l.key!.startsWith("inbox:") ? "Office Inbox" : v.projects.find((d: any) => d.project === proj).name + " board";
    check(`${kind} S1/G1: ${name}: "read <when>, ${n} packets in the queue", the name, the time and the count in the tint`, new RegExp("^" + name + ": read (just now|\\d+ min ago), " + n + " packets? in the queue\\.$").test(l.text) && l.bold[0] === name && l.bold[2] === String(n) && !l.warn, l.text + " | bold " + l.bold.join(","));
  }
  if (kind === "phone") {
    const nav = JSON.parse(moreRow) as [string, number][];
    check("phone: with More open, the tabs (Sources too) and Less are one row", new Set(nav.map((t) => t[1])).size === 1 && nav.some((t) => t[0] === "Sources") && nav.some((t) => t[0] === "Less"), moreRow);
  }
  const wide = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  check(`${kind}: Sources has no sideways scroll`, wide[0] <= wide[1], wide.join(" > "));
  const small = await p.$$eval("#tab-sources *", (es) => es.filter((e) => (e as HTMLElement).offsetParent && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) && parseFloat(getComputedStyle(e).fontSize) < 15).map((e) => e.textContent));
  check(`${kind}: no text under 15 px on Sources`, small.length === 0, small.slice(0, 3).join(" ; "));
  const words = await p.$eval("#tab-sources", (e) => e.textContent || "");
  check(`${kind} G0: Sources says no Premover, author or consult`, !/Premover|author|consult/i.test(words));
  if (shots) await p.screenshot({ path: `${shots}/s-${kind}-sources.png` });
  check(`${kind}: no page error`, errors.length === 0, errors.join(" ; "));
  await c.close();
}

// 2. Nil's Inbox access off: a state, not a failure. Sources says so; the queue does not.
await office("reach", { switch: false });
await sleep(11_000);
{
  const { c, p } = await page("desk");
  const [alert, qtext] = await queueAlert(p);
  check("S1: access off: the queue has no line", !alert && !/asks do not come/.test(qtext), alert);
  await toSources(p, false);
  const l = (await lines(p)).find((x) => x.key!.startsWith("inbox:"))!;
  check("S1: access off: the Inbox line says it, not as a failure", /\. Your asks do not come into Antifeed yet\. Your pages do\.$/.test(l.text) && !l.warn, l.text);
  await c.close();
}
await office("reach", { switch: true });

// 3. A broken Inbox (no live owner: the reads are refused) and a broken board: one line in the queue, linked to Sources.
await office("reach", { owner: false });
await office("boardfail", { on: true });
await sleep(62_000);
for (const kind of ["desk", "phone"] as const) {
  const { c, p, errors } = await page(kind);
  const boards = declared.filter((k: string) => k.startsWith("board:"));
  const v = await view();
  const names = boards.map((k: string) => v.projects.find((d: any) => d.project === k.split(":")[1].split("/")[0]).name + " board");
  const [alert] = await queueAlert(p);
  const n = await p.$$eval("#tab-queue [data-source-alert]", (es) => es.length);
  check(`${kind} S1: broken sources: one line in the queue names each, with a link to Sources`, n === 1 && alert.startsWith("Antifeed cannot read the ") && alert.includes("Office Inbox") && names.every((x: string) => alert.includes(x)) && alert.endsWith("Sources says why."), alert);
  const first = await p.$eval("#tab-queue", (e) => (e.firstElementChild as HTMLElement)?.querySelector("[data-source-alert]") !== null || (e.firstElementChild as HTMLElement)?.matches("[data-source-alert]"));
  check(`${kind} S1: the line is first in the queue`, first);
  const bold = await p.$$eval("[data-source-alert] .dv", (es) => es.map((e) => e.textContent));
  check(`${kind} G1: the source names have the tint`, bold.includes("Office Inbox") && names.every((x: string) => bold.includes(x)), bold.join(","));
  await (kind === "phone" ? p.tap("[data-source-alert] a") : p.click("[data-source-alert] a"));
  await p.waitForSelector("[data-source]");
  await p.waitForTimeout(300);
  const tab = await p.evaluate(() => (window as any).eval("tab"));
  const ls = await lines(p);
  const bad = ls.filter((l) => l.warn);
  check(`${kind} S1: the link opens Sources; each broken source says why and when it was last tried`, tab === "sources" && bad.length === boards.length + 1 && bad.every((l) => /: Antifeed cannot read it: .+[.?!] Last tried (just now|\d+ min ago)\.$/.test(l.text)), ls.map((l) => l.text).join(" ; "));
  if (shots) await p.screenshot({ path: `${shots}/s-${kind}-broken.png` });
  check(`${kind}: no page error`, errors.length === 0, errors.join(" ; "));
  await c.close();
}

// 4. Fixed again: the line goes.
await office("reach", { owner: true });
await office("boardfail", { on: false });
await sleep(62_000);
{
  const { c, p } = await page("desk");
  const [alert] = await queueAlert(p);
  check("S1: when every source reads again, the queue line goes", !alert, alert);
  await c.close();
}
await browser.close();
console.log(fails ? fails + " FAIL" : "all pass");
process.exit(fails ? 1 : 0);
