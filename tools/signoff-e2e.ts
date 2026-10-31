// Part J's end-to-end (Antifeed PM, 2026-10-30, item 8): an Antifeed
// walkthrough copy (ANTIFEED_LOOP_URL set) against a Loop app COPY whose
// office is the copy's fake office. Plays the Scout (posts each packet with
// its command id) and Nil (decides through the human routes), and reads the
// Loop app copy and the fake office. Never the live Loop app or the live
// Antifeed: both bases must not be 21025 or 21042.
//   bun tools/signoff-e2e.ts http://localhost:21199 http://localhost:21198
const [af, loop] = process.argv.slice(2);
if (!af || !loop || /:(21025|21042)\b/.test(af + loop)) throw new Error("give the two copies' bases, never the live apps");
const H = { "X-Isomux-Member-Id": "m0000000", "Content-Type": "application/json" };
let fails = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (!ok) fails++;
  console.log((ok ? "PASS " : "FAIL ") + n + (d ? " | " + d : ""));
};
const get = async (u: string) => (await fetch(u, { headers: H })).json() as Promise<any>;
const post = async (u: string, b?: unknown) => {
  const r = await fetch(u, { method: "POST", headers: H, body: b === undefined ? "" : JSON.stringify(b) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(1000);
  }
}
const loopItems = async () => ((await get(`${loop}/api/signoff`)).items ?? []) as any[];
const cards = async () => ((await get(`${af}/api/cards?state=all&policy=signoff`)).cards ?? []) as any[];
const office = async () => get(`${af}/fake-office/control/state`);

// The Scout: answer each open signoff.prepare with a packet.
async function scout(taskId: string, call: "approve" | "revert", verdict: "stamp" | "look" | "pushback", why: string, suggestions = { copy: {}, images: {} }) {
  const card = await until(`a card for ${taskId}`, async () => (await cards()).find((c) => c.subject === taskId && c.state !== "withdrawn" && c.state !== "decided"));
  const k = await until(`a prepare for ${taskId}`, async () => {
    const st = await get(`${af}/api/status`);
    return (st.inFlight as any[]).find((x) => x.type === "signoff.prepare" && x.subject === taskId && (x.state === "issued" || x.state === "delivered"));
  });
  await post(`${af}/api/commands/${k.id}/start`);
  const imgs = (k.params.images as { blob: string; caption: string; pair?: string; side?: string }[]).filter((m) => m.pair).slice(0, 2);
  const packet = {
    question: "Sign-off check of item " + (waiting.findIndex((w) => w.taskId === taskId) + 1),
    blocks: [{ type: "markdown", text: why }, ...imgs.map((m) => ({ type: "image", blob: m.blob, caption: m.caption.slice(0, 80), pair: { name: m.pair, side: m.side }, focus: { x: 0.05, y: 0.05, w: 0.5, h: 0.4 } }))],
    options: [{ id: "pick", label: call === "approve" ? "Approve" : "Revert", fill: { call } }],
    recommended: "pick",
  };
  const r = await post(`${af}/api/cards`, { command: k.id, packet, meta: { raw: "https://office.example.com/loop", commit: k.params.commit, scout: { verdict, confidence: 0.8, suggestions } } });
  if (r.status !== 201) throw new Error(`packet for ${taskId}: ${r.status} ${JSON.stringify(r.body)}`);
  return until(`${taskId} open`, async () => (await cards()).find((c) => c.id === card.id && c.state === "open"));
}
const decide = (c: any, call: object) => post(`${af}/api/cards/${c.id}/decide`, { version: c.version, call });
const commitOf = async (id: string) => (await loopItems()).find((i) => i.taskId === id)?.merged?.commit;

const waiting = (await loopItems()).filter((i) => i.state === "waiting");
console.log(`INFO the Loop app copy has ${waiting.length} waiting items`);
if (waiting.length < 5) throw new Error("the copy needs at least 5 waiting items");
const [a, b, c, d, e] = waiting.map((i) => i.taskId);

// 1. Each waiting item makes a card, its images copied into Antifeed.
await until("a card per waiting item", async () => waiting.every((w) => true) && (await cards()).filter((x) => x.state !== "withdrawn").length >= waiting.length);
const withImages = waiting.find((w) => w.images.length);
if (withImages) {
  const st = await get(`${af}/api/status`);
  const k = (st.inFlight as any[]).find((x) => x.type === "signoff.prepare" && x.subject === withImages.taskId);
  const ok = k && k.params.images.length === withImages.images.length && (await fetch(`${af}/api/blobs/${k.params.images[0].blob}`)).ok;
  check("1. a waiting item makes a card; its images are in Antifeed's blobs", !!ok, `${withImages.taskId}: ${withImages.images.length} images`);
}

// 2. Stamp: Approve with no note or comments: the copy approves it, files nothing.
const tasksBefore = (await office()).tasks.length;
const ca = await scout(a, "approve", "stamp", "Copy only, as you asked.");
check("2. the Scout's pick is the Premove", (await decide(ca, { call: "approve" })).status === 200);
await until(`${a} approved on the copy`, async () => (await loopItems()).find((i) => i.taskId === a)?.state === "approved", 60_000);
check("2. stamp: the copy approved it and filed no changes task", (await office()).tasks.length === tasksBefore);

// 3. Push back: Approve with a note: the copy files the changes task in the fake office.
const cb = await scout(b, "approve", "pushback", "The new label is longer than the old one.", { copy: { "0": "keep it short" }, images: {} });
await decide(cb, { call: "approve", note: "Make the label shorter.", comments: JSON.stringify({ copy: { "0": "keep it short" }, images: {} }) });
const filed = await until("the changes task", async () => (await office()).tasks.find((t: any) => /Sign-off changes:/.test(t.title) && t.description.includes(b)), 60_000);
check("3. push back: Approve with a note files the changes task with the note and the comment", /Make the label shorter\./.test(filed.description) && /keep it short/.test(filed.description), filed.title);

// 4. Revert: the copy rejects; after its 60 s hold it messages Isomux Main with the exact text.
const cc = await scout(c, "revert", "pushback", "The footer link is gone.");
const commitC = await commitOf(c);
await decide(cc, { call: "revert", note: "The footer link is gone." });
await until(`${c} rejected on the copy`, async () => (await loopItems()).find((i) => i.taskId === c)?.state === "rejected", 60_000);
const want = `/isomux-main revert ${c} (${commitC}): Nil rejected it at sign-off: The footer link is gone.`;
const msg = await until("the revert message to Isomux Main", async () => (await office()).messages.find((m: any) => m.to === "agent-main-e2e" && m.text.includes(`revert ${c} `)), 100_000);
check("4. revert: after the hold the copy messages Isomux Main with the exact text", msg.text === want, msg.text);

// 5. Undo within the window: Revert, then Undo after the press and before the copy sends.
const cd = await scout(d, "revert", "look", "A test of Undo.");
await decide(cd, { call: "revert", note: "Undo me." });
await until(`${d} rejected on the copy`, async () => (await loopItems()).find((i) => i.taskId === d)?.state === "rejected", 60_000);
const u = await post(`${af}/api/cards/${cd.id}/undo`);
check("5. Undo inside the copy's hold is taken", u.status === 200, JSON.stringify(u.body));
await until(`${d} waiting again on the copy`, async () => (await loopItems()).find((i) => i.taskId === d)?.state === "waiting", 60_000);
await sleep(70_000);
check("5. after the Undo the copy sends no revert for it", !(await office()).messages.some((m: any) => m.text.includes(`revert ${d} `)));
const backD = (await cards()).filter((x) => x.subject === d && x.state === "open");
check("5. the item waits again on the same card", backD.length === 1 && backD[0].id === cd.id, JSON.stringify(backD.map((x) => x.id)));

// 6. A decision on the copy's own tab withdraws the open card.
const ce = await scout(e, "approve", "look", "Looks right.");
await post(`${loop}/api/signoff/${e}/approve`);
const w = await until(`${e} withdrawn`, async () => (await cards()).find((x) => x.id === ce.id && x.state === "withdrawn"), 60_000);
check("6. a decision on the copy's tab withdraws the card", !!w);

const st = await get(`${af}/api/status`);
check("status: no failed command, no replay difference", (st.failed as any[]).length === 0 && (st.replayDiffs as any[]).length === 0, JSON.stringify({ failed: st.failed.length, replayDiffs: st.replayDiffs.length }));
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
