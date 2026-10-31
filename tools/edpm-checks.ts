// Effective decisions (DESIGN.md section 15) and the toast's title (15.1), on
// a walkthrough copy. It decides cards, so run it on a fresh copy:
//   PORT=21199 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/edpm-checks.ts http://localhost:21199
import { chromium, devices } from "playwright-core";
// The page's Help list (src/client.js), read inside page.evaluate.
declare const TERMS: [string, string, string, string][];

const base = process.argv[2];
const H = { "X-Isomux-Member-Id": "m0000000", "Content-Type": "application/json" };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const view = async () => (await (await fetch(base + "/api/view", { headers: H })).json()) as any;
const weekly = async () => ((await (await fetch(base + "/api/weekly", { headers: H })).json()) as any).weeks;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
};
for (let i = 0; i < 60 && (await view()).cards.some((k: any) => k.state === "predicting"); i++) await sleep(500);

async function page(kind: "desk" | "phone", width = 1280, height = 720) {
  const o = kind === "phone" ? { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } : { viewport: { width, height } };
  const c = await browser.newContext({ ...o, extraHTTPHeaders: { "X-Isomux-Member-Id": H["X-Isomux-Member-Id"] } });
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  await p.goto(base + "/");
  await p.waitForSelector("[data-card]");
  await p.waitForTimeout(1200);
  return p;
}

// 1. A decision's toast: the card's title first, then the call. On a desk no
// toast text is cut: it wraps in the header dock (walk 2, PM, 2026-10-26,
// 06e3db2, which replaced "the title gives way"); on a phone the whole text
// shows in its three lines.
const c0 = (await view()).cards.find((c: any) => c.state === "open" && c.kind === "decision" && c.prediction?.call && Object.keys(c.prediction.call).length && /^.{50,}$/.test(c.packet.question));
for (const kind of ["desk", "phone"] as const) {
  const p = await page(kind);
  const id = c0.id as string;
  if (!(await p.$(`[data-card="${id}"]`))) {
    await p.click(`.row[data-cur="${id}"]`);
    await p.waitForSelector(`[data-card="${id}"]`);
    await p.waitForTimeout(1500);
  }
  await p.locator(`[data-callzone="${id}"] .actions [data-confirm]`).first().evaluate((e) => e.scrollIntoView({ block: "center" }));
  await p.waitForTimeout(500);
  await p.locator(`[data-callzone="${id}"] .actions [data-confirm]`).first().click();
  await p.waitForTimeout(400);
  const t = await p.$eval("#toast .ttext", (e) => {
    const title = e.querySelector(".ttitle") as HTMLElement | null, call = e.querySelector(".tcall") as HTMLElement | null;
    const r = e.getBoundingClientRect(), cr = call?.getBoundingClientRect();
    return { title: title?.textContent ?? "", call: call?.textContent ?? "", titleCut: !!title && title.scrollWidth > title.clientWidth + 1, callWhole: !!cr && cr.right <= r.right + 1 && call!.scrollWidth <= Math.ceil(cr.width) + 1, allLines: e.scrollHeight <= e.clientHeight + 1 };
  });
  const head = String(c0.packet.question).replace(/^[A-Za-z ]{2,24}:\s+/, "").slice(0, 12).toLowerCase();
  check(`1. ${kind}: the toast starts with the card's title, and the call follows`, t.title.toLowerCase().startsWith(head) && /^ · Decided \S/.test(t.call), JSON.stringify(t));
  if (kind === "desk") check("1. desk 1280 px: no toast text is cut", !t.titleCut && t.callWhole && t.allLines, JSON.stringify(t));
  else check("1. phone: the whole text shows in its lines", t.allLines, JSON.stringify(t));
  await p.click("[data-toast-undo]");
  await p.waitForTimeout(800);
  check(`1. ${kind}: its Undo brings the same card back`, (await view()).cards.find((c: any) => c.id === id).state === "open");
  await p.context().close();
}

