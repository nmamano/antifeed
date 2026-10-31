import { afterAll, describe, expect, test } from "bun:test";
import { makeApi, MEMBER_HEADER } from "../src/api";
import { Blobs } from "../src/blobs";
import { engine, fileAndPrepare, packet, tempDir, cleanup } from "./helpers";

afterAll(cleanup);

const NIL = "m0000000";
function setup() {
  const dir = tempDir();
  const r = engine(dir);
  const api = makeApi({ engine: r.e, blobs: new Blobs(dir), member: NIL, base: "http://127.0.0.1:1" });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    api(new Request(`http://127.0.0.1:1${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body) }));
  return { ...r, api, call };
}

describe("human routes", () => {
  test("need Nil's member id; the event logs it", async () => {
    const { e, call } = setup();
    const card = await fileAndPrepare(e);
    const body = { version: 1, call: { choice: "go", priority: "P1" } };
    expect((await call("POST", `/api/cards/${card.id}/decide`, body)).status).toBe(403);
    expect((await call("POST", `/api/cards/${card.id}/decide`, body, { [MEMBER_HEADER]: "cb194e22" })).status).toBe(403);
    const ok = await call("POST", `/api/cards/${card.id}/decide`, body, { [MEMBER_HEADER]: NIL });
    expect(ok.status).toBe(200);
    expect(e.log.all().find((x) => x.type === "card.decided")).toMatchObject({ by: "human:Nil", member: NIL });
    expect((await call("POST", `/api/cards/${card.id}/undo`, undefined)).status).toBe(403);
    expect((await call("POST", "/api/policies/triage/decider", { config: { kind: "threshold", agent: { kind: "agent", model: "fake", criteria: "criteria.md" }, min: 0.9 } })).status).toBe(403);
    expect((await call("POST", `/api/cards/${card.id}/decide`, { version: 1, call: { choice: "go", priority: "P1" } }, { [MEMBER_HEADER]: NIL })).status).toBe(409);
  });
});

describe("agent routes", () => {
  test("the contract: read the command, start it, post its packet or result", async () => {
    const { e, call } = setup();
    e.sourceEvent({ project: "isomux", source: "board", type: "board.task.filed", subject: "t1", data: { title: "A", priority: "P1" } });
    const prep = [...e.commands.values()][0];
    expect(await (await call("GET", `/api/commands/${prep.id}`)).json()).toMatchObject({ type: "triage.prepare", state: "issued", params: { taskId: "t1" } });
    expect((await call("POST", `/api/commands/${prep.id}/start`)).status).toBe(200);
    expect((await call("POST", `/api/commands/${prep.id}/start`)).status).toBe(409);
    expect((await call("POST", "/api/cards", { command: prep.id, packet: packet(), meta: {} })).status).toBe(400);
    const posted = await call("POST", "/api/cards", { command: prep.id, packet: packet(), meta: { raw: "board:t1" } });
    expect(posted.status).toBe(201);
    const { card } = (await posted.json()) as { card: string };
    await e.settle();
    expect(((await (await call("GET", "/api/cards")).json()) as { cards: { id: string }[] }).cards.map((c) => c.id)).toEqual([card]);
    expect((await call("POST", `/api/commands/${prep.id}/result`, { ok: true })).status).toBe(200);
    expect(await (await call("POST", `/api/commands/${prep.id}/result`, { ok: true })).json()).toEqual({ duplicate: true });
    expect((await call("POST", `/api/commands/${prep.id}/result`, { ok: "yes" })).status).toBe(400);
    // Part G: the author's post with no command is the open card's new version; the author withdraws it.
    const again = await call("POST", "/api/cards", { policy: "triage", actor: "curator", subject: "t1", packet: packet(), meta: { raw: "board:t1" } });
    expect(await again.json()).toEqual({ card });
    expect((await call("POST", `/api/cards/${card}/withdraw`, { actor: "curator" })).status).toBe(400);
    expect((await call("POST", `/api/cards/${card}/withdraw`, { actor: "curator", reason: "a duplicate" })).status).toBe(200);
    expect((await call("POST", `/api/cards/${card}/withdraw`, { actor: "curator", reason: "a duplicate" })).status).toBe(409);
  });

  test("facts: a source's types and generic types are refused; a body that is not JSON is a 400", async () => {
    const { call } = setup();
    expect((await call("POST", "/api/events", { project: "isomux", from: "board", type: "board.task.closed", subject: "t1" })).status).toBe(403);
    expect((await call("POST", "/api/events", { project: "isomux", from: "curator", type: "card.decided" })).status).toBe(403);
    expect((await call("POST", "/api/events", "{not json")).status).toBe(400);
    expect((await call("GET", "/api/nothing")).status).toBe(404);
    expect((await call("GET", "/api/help")).status).toBe(200);
  });
});

describe("blobs", () => {
  test("a blob is stored by content and read with Range", async () => {
    const { call } = setup();
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5, 6]);
    expect((await call("POST", "/api/blobs", bytes, { "Content-Type": "text/html" })).status).toBe(400);
    const r = await call("POST", "/api/blobs", bytes, { "Content-Type": "image/png" });
    const { blob } = (await r.json()) as { blob: string };
    expect(blob).toMatch(/^[0-9a-f]{64}\.png$/);
    const full = await call("GET", `/api/blobs/${blob}`);
    expect([full.status, full.headers.get("accept-ranges"), (await full.arrayBuffer()).byteLength]).toEqual([200, "bytes", 10]);
    const part = await call("GET", `/api/blobs/${blob}`, undefined, { Range: "bytes=2-5" });
    expect([part.status, part.headers.get("content-range"), [...new Uint8Array(await part.arrayBuffer())]]).toEqual([206, "bytes 2-5/10", [78, 71, 1, 2]]);
    const tail = await call("GET", `/api/blobs/${blob}`, undefined, { Range: "bytes=-3" });
    expect([...new Uint8Array(await tail.arrayBuffer())]).toEqual([4, 5, 6]);
    expect((await call("GET", `/api/blobs/${blob}`, undefined, { Range: "bytes=20-" })).status).toBe(416);
    expect((await call("GET", "/api/blobs/../events.jsonl")).status).toBe(404);
  });
});
