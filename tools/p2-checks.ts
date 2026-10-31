// Round q1, package P2 (Antifeed PM's live walk of 6bfa524), on a walkthrough copy:
//   PORT=21199 ISOMUX_APP_DATA_DIR=/tmp/af-<topic>/data ANTIFEED_WALKTHROUGH=1 bun run src/main.ts
//   bun tools/p2-checks.ts http://localhost:21199 [http://localhost:21042]
// The second address is the live app: the checks only GET its /api/view and
// draw it in the copy's page, so the Inbox with no Predictor agent and the
// real agent chips show. It writes nothing to the live app.
import { chromium, devices } from "playwright-core";

const base = process.argv[2];
const live = process.argv[3];
const H = { "X-Isomux-Member-Id": "m0000000", "Content-Type": "application/json" };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const view = async (b = base) => (await (await fetch(b + "/api/view", { headers: b === base ? H : {} })).json()) as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
};

// A withdrawn row: the fake office closes one of its asks; the Inbox reads it within 10 s.
const office = async (path: string, body?: unknown) => (await (await fetch(base + "/fake-office/control/" + path, body === undefined ? { headers: H } : { method: "POST", headers: H, body: JSON.stringify(body) })).json()) as any;
for (let i = 0; i < 60 && !(await view()).cards.some((c: any) => c.project === "inbox" && c.state === "open"); i++) await sleep(500);
await office("ask/close", { id: (await office("state")).asks[0].id });
for (let i = 0; i < 60 && !(await view()).cards.some((c: any) => c.state === "withdrawn"); i++) await sleep(500);
for (let i = 0; i < 60 && (await view()).cards.some((k: any) => k.state === "predicting"); i++) await sleep(500);
const liveView = live ? await view(live) : null;

for (const kind of ["desk", "phone"] as const) {
  const o = kind === "phone" ? { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } : { viewport: { width: 1400, height: 1000 } };
  const ctx = await browser.newContext({ ...o, extraHTTPHeaders: { "X-Isomux-Member-Id": H["X-Isomux-Member-Id"] } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => check(kind + ": no page error", false, e.message));

  // 3. A withdrawn row says why once.
  await p.goto(base + "/#decided");
  await p.waitForTimeout(1200);
  const w = (await view()).cards.find((c: any) => c.state === "withdrawn");
  const sel = `details[data-dkey="dec:${w.id}"]`;
  await (kind === "phone" ? p.tap(sel + " > summary") : p.click(sel + " > summary"));
  await p.waitForTimeout(800);
  const wt = await p.$eval(sel, (e) => (e as HTMLElement).innerText);
  const reason = wt.split("·")[1]?.split("\n")[0].trim() ?? "";
  check(kind + ": 3. an open withdrawn row says its reason once", !!reason && wt.split(reason).length === 2 && !/Why it left the queue/.test(wt), reason);

  // 5. Project names, not ids.
  await p.goto(base + "/#policies");
  await p.waitForTimeout(1000);
  const heads = await p.$$eval("#tab-policies h2", (es) => es.map((e) => (e as HTMLElement).innerText));
  check(kind + ": 5. Policies names the Inbox and Wall Game by name", heads.includes("Project: Inbox") && heads.includes("Project: Wall Game") && !heads.includes("Project: inbox"), heads.join(" | "));

  if (liveView) {
    // The live view, drawn here: Policies, Setup and Decided as Nil sees them.
    const drawn = await p.evaluate((lv) => {
      const w = window as any;
      // The page's own globals (a classic script): V, drawTab, openFolds.
      // eslint-disable-next-line no-eval
      const g = (0, eval)("({ set: (x) => (V = x), drawTab, openFolds })");
      g.set(lv);
      g.drawTab("policies");
      const pol = (document.querySelector("#tab-policies") as HTMLElement).innerText;
      const heads = [...document.querySelectorAll("#tab-policies h2")].map((e) => (e as HTMLElement).innerText);
      const inbox = [...document.querySelectorAll("#tab-policies section")].find((s) => /Project: inbox/i.test(s.querySelector("h2")?.textContent ?? "")) as HTMLElement | undefined;
      g.drawTab("setup");
      const setupHeads = [...document.querySelectorAll("#tab-setup h2")].map((e) => (e as HTMLElement).innerText);
      // A decided row whose Premove an agent made, opened.
      // A decided row whose Premove an agent made: the live view's own, or an open
      // card with an agent's Premove, shown here as decided (the page only draws it).
      const agentMade = (x: any) => x.prediction && /^agent:/.test(x.prediction.by) && !/standin|predictor@/.test(x.prediction.by);
      let c = lv.cards.find((x: any) => x.decision && agentMade(x));
      if (!c) {
        const o = lv.cards.find((x: any) => x.state === "open" && agentMade(x));
        if (o) {
          c = { ...o, state: "decided", decidedAt: new Date().toISOString(), decision: { event: "e_test", call: o.prediction.call, by: "human:Nil" }, outcome: "matched", sends: [] };
          lv.cards.push(c);
        }
      }
      let dec = { chips: 0, by: "" };
      if (c) {
        g.openFolds.add("dec:" + c.id);
        g.drawTab("decided");
        const d = document.querySelector('details[data-dkey="dec:' + c.id + '"]')!;
        dec = { chips: d.querySelectorAll(".ddetail .dsec .dlab a.agent").length, by: c.prediction.by };
      }
      // The avatars as drawn: size, weight and contrast with white.
      const lum = (rgb: string) => {
        const [r, g2, b] = rgb.match(/\d+/g)!.slice(0, 3).map((n) => {
          const c2 = Number(n) / 255;
          return c2 <= 0.03928 ? c2 / 12.92 : ((c2 + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g2 + 0.0722 * b;
      };
      const avs = [...document.querySelectorAll("a.agent .av")].map((e) => {
        const cs = getComputedStyle(e);
        return { size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight), ratio: 1.05 / (lum(cs.backgroundColor) + 0.05) };
      });
      w.__done = true;
      return { pol, heads, inbox: inbox?.innerText ?? "", setupHeads, dec, avs };
    }, liveView);
    check(kind + ": live 2. the Inbox has no Predictor agent, so a quick model run makes its Premove", /a quick model run makes the Premove/.test(drawn.inbox) && !/see Setup/.test(drawn.pol) && !/Predictor/.test(drawn.inbox), drawn.inbox.slice(0, 300).replace(/\n/g, " / "));
    // The Inbox's name comes from its policies file (check 5 above); the live app reads the file it was started with.
    check(kind + ": live 5. headings: isomux, Wall Game", ["Project: isomux", "Project: Wall Game"].every((h) => drawn.heads.includes(h) && drawn.setupHeads.includes(h)), drawn.heads.join(" | "));
    check(kind + ": live 4. Decided names the Premove maker and the Against with the agent chip", drawn.dec.chips >= 2, JSON.stringify(drawn.dec));
    check(kind + ": live 1. every avatar is 12 px or more, bold, and 7:1 or more", drawn.avs.length > 0 && drawn.avs.every((a) => a.size >= 12 && a.weight >= 700 && a.ratio >= 7), drawn.avs.length + " avatars, lowest " + Math.min(...drawn.avs.map((a) => a.ratio)).toFixed(2) + ":1");
  }
  await ctx.close();
}
await browser.close();
console.log(fails ? fails + " FAILED" : "ALL PASS");
process.exit(fails ? 1 : 0);