// 2. Confirm two Premoves, change one, confirm a stand-in and decide a
// card with no basis, through the API: no band has 35 earlier matches, so
// every call needed Nil, and no call is sure.
const v0 = await view();
const noBasis = (c: any) => c.prediction?.by === "code:standin" && (c.prediction.standin?.basis === "none" || /^No basis/.test(c.prediction.why));
const opens = v0.cards.filter((c: any) => c.state === "open" && c.kind === "decision" && c.prediction);
const isStandin = (c: any) => c.prediction.by === "code:standin" || String(c.prediction.by).startsWith("agent:standin@");
const plain = opens.filter((c: any) => !isStandin(c)).slice(0, 3);
const standin = opens.find((c: any) => isStandin(c) && !noBasis(c));
const nb = opens.find(noBasis);
check("2. the seed has a stand-in with a basis and a card with no basis", !!standin && !!nb, JSON.stringify([standin?.id, nb?.id]));
const done: string[] = [];
for (const [i, c] of [...plain, standin, nb].filter(Boolean).entries()) {
  const call = { ...c.prediction.call };
  if (i === 2) {
    const f = Object.entries(v0.policies.find((p: any) => p.id === c.policy).answer ?? {}).find(([, v]: any) => v.enum && v.enum.length > 1) as any;
    if (f) call[f[0]] = f[1].enum.find((v: unknown) => v !== call[f[0]]);
  }
  const r = await fetch(base + "/api/cards/" + c.id + "/decide", { method: "POST", headers: H, body: JSON.stringify({ version: c.version, call, shownAt: new Date(Date.now() - 20_000).toISOString() }) });
  if (r.ok) done.push(c.id);
  else console.log("decide", c.id, r.status, await r.text());
}
const all = (await weekly()).find((w: any) => w.policy === "all");
check("2. five calls: all needed Nil, none sure, one with no basis", done.length === 5 && all?.decisions === 5 && all.effective === 5 && all.sureConfirms === 0 && all.unpredicted === 1 && all.changed === 1, JSON.stringify(all));

// 3. The Accuracy tab, desktop: the renamed column with Nil's definition as
// its tip, the term in the note, and the threshold line per policy.
for (const kind of ["desk", "phone"] as const) {
  const p = await page(kind, 1400, 1000);
  await p.click("[data-tab=accuracy]");
  await p.waitForTimeout(800);
  const r = await p.evaluate(() => ({
    th: [...document.querySelectorAll("th")].map((e) => [e.textContent, e.getAttribute("title") ?? ""]),
    labels: [...document.querySelectorAll("td[data-label]")].map((e) => e.getAttribute("data-label")),
    // P9 allows no dotted word in running text, so the note has no "needed"
    // term now: compare the column's tip with Help's entry (the page's TERMS).
    needed: (TERMS.find((x: any) => x[0] === "needed") ?? [])[2] ?? "",
    old: /Changed calls per minute/.test(document.body.innerText),
    sure: [...document.querySelectorAll("[data-sure]")].map((e) => e.textContent),
    noneSure: document.querySelector("[data-nonesure]")?.textContent ?? "",
    text: document.body.innerText,
    wide: document.documentElement.scrollWidth > innerWidth + 1,
  }));
  const col = r.th.find(([t]) => t === "Calls that needed you, per minute");
  check(`3. ${kind}: the column is "Calls that needed you, per minute", its tip gives Nil's definition`, !!col && /two reasonable people could disagree/.test(col[1]) && /less than 90% sure by its record/.test(col[1]) && r.labels.includes("Calls that needed you, per minute"), JSON.stringify(r.th));
  check(`3. ${kind}: no "Changed calls per minute" left; Help's "needed" entry has the same text as the tip`, !r.old && r.needed === col?.[1], r.needed);
  check(`3. ${kind}: one threshold line per policy with calls`, r.sure.length >= 1 && r.sure.every((s) => /^0 calls you confirmed at 90% or more: candidates for a threshold\.$/.test(s ?? "")), JSON.stringify(r.sure));
  check(`3. ${kind}: no sideways scroll`, !r.wide);
  check(`3. ${kind}: while no kind can be sure, the line under the table says why the two rates are equal`, r.noneSure === "Every confirm counts as needing you until a kind has 35 matching calls in a row at the same confidence.", r.noneSure);
  check(`3. ${kind}: a call with no Premove says "no basis", never "no Premove"`, /1 with no basis/.test(r.text) && !/no Premove\b/.test(r.text), (r.text.match(/.{0,40}no (basis|Premove).{0,20}/g) ?? []).join(" | "));
  check(`3. ${kind}: a stand-in row's label goes on in lower case`, /Stand-in: [a-z]/.test(r.text) && !/Stand-in: [A-Z]/.test(r.text), (r.text.match(/Stand-in: .{0,30}/g) ?? []).join(" | "));
  await p.click("[data-tab=decided]");
  await p.waitForTimeout(800);
  const d = await p.evaluate(() => document.body.innerText);
  check(`3. ${kind}: Decided says "no basis" for the card with no basis, and never "no Premove"`, /no basis/.test(d) && !/no Premove\b/.test(d), (d.match(/.{0,40}no (basis|Premove).{0,20}/g) ?? []).join(" | "));
  await p.context().close();
}

await browser.close();
console.log(fails ? `${fails} FAIL` : "ALL PASS");
process.exit(fails ? 1 : 0);
