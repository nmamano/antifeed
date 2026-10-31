// Antifeed page (DESIGN.md 13.2, 13.3). Plain JS, no build. Every tab renders
// from one view the page keeps in memory (GET /api/view, also inline in the
// HTML), so a tab switch makes no request. The page asks for the view again
// every 3 s (304 when nothing changed) and replaces only the parts whose
// content changed, so folds, focus and scroll stay. Status is fetched only
// while its tab is open.

const TABS = [
  ["queue", "Queue"],
  ["decided", "Decided"],
  ["accuracy", "Accuracy"],
  ["policies", "Policies"],
  ["setup", "Setup"],
  ["sources", "Sources"],
  ["status", "Status"],
  ["help", "Help"],
];
// On a phone, these tabs sit behind More.
const MORE_TABS = ["policies", "setup", "sources", "status", "help"];
// Round q1b, P3 and P6: Flow is Policies and Terms is Help; an old link still opens its tab.
const OLD_TABS = { numbers: "accuracy", flow: "policies", terms: "help" };
const newHash = (h) => {
  const [t, ...rest] = h.split("-");
  return OLD_TABS[t] ? [OLD_TABS[t], ...rest].join("-") : h;
};
// Nil, 2026-10-20: the Undo notice lasts 3 times longer (24 s). The engine
// holds an action's Done for the same time (ACTION_UNDO_MS).
const UNDO_MS = 24_000;
const UNDO_S = UNDO_MS / 1000 + " s";
const EFFORTS = ["S", "M", "L", "XL"];
const POLL_MS = 3_000;
const PT = "America/Los_Angeles";
// Inside the office page, the app's own chat (Antifeed PM) floats at the bottom right.
const FRAMED = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();
if (FRAMED) document.body.classList.add("framed");

let V = loopOpen(window.AF_VIEW || null);
let etag = null;
let tab = tabFromHash();
let cur = null; // the current card id
const picks = {}; // card id -> {v, call, note, option, err}
const shownAt = {}; // "id@version" -> ISO time the card first showed here
const reported = new Set(); // "id@version" sent as card.shown
const pending = new Set(); // cards decided here whose request is in flight
let toast = null;
let showKeys = false;
let lb = null;
let lbPushed = false; // the image viewer took a history step, so Back closes it
let curSince = 0; // when the current card last changed (performance.now())
// Confirm waits this long on a new current card, so a second press never
// decides a card Nil has not seen: 700 ms for a key, 1.5 s on a touch screen,
// where a re-tap lands on the next card's Confirm.
const TOUCH = window.matchMedia("(pointer: coarse)").matches;
// Round 9: the page says "tap" on a touch screen and "click" with a mouse.
const VERB = TOUCH ? "Tap" : "Click";
const verb = VERB.toLowerCase();
let lastPointer = TOUCH ? "touch" : "mouse"; // the kind of the last pointer press
window.addEventListener("pointerdown", (e) => (lastPointer = e.pointerType || lastPointer), true);
const guardMs = () => (lastPointer === "mouse" ? 700 : 1500);
// On a desktop, the call bar and the toast sit in the header, so they cover no card text.
const DESK = window.matchMedia("(min-width: 701px)");
const premoveSeen = new Set(); // "id@version" whose Premove zone was half on the screen
// V1: the bar's Confirm needs one act of Nil's on the current card first: a
// scroll he makes, a tap inside the card (not on its Confirm or Done), or
// Change it. A re-tap on the bar is none of these.
const acted = new Set(); // "id@version"; an action card: "id"
// Walk round 3: a new version of an action card (a page raised again, a new
// count) is the same action, so a card Nil read stays read.
const readKey = (c) => (isAction(c) ? c.id : c.id + "@" + c.version);
const actKey = () => {
  const c = cur && cardById(cur);
  return c ? readKey(c) : "";
};
// W1: an input that starts on the call bar, the header or the toast is no act.
const offCard = (e) => !!(e && e.target && e.target.closest && e.target.closest("[data-sticky], header, #toast, .keys, .lb"));
function markActed(e) {
  if (offCard(e)) return;
  const k = actKey();
  if (!k || acted.has(k) || fresh()) return;
  acted.add(k);
  stickyShow();
}
window.addEventListener("wheel", markActed, { passive: true });
window.addEventListener("touchmove", markActed, { passive: true });
window.addEventListener("keydown", (e) => ["PageDown", "PageUp", "ArrowDown", "ArrowUp", " ", "Home", "End"].includes(e.key) && !e.target.closest("textarea, input, button") && markActed(e), true);
// X1: a tap is an act only when it does something on the card: a pick, a
// tick, a fold, a link, an image, the focus of a field. Plain text and empty
// space are no act.
const ACTIVE = "button:not([data-confirm]):not([data-done]), summary, a, input, textarea, label, [data-lb]";
window.addEventListener("pointerdown", (e) => {
  const card = e.target.closest && e.target.closest("[data-card]");
  if (card && card.dataset.card === cur && e.target.closest(ACTIVE) && !strayTap(e)) markActed(e);
}, true);
// X1: a tap at the place of the last Confirm, within 3 s of it, is a second
// press of that Confirm: it does nothing on the next card (no pick, no focus,
// no act). N1: a press on a Confirm or Done goes on, as any press: readyFor
// stops it when that card is not ready, and says why, so a ready bar never
// drops a tap.
let lastConfirm = null; // {x, y, t}: where and when the last call went out
let pressXY = null; // where the last Confirm or Done press was
// Only a call that goes out sets the place (a press on a locked Confirm does not).
const sent = () => pressXY && (lastConfirm = { ...pressXY, t: performance.now() });
const strayTap = (e) => !!lastConfirm && performance.now() - lastConfirm.t < 3000 && Math.hypot(e.clientX - lastConfirm.x, e.clientY - lastConfirm.y) < 32;
for (const type of ["pointerdown", "mousedown", "click"])
  window.addEventListener(type, (e) => {
    if (e.target.closest && e.target.closest("[data-confirm], [data-done]")) {
      if (type === "click") {
        pressXY = { x: e.clientX, y: e.clientY };
        setTimeout(() => (pressXY = null), 0);
      }
      return;
    }
    if (strayTap(e) && !(e.target.closest && e.target.closest("#toast"))) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
// A mouse that travels over the current card (60 px or more) is an act too: a
// second click without a move is not.
let travel = 0;
let lastXY = null;
window.addEventListener("pointermove", (e) => {
  if (e.pointerType !== "mouse") return;
  const card = e.target.closest && e.target.closest("[data-card]");
  if (lastXY && card && card.dataset.card === cur) travel += Math.hypot(e.clientX - lastXY[0], e.clientY - lastXY[1]);
  lastXY = [e.clientX, e.clientY];
  if (travel >= 60) {
    travel = 0;
    markActed(e);
  }
}, { passive: true });
// W2: one gate for every path that confirms or finishes (the card's buttons,
// the bar, Ctrl+Enter, d): the guard, one act on the card, and its Premove seen.
// A page has details, not steps (walk round 3): "Read the page, then press Done."
const readFirst = (c) => (policyOf(c).actionLabel ? "Read the " + policyOf(c).actionLabel.replace(/ for you$/, "").toLowerCase() + ", then press Done." : "Read the steps, then press Done.");
function readyFor(c) {
  // Round 9: the words name the button the card has.
  if (!c || c.id !== cur || fresh()) return c && isAction(c) ? "Done is ready in a moment." : "Confirm is ready in a moment.";
  // The loop kind: Ctrl+Enter decides, as in the Loop app; only the stray-press guard holds.
  if (isLoop(c)) return "";
  const k = readKey(c);
  if (!acted.has(k)) return isAction(c) ? readFirst(c) : "Read the packet, then confirm.";
  checkSeen();
  if (!isAction(c) && c.prediction && !premoveSeen.has(k)) return "Confirm is ready once you have seen the Premove.";
  return "";
}
// Round 10: the line under Confirm or Done says why it waits, and then how
// long an Undo stays open. It keeps the height of its longest text (the two
// hidden pseudo-elements), so nothing below it moves when the button unlocks.
const readyLine = (c) => "You can undo " + (isAction(c) ? "Done" : "your call") + " for " + UNDO_S + ".";
// quiet (round Q1, C2): the line shows only after a press it refused, for a few seconds.
const hintLine = (c, quiet) =>
  '<p class="muted cfhint' + (quiet ? " quiet" : "") + '" data-cfhint role="status" data-s1="' + esc(isAction(c) ? readFirst(c) : "Confirm is ready once you have seen the Premove.") + '" data-s2="' + esc(readyLine(c)) + '">' + "<span>" + esc(readyFor(c) || readyLine(c)) + "</span></p>";
// Not ready: the reason under the card's Confirm (and in the bar) lights up;
// the toast and its Undo stay as they are.
function notReady(c) {
  const why = readyFor(c);
  if (why) {
    stickyShow();
    for (const h of document.querySelectorAll("[data-cfhint], [data-sticky] .sbhint")) {
      h.classList.remove("flash");
      void h.offsetWidth;
      h.classList.add("flash");
      if (h.classList.contains("quiet") || h.classList.contains("sbhint")) {
        clearTimeout(h.quietT);
        h.quietT = setTimeout(() => h.classList.remove("flash"), 4000);
      }
    }
  }
  return !!why;
}
let status = null;
let filtersOpen = false; // phones: the filters fold away
let moreOpen = false; // phones: the tabs behind More show
let remoteNotice = null; // V5: {id, text, q}: the current card moved on elsewhere
const texts = {}; // url -> text, or "loading", or {error}
const openFolds = new Set();
// The filters and the sort stay after a reload. The default sort is the
// Premove's priority, highest first. Queue round 1 (Nil, 2026-10-28): a view
// saved before it (af.view3) keeps its kinds, priority, effort and search; its
// sort maps to the new keys, and the filters that went (the Premove's call,
// against the board, filed by) are dropped. A value the page does not know
// falls back to the default.
const VIEW0 = { sort: "priority", dir: "high", kinds: [], floor: "", q: "", efforts: [], conf: [] };
const OLD_SORTS = { premove: ["priority", "high"], board: ["priority", "high"], oldest: ["age", "old"], newest: ["age", "new"], effort: ["effort", "low"] };
// Each sort key's directions, its default first (the labels are in SORTS).
const SORT_DIRS = { priority: ["high", "low"], age: ["new", "old"], effort: ["high", "low"], confidence: ["high", "low"] };
// A stored value that is not JSON reads as none (queue round 1: it blanked the page).
function stored(store, key, none) {
  try {
    const v = JSON.parse(store.getItem(key) || "null");
    return v === null ? none : v;
  } catch {
    return none;
  }
}
const view = (() => {
  const saved = stored(localStorage, "af.view4", null);
  const old = saved && typeof saved === "object" ? null : stored(localStorage, "af.view3", {});
  const v = { ...VIEW0, ...(saved && typeof saved === "object" ? saved : {}) };
  if (old) {
    for (const k of ["kinds", "floor", "q", "efforts"]) if (old && typeof old === "object" && k in old) v[k] = old[k];
    [v.sort, v.dir] = OLD_SORTS[old.sort] || [VIEW0.sort, VIEW0.dir];
  }
  for (const k of ["efforts", "conf", "kinds"]) if (!Array.isArray(v[k])) v[k] = [];
  // F2: the bands changed (90%+, 70-90% went); a saved band the page does not have is dropped.
  v.conf = v.conf.filter((x) => ["70", "50", "low", "none"].includes(x));
  if (typeof v.q !== "string") v.q = "";
  if (!["", "P0", "P1", "P2", "P3"].includes(v.floor)) v.floor = "";
  if (!SORT_DIRS[v.sort]) [v.sort, v.dir] = [VIEW0.sort, VIEW0.dir];
  if (!SORT_DIRS[v.sort].includes(v.dir)) v.dir = SORT_DIRS[v.sort][0];
  const out = Object.fromEntries(Object.keys(VIEW0).map((k) => [k, v[k]]));
  // The old view is read once: the new one takes its place.
  if (old) {
    localStorage.setItem("af.view4", JSON.stringify(out));
    localStorage.removeItem("af.view3");
  }
  return out;
})();
const stale = {}; // tab -> true when the view changed since it was drawn
const parts = {}; // tab -> key -> html it holds now
window.AF_TIMES = [];

function tabFromHash() {
  const h = newHash(location.hash.slice(1).split(/[?]/)[0]).split("-")[0];
  return TABS.some(([k]) => k === h) ? h : "queue";
}

// ---- helpers -------------------------------------------------------------

// The task id Copy put on the clipboard, and until when its button says "Copied".
let copied = { text: null, until: 0 };
// An element's html is set only when it changes, compared with what was set
// (not innerHTML, which a held-aside tooltip title changes), so a control
// under the mouse is not replaced for nothing.
function setHtml(el, html) {
  if (el._html === html) return;
  el._html = html;
  el.innerHTML = html;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const $ = (sel) => document.querySelector(sel);
function ago(iso) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return mins < 1 ? "just now" : mins < 60 ? mins + " min ago" : mins < 1440 ? Math.round(mins / 60) + " h ago" : Math.round(mins / 1440) + " d ago";
}
function ptTime(iso) {
  if (!iso) return "";
  const abs = new Date(iso).toLocaleString("en-US", { timeZone: PT, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return '<span title="' + esc(abs) + ' PT">' + esc(ago(iso)) + "</span>";
}
const pct = (x) => Math.round(x * 100) + "%";
// The page's words for a value; the log keeps the raw value (Nil, 2026-10-19: "on hold", not "hold").
const VALUE_WORDS = { hold: "on hold", "file-task": "file as a task" };
const valueLabel = (v) => (v === null ? "none" : VALUE_WORDS[v] || String(v));

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || method + " " + path + " answered " + res.status);
  return data;
}

function md(src) {
  const lines = esc(src).split("\n");
  let out = "";
  let inList = false;
  let inCode = false;
  for (const raw of lines) {
    if (raw.startsWith("```")) {
      out += inCode ? "</pre>" : (inList ? "</ul>" : "") + '<pre class="code">';
      inList = false;
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out += raw + "\n";
      continue;
    }
    const l = raw
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const li = l.match(/^\s*[-*] (.*)$/);
    if (li) {
      out += (inList ? "" : "<ul>") + "<li>" + li[1] + "</li>";
      inList = true;
      continue;
    }
    if (inList) {
      out += "</ul>";
      inList = false;
    }
    const hd = l.match(/^(#{1,4}) (.*)$/);
    out += hd ? '<div class="mdh">' + hd[2] + "</div>" : l.trim() ? "<p>" + l + "</p>" : "";
  }
  return '<div class="mdbody">' + out + (inList ? "</ul>" : "") + (inCode ? "</pre>" : "") + "</div>";
}

function diff(unified) {
  return (
    '<pre class="diff">' +
    unified
      .split("\n")
      .map((l) => {
        const cls = l.startsWith("@@") ? "hunk" : l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : "";
        return cls ? '<span class="' + cls + '">' + esc(l) + "</span>" : esc(l);
      })
      .join("\n") +
    "</pre>"
  );
}

// A word the Help tab explains, in a heading or a label (round q1b, P9): a
// dotted underline, and its one-line definition as a tooltip (a tap on a
// phone). A click with a mouse opens its Help entry. Only the first one of
// each word in a region keeps the underline (dedupeTerms).
const T = (key, label) => {
  const d = TERMS.find((x) => x[0] === key);
  return '<a class="term" href="#help-' + key + '" data-term="' + key + '"' + (d ? ' title="' + esc(d[1] + ": " + d[2]) + '"' : "") + ">" + label + "</a>";
};
// A region is a .tregion, or else a part of the tab.
function dedupeTerms(root) {
  const seen = new Map();
  for (const a of [...root.querySelectorAll("a.term[data-term]")]) {
    const r = a.closest(".tregion, [data-part]") || root;
    if (!seen.has(r)) seen.set(r, new Set());
    const s = seen.get(r);
    if (s.has(a.dataset.term)) a.replaceWith(...a.childNodes);
    else s.add(a.dataset.term);
  }
}

// ---- the view ---------------------------------------------------------------

const cards = () => (V ? V.cards : []);
const cardById = (id) => cards().find((c) => c.id === id);
const policyOf = (c) => (V && V.policies.find((p) => p.id === c.policy)) || { id: c.policy, name: c.policy, color: "#777777", answer: {}, primary: [] };
const fields = (pol) => Object.entries(pol.answer || {}).filter(([k]) => k !== "note");
const projectOf = (name) => V && V.projects.find((p) => p.project === name);
const consultOf = (project) => (projectOf(project) || {}).consult || null;
const consultName = (project) => {
  const c = consultOf(project);
  return c && c.agent ? c.agent.name : "the Predictor";
};
// The consult agent of a card: its project's (Nil, 2026-10-28: one per project, in its room).
const consultAgentOf = (c) => {
  const k = consultOf(c.project);
  return k && k.agent ? k.agent : null;
};
// The office link to an agent's own chat.
const agentChat = (a) => (V && V.officeUrl && a && a.id ? V.officeUrl + "/agents/" + encodeURIComponent(a.id) : "");
const chatAgent = () => (V && V.chatAgent) || "the agent in Chat";
// Round q1, H2 (Nil: "like with inter-agent messaging in isomux"): an agent's
// name as its avatar and name, a link to its office chat in a new tab. A name
// that is not a live office agent stays plain text.
const AV_HUES = [12, 35, 150, 190, 215, 255, 285, 320];
function agentChip(name) {
  const a = name && V && V.agents && V.agents[name];
  const href = a && agentChat(a);
  if (!href) return esc(name);
  const ini = String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  let h = 0;
  for (const ch of a.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return '<a class="agent" href="' + esc(href) + '" target="_blank" rel="noopener" title="Open the chat of ' + esc(name) + (a.room ? " (" + esc(a.room) + ")" : "") + ' in the office"><span class="av" style="--avh:' + AV_HUES[h % AV_HUES.length] + '" aria-hidden="true">' + esc(ini) + "</span>" + esc(name) + "</a>";
}
const cap = (t) => (t ? String(t)[0].toUpperCase() + String(t).slice(1) : "");
const actorName = (ref) => (String(ref || "").startsWith("agent:") ? String(ref).slice(6) : "");

// A kind names its project only when two loaded projects have a kind of that
// name ("Triage (Isomux)"), so the Kind filter tells them apart (L65; slice 7 walk).
const kindName = (p) => (V && !p.builtin && p.project && V.policies.some((x) => x !== p && !x.builtin && x.name === p.name && x.project !== p.project) ? p.name + " (" + (p.projectName || cap(p.project)) + ")" : p.name);
function kindOf(c) {
  const p = policyOf(c);
  // Slice 7: a page from the office has its own chip ("Page for you").
  if (c.kind === "action") return p.actionLabel ? { name: p.actionLabel, color: p.color } : { name: "Action for you", color: "var(--warn)" };
  return { name: kindName(p), color: p.color };
}
function kindChip(c) {
  const k = kindOf(c);
  return '<span class="kind" style="--kc:' + esc(k.color) + '">' + esc(k.name) + "</span>";
}
// The question without a "Triage:" style prefix: the kind chip says it.
function questionOf(c) {
  const q = (c.packet && c.packet.question) || "";
  const k = kindOf(c).name;
  const m = q.match(/^([A-Za-z ]{2,24}):\s+(.*)$/s);
  return m && (k.toLowerCase().startsWith(m[1].toLowerCase()) || /^(triage|reply|design|design question|action)$/i.test(m[1])) ? cap(m[2]) : q;
}

// Who made a Premove, in plain words. The raw id shows only in "How this Premove was made".
// basis: the code stand-in's tier, from its reason or from a calibration row.
const TEST_COPY = "in this test copy, a script plays it";
const BASIS = { vote: "a vote of your past calls", author: "the packet creator's pick", none: "a safe default" };
// The code stand-in's tier: stored as data (standin.basis); older ones by their reason.
const basisOf = (p) => (p && p.standin && p.standin.basis) || (String((p && p.why) || "").startsWith("No basis") ? "none" : String((p && p.why) || "").startsWith("The author's pick") ? "author" : "vote");
// The short name, with no test-copy note: the zone label carries that note once.
const shortLabel = (p, basis) => predictorLabel(p, basis).replace(" (" + TEST_COPY + ")", "");
function predictorLabel(p, basis) {
  const b = String((p && p.by) || p || "");
  let m = b.match(/^agent:standin@([^#]+)/);
  if (m) return m[1] === "walkthrough-fake" ? "a quick model run (" + TEST_COPY + ")" : "a quick model run (" + cap(m[1]) + ")";
  if (b === "code:standin") return BASIS[basis || basisOf(p)];
  if (b === "code:walkthrough-stub") return "the Predictor (" + TEST_COPY + ")";
  // Walk round 3: the rule that gave this call, by the call it gave. Walk 2:
  // with no call (Accuracy), all four rules, in the same names.
  if (b === "code:retry-once") {
    if (!p || !p.call) return "the retry rules: retry a first failure; drop a failed retry; no retry while the cause holds; no retry when it may have gone out";
    return "a retry rule: " + (p.call.choice !== "drop" ? "retry a first failure" : /cause holds/.test(p.why || "") ? "no retry while the cause holds" : /may have gone/.test(p.why || "") ? "no retry when it may have gone out" : "drop a failed retry");
  }
  m = b.match(/^agent:predictor@([^#]+)/);
  if (m) return "a model run (" + m[1] + ")";
  m = b.match(/^agent:([^@]+)@([^#]+)/);
  if (m) return m[1];
  if (b.startsWith("code:")) return "a rule in the policies file";
  return b.replace(/^agent:/, "");
}
// N1 (round Q1): Antifeed's own logged words (stand-in reasons, the Inbox's
// reasons, send results) say "card"; the page says "packet", and "action" for
// an action card. Old log lines too. Never for a packet's own content.
const packetWords = (t) =>
  String(t || "")
    .replace(/\b([Aa])n action card\b/g, "$1n action")
    .replace(/\baction cards\b/g, "actions")
    .replace(/\bcards\b/g, "packets")
    .replace(/\bcard\b/g, "packet")
    .replace(/\bCard\b/g, "Packet");
// Old log lines name the stand-in with developer words: the page says it plainly.
const plain = (t) =>
  packetWords(t)
    .replace(/^(.*) did not start within (\d+) s \(busy\)/, "$1 was busy: it did not start within $2 s")
    .replace(/the walkthrough's fake claude -p has no answer for this card/g, "in this test copy, the script that plays it has no answer for this packet")
    .replace(/the claude -p stand-in/g, "the quick model run");
const isStandin = (p) => !!(p && p.standin);
// G0 (round Q1): the code stand-in's logged words (src/standin.ts) in Nil's
// role words, the packet creator by name. Old log lines too.
const standinWords = (t, c) =>
  plain(t)
    .replace(/the consult agent/g, "the Predictor")
    .replace(/\bthe author named no pick/g, () => (authorOf(c) || "the packet creator") + " named no pick")
    .replace(/\b[Tt]he author's (pick|view)/g, (m, w) => (/^T/.test(m) ? cap(pickName(c).replace(/pick$/, w)) : pickName(c).replace(/pick$/, w)));
const ownWords = (p, c, t) => (p && p.by === "code:standin" ? standinWords(t, c) : String(t || ""));
// The safe default: no basis, so it is never filled in as Nil's call.
const noBasis = (p) => p && p.by === "code:standin" && basisOf(p) === "none";
// The packet's author by name (C3: Nil, "Which author?"): the agent that wrote
// it, else who filed or sent it.
const authorOf = (c) => (c && c.meta && (actorName(c.meta.author) || c.meta.createdBy || c.meta.source)) || "";
const pickName = (c) => (authorOf(c) ? authorOf(c) + "'s pick" : "the packet creator's pick");
// "82% sure", "no basis", or the author's pick: the same words on every row and
// card (G4). As [before, the part that changes, after], so the page can set
// the changing part in bold (G1).
function confParts(p, c) {
  if (noBasis(p)) return ["no basis", "", ""];
  if (p.by === "code:standin" && basisOf(p) === "author") return authorOf(c) ? ["", authorOf(c), "'s pick"] : ["the packet creator's pick", "", ""];
  if (p.by === "code:standin") return ["", pct(p.confidence), " of similar past calls"];
  return ["", pct(p.confidence), " sure"];
}
const confText = (p, c) => confParts(p, c).join("");
// N3: on the card's Premove (term), "sure" is the dotted term for confidence.
const confHtml = (p, c, term) => { const [a, b, z] = confParts(p, c); return esc(a) + (b ? "<span class=dv>" + esc(b) + "</span>" : "") + (term && z === " sure" ? " " + T("confidence", "sure") : esc(z)); };
const fieldLabel = (k, f) => (f && f.label) || cap(k);

function draftsOf(blocks, out = {}) {
  for (const b of blocks || []) {
    if (b.type === "draft") out[b.key] = b.text;
    if (b.type === "fold") draftsOf(b.blocks, out);
  }
  return out;
}

// A card starts with the Premove filled in, and the option it names picked,
// with that option's note; a new version starts again. The safe default is
// never filled in: with no basis, Nil's call starts empty.
// Picks stay after a confirm, so an Undo brings the note back.
function premoveCall(c) {
  const call = {};
  if (noBasis(c.prediction)) return call;
  for (const [k] of fields(policyOf(c))) if (c.prediction && c.prediction.call && k in c.prediction.call) call[k] = c.prediction.call[k];
  return call;
}
// Picks are kept in this tab's session too, so a reload keeps ticks, notes and edits.
function savePicks() {
  clearTimeout(savePicks.t);
  savePicks.t = setTimeout(() => sessionStorage.setItem("af.picks", JSON.stringify(picks)), 300);
}
Object.assign(picks, JSON.parse(sessionStorage.getItem("af.picks") || "{}"));
// A card Nil took back with Undo starts with his own call from the log (the
// view's `undone`), on any device; picks made here since come first.
function pickOf(c) {
  const p = picks[c.id];
  if (p && p.v === c.version) return p;
  if (c.undone && c.undone.version === c.version && !isAction(c)) return fromCall(c, c.undone.call, c.undone.option);
  // A loop-kind card starts from the packet creator's pick; a pick with no
  // priority for a choice that takes one starts from the board's (the Loop app).
  if (isSO(c)) {
    const o = loopPick(c);
    return (picks[c.id] = { v: c.version, call: { call: (o && o.fill && o.fill.call) || "approve" }, note: "", comments: { copy: {}, images: {} }, option: o ? o.id : null, from: null, err: "", auto: "", ticks: {}, armed: false });
  }
  if (isLoop(c)) {
    const o = loopPick(c);
    const call = { choice: null, priority: null, title: null, scope: null, ...((o && o.fill) || {}) };
    delete call.note;
    const board = c.subjectInfo && c.subjectInfo.priority;
    if (takesPriority(call.choice) && !call.priority && /^P[0-3]$/.test(board || "")) call.priority = board;
    return (picks[c.id] = { v: c.version, call, note: "", option: o ? o.id : null, from: null, err: "", auto: "", ticks: {}, armed: false, rewrite: false });
  }
  const call = premoveCall(c);
  Object.assign(call, draftsOf(c.packet && c.packet.blocks));
  const opt = premoveOption(c);
  return (picks[c.id] = { v: c.version, call, note: (opt && opt.fill.note) || "", option: opt ? opt.id : null, from: shapeFrom(c), err: "", auto: "", ticks: {}, armed: false });
}
// Picks from a call that went out: its fields and draft text, its note, its option.
function fromCall(c, d, option) {
  const call = { ...(d || {}) };
  delete call.note;
  const old = picks[c.id];
  // Part J: a sign-off call's comments come back with it.
  const comments = "comments" in call ? soComments(call.comments) : null;
  if (comments) delete call.comments;
  return (picks[c.id] = { v: c.version, call, note: (d && d.note) || "", ...(comments ? { comments } : {}), option: option || null, from: option || null, err: "", auto: "", ticks: (old && old.ticks) || {}, armed: false, restored: true });
}
// Back to the Premove: every field, the drafts and texts as the packet has
// them, the Premove's option, and its note (or none).
function resetToPremove(c) {
  const p = pickOf(c);
  const opt = premoveOption(c);
  p.call = { ...premoveCall(c), ...draftsOf(c.packet && c.packet.blocks) };
  p.note = (opt && opt.fill.note) || "";
  p.option = opt ? opt.id : null;
  p.from = shapeFrom(c);
  p.auto = "";
  p.err = "";
  p.errField = null;
  p.restored = false;
}
// "B" and "Withdraw it at the next board read" from "B. Withdraw it at the next board read".
const optLetter = (o) => String(o.id).toUpperCase();
const optText = (o) => String(o.label).replace(/^[A-Za-z0-9]{1,2}[.)]\s*/, "");

// A field marked inLine "option" (triage's scope) shows as the label of the
// option that fills it, or "own scope"; with no card, not at all.
const inLineText = (k, f, v, c) => {
  if (v == null || v === "" || !c) return null;
  const o = ((c.packet && c.packet.options) || []).find((x) => x.fill[k] === v);
  return o ? optText(o) : "own " + fieldLabel(k, f).toLowerCase();
};
const callText = (pol, call, c) =>
  c && isLoop(c) && call ? loopSummary(call) :
  fields(pol)
    .map(([k, f]) => call && (f.enum ? (call[k] === null ? null : call[k] === undefined ? undefined : valueLabel(call[k])) : f.inLine === "option" ? inLineText(k, f, call[k], c) : call[k]))
    .filter((v) => v !== undefined && v !== null && v !== "")
    .join(" · ") || "no fields";

// The policy's field rules, as the engine checks them (src/validate.ts checkRules).
// Returns [message, the field to mark] or null.
function ruleError(pol, call) {
  for (const [k, f] of fields(pol)) {
    if (f.enum && !f.enum.includes(null) && !(k in call && call[k] !== undefined)) return ["Pick " + (/^[aeiou]/.test(fieldLabel(k, f).toLowerCase()) ? "an " : "a ") + fieldLabel(k, f).toLowerCase() + ".", k];
    for (const [o, vals] of Object.entries(f.needs || {})) if (vals.includes(call[o] ?? null) && (call[k] ?? null) === null) {
        // Slice 7: a text field is written, not picked; a plural label takes no article.
        const l = fieldLabel(k, f).toLowerCase();
        const many = /s$/.test(l);
        return [cap(valueLabel(call[o])) + " needs " + (many ? "" : "a ") + l + ": " + (f.text ? "write " + (many ? "them" : "it") : "pick one") + " here.", k];
      }
    for (const [o, vals] of Object.entries(f.noneWith || {})) if (vals.includes(call[o] ?? null) && (call[k] ?? null) !== null) return [cap(valueLabel(call[o])) + " takes no " + fieldLabel(k, f).toLowerCase() + ": pick none here.", k];
  }
  return null;
}
// After a pick: a field that must be empty empties; a field that needs a value
// takes the card's own value when it has one (go on a P2 card: P2).
// The field Nil just set is left as he set it. p.auto says what changed, so
// nothing changes without a word.
function settle(c, p, set) {
  const pol = policyOf(c);
  const said = [];
  for (const [k, f] of fields(pol)) {
    if (k === set) continue;
    for (const [o, vals] of Object.entries(f.noneWith || {}))
      if (vals.includes(p.call[o] ?? null) && (p.call[k] ?? null) !== null) {
        p.call[k] = null;
        said.push(cap(valueLabel(p.call[o])) + " takes no " + fieldLabel(k, f).toLowerCase() + ", so it is now none.");
      }
    for (const [o, vals] of Object.entries(f.needs || {}))
      if (vals.includes(p.call[o] ?? null) && (p.call[k] ?? null) === null) {
        const own = c.meta && c.meta[k];
        if (own && f.enum && f.enum.includes(own)) {
          p.call[k] = own;
          said.push(cap(valueLabel(p.call[o])) + " needs a " + fieldLabel(k, f).toLowerCase() + ": " + own + ", from the board.");
        }
      }
  }
  if (said.length) p.auto = said.join(" ");
}

// The option the Premove's call is, if any.
// A shape policy (a field marked inLine "option", triage's scope): the option
// Nil starts from is the one whose texts the Premove's call holds, as the
// engine finds it (src/decisions.ts premoveOption); other policies: the
// Premove's option.
function shapeFrom(c) {
  const keys = fields(policyOf(c)).filter(([k, f]) => f.inLine === "option" && ((c.packet && c.packet.options) || []).some((o) => typeof o.fill[k] === "string")).map(([k]) => k);
  if (!keys.length) {
    const o = premoveOption(c);
    return o ? o.id : null;
  }
  const p = c.prediction;
  if (!p || noBasis(p) || !p.call) return null;
  const o = ((c.packet && c.packet.options) || []).find((x) => keys.every((k) => typeof x.fill[k] === "string" && x.fill[k] === p.call[k]));
  return o ? o.id : null;
}
function premoveOption(c) {
  const p = c.prediction;
  const opts = (c.packet && c.packet.options) || [];
  if (!p || !opts.length || noBasis(p)) return null;
  return opts.find((o) => fields(policyOf(c)).every(([k]) => !(k in o.fill) || (o.fill[k] ?? null) === (p.call[k] ?? null)) && Object.keys(o.fill).some((k) => k !== "note")) || null;
}

// Keys for the current card: the first letter of each value of the primary
// field, and digits for a field whose values end in a digit (P0-P3).
function keyMap(c) {
  const pol = policyOf(c);
  const map = {};
  const taken = new Set(["j", "k", "a", "p", "n", "e", "w", "r", "l", "u", "f", "y"]);
  const primary = (pol.primary || [])[0] || (fields(pol)[0] || [])[0];
  for (const [k, f] of fields(pol)) {
    if (!f.enum) continue;
    if (k === primary)
      for (const v of f.enum) {
        const ch = v && String(v)[0].toLowerCase();
        if (ch && !taken.has(ch) && !Object.values(map).some((m) => m.key === ch)) map[ch] = { field: k, value: v, key: ch };
      }
    else if (f.enum.every((v) => v === null || /\d$/.test(String(v))))
      for (const v of f.enum) if (v !== null) map[String(v).slice(-1)] = { field: k, value: v, key: String(v).slice(-1) };
  }
  return map;
}

// ---- the queue ----------------------------------------------------------------

const isAction = (c) => c.kind === "action";
// The facts the sorts and filters read, for one card (L57, L58).
const rank = (p) => (/^P\d$/.test(String(p || "")) ? Number(String(p).slice(1)) : null);
const primaryOf = (c) => { const pol = policyOf(c); return (pol.primary || [])[0] || (fields(pol)[0] || [])[0]; };
// The Premove's call (its primary field), or null with no Premove or no basis.
const premoveChoice = (c) => (c.prediction && !noBasis(c.prediction) && c.prediction.call ? (c.prediction.call[primaryOf(c)] ?? null) : null);
// The Premove's priority as a rank: backlog is P4, obsolete after it.
function premoveRank(c) {
  const p = c.prediction;
  if (!p || noBasis(p) || !p.call) return null;
  const ch = premoveChoice(c);
  if (ch === "backlog") return 4;
  if (ch === "obsolete") return 5;
  return rank(p.call.priority);
}
// A card whose call sets a priority is about a board task, which may have none yet.
const onBoard = (c) => !isAction(c) && "priority" in (policyOf(c).answer || {});
const effortOf = (c) => (c.meta && EFFORTS.includes(c.meta.effort) ? c.meta.effort : "?");
// The Premove's confidence in whole percent, rounded as its "45% sure" text
// (pct), or null when the card shows no percent: no Premove, no basis (the safe
// default), or the packet creator's pick (Antifeed PM, 2026-10-28).
const confOf = (c) => { const p = c.prediction; return p && !noBasis(p) && !(p.by === "code:standin" && basisOf(p) === "author") && typeof p.confidence === "number" ? Math.round(p.confidence * 100) : null; };
// F2 (Antifeed PM, 2026-10-29): live Premoves are mostly 30-65% sure, so the bands are 70%+, 50-69%, under 50%.
const CONFS = [
  ["70", "70%+", "The Premove is 70% sure or more", (x) => x !== null && x >= 70],
  ["50", "50-69%", "The Premove is 50% to 69% sure", (x) => x !== null && x >= 50 && x < 70],
  ["low", "Under 50%", "The Premove is less than 50% sure", (x) => x !== null && x < 50],
  ["none", "None", "The packet shows no percent: it has no Premove yet, or its stand-in is the packet creator's pick or has no basis", (x) => x === null],
];
// Queue round 1 (Nil, 2026-10-28): four sort keys, each in both directions. A
// key's first direction is its default. A card with no value for the key comes
// last in both directions; ties: the card that came into the queue first.
const SORTS = [
  ["priority", "Priority", "The Predictor's priority (backlog and obsolete after P3)", [["high", "Highest first", "highest priority first"], ["low", "Lowest first", "lowest priority first"]]],
  ["age", "Age", "How long the packet is in the queue (from when it came in)", [["new", "Newest first", "newest first"], ["old", "Oldest first", "oldest first"]]],
  ["effort", "Effort", "The packet creator's estimate of the work", [["high", "Largest first", "largest effort first"], ["low", "Smallest first", "smallest effort first"]]],
  ["confidence", "Confidence", "How sure the Premove is", [["high", "Most sure first", "most sure first"], ["low", "Least sure first", "least sure first"]]],
];
const sortOf = () => SORTS.find((s) => s[0] === view.sort) || SORTS[0];
const dirOf = () => { const s = sortOf(); return s[3].find((d) => d[0] === view.dir) || s[3][0]; };
const cardTime = (c) => (c.meta && c.meta.openedAt) || "";
const SORT_VALUE = { priority: premoveRank, age: (c) => cardTime(c) || null, effort: (c) => (EFFORTS.includes(effortOf(c)) ? EFFORTS.indexOf(effortOf(c)) : null), confidence: confOf };
const kindKey = (c) => (isAction(c) ? "action" : c.policy);
// The filters of a view (the page's, or one with a single row changed, for a chip's count).
function matcher(v) {
  const q = v.q.trim().toLowerCase();
  // Nil's feedback (LOOP-APP-FEEDBACK.md, 2026-10-20): a priority floor never
  // hides a card with no priority; it needs him as much as any. Queue round 1:
  // the floor reads the Premove's priority (backlog P4, obsolete P5).
  const floor = rank(v.floor);
  // An action for you passes every filter but Kind and search, and comes first: only you can do it.
  return (c) =>
    (!v.kinds.length || v.kinds.includes(kindKey(c))) &&
    (isAction(c) ||
      ((floor === null || premoveRank(c) === null || premoveRank(c) <= floor) &&
        (!v.efforts.length || v.efforts.includes(effortOf(c))) &&
        (!v.conf.length || CONFS.some(([k, , , ok]) => v.conf.includes(k) && ok(confOf(c)))))) &&
    (!q || JSON.stringify([c.packet, c.subject, c.id, c.meta]).toLowerCase().includes(q));
}
// The open cards (a held action is in Decided, waiting for its Undo time).
const openCards = () => cards().filter((c) => !pending.has(c.id) && !c.held && c.state === "open");
// F2: how many cards a pick would show, with the other filters as they are.
// Only the Kind row counts the actions for you: they pass the other rows.
const countWith = (patch, kindRow) => {
  const m = matcher({ ...view, ...patch });
  return openCards().filter((c) => (kindRow || !isAction(c)) && m(c)).length;
};
function queueLists() {
  const later = laterIds();
  const match = matcher(view);
  // A held action is in Decided, waiting for its Undo time.
  const live = cards().filter((c) => !pending.has(c.id) && !c.held);
  const open = live.filter((c) => c.state === "open");
  let list = open.filter(match);
  const older = (a, b) => cardTime(a).localeCompare(cardTime(b));
  const key = sortOf()[0];
  // Ascending values: P0 before P3 is "highest first"; for the other keys "highest" or "newest first" is descending.
  const asc = (key === "priority") === (dirOf() === sortOf()[3][0]);
  const by = (a, b) => {
    const x = SORT_VALUE[key](a);
    const y = SORT_VALUE[key](b);
    if (x === null || y === null) return (x === null) - (y === null) || older(a, b);
    const d = key === "age" ? x.localeCompare(y) : x - y;
    return (asc ? d : -d) || older(a, b);
  };
  list.sort((a, b) => (isAction(b) ? 1 : 0) - (isAction(a) ? 1 : 0) || by(a, b));
  list = [...list.filter((c) => !later.includes(c.id)), ...list.filter((c) => later.includes(c.id))];
  const waiting = live.filter((c) => (c.state === "predicting" || (c.state === "preparing" && !c.decision)) && match(c));
  return { list, waiting, total: open.length, open };
}
const filtersOn = () => view.kinds.length > 0 || !!view.floor || !!view.q.trim() || view.efforts.length > 0 || view.conf.length > 0;
const laterIds = () => { const l = stored(sessionStorage, "af.later", []); return Array.isArray(l) ? l : []; };

// Round 9: the filters fold away on every screen. One line says what shows:
// the filters that are on (they stay after a reload), and the sort. Queue
// round 1 (G1): the dynamic words are bold; the static words stay regular.
const B = (t) => "<span class=dv>" + esc(t) + "</span>";
const orList = (xs) => xs.map(B).join(" or ");
// Queue round 1 (PM's look): on a desktop, Search sits on the first row, right of the summary; on a phone, last in the filters.
const searchBox = () => '<input type="search" data-view="q" placeholder="Search" value="' + esc(view.q) + '" aria-label="Search the queue" title="Search the question, the packet and the task id">';
function filterNote(total, shownN) {
  const order = B(dirOf()[2]);
  const kept = keptDraft && keptDraft === cur ? ' <span data-kept>The open packet stays open: you started a call on it.</span>' : "";
  const search = filtersOpen && DESK.matches ? searchBox() : "";
  const toggle = '<button class="btn small filtertoggle" data-filters aria-expanded="' + filtersOpen + '" title="Filter the queue, search it, or change its order (/)">' + (filtersOpen ? "Hide filters" : "Filters and sort") + '</button><button class="btn small hidetouch" data-keys title="The keys for this packet (?)">Keys</button>';
  if (!filtersOn()) return '<div class="qhead">' + toggle + '<span class="muted dyn">' + B(total) + " " + (total === 1 ? "packet" : "packets") + ", " + order + "." + kept + "</span>" + search + "</div>";
  const what = [];
  if (view.kinds.length) what.push("kind " + orList(view.kinds.map((k) => (k === "action" ? "Action for you" : kindName(V.policies.find((p) => p.id === k) || { id: k, name: k })))));
  if (view.floor) what.push("Predictor's priority " + B(view.floor === "P0" ? "P0" : "P0-" + view.floor));
  if (view.efforts.length) what.push("packet creator's effort " + orList(view.efforts.map((e) => (e === "?" ? "no estimate" : e))));
  // The None chip reads "no confidence"; with bands too, "confidence 90%+ or none".
  if (view.conf.length) {
    const bands = CONFS.filter((x) => x[0] !== "none" && view.conf.includes(x[0])).map((x) => x[1].toLowerCase());
    const none = view.conf.includes("none");
    what.push(bands.length ? "confidence " + orList(none ? [...bands, "none"] : bands) : B("no confidence"));
  }
  if (view.q.trim()) what.push("search " + B('"' + view.q.trim() + '"'));
  const narrows = view.floor || view.efforts.length || view.conf.length;
  return '<div class="qhead filtnote">' + toggle + '<span class="dyn">Filters on: ' + what.join(", ") + ". " + B(shownN) + " of " + B(total) + " " + (total === 1 ? "packet" : "packets") + ", " + order + "." + (narrows && (!view.kinds.length || view.kinds.includes("action")) ? " Actions for you pass every filter but Kind and search." : "") + kept + "</span>" + search + '<button class="btn small" data-clear title="Show every card; the order stays">Clear filters</button></div>';
}

function controls(total, shownN, open) {
  // Every kind the projects declare, so the bar does not move as cards run out.
  const kinds = V.policies.filter((p) => p.answer && !p.builtin).map((p) => ({ key: p.id, name: kindName(p), color: p.color }));
  kinds.sort((a, b) => a.name.localeCompare(b.name));
  kinds.unshift({ key: "action", name: "Action for you", color: "var(--warn)" });
  if (cards().some((c) => c.policy === "command-failed")) kinds.push({ key: "command-failed", name: "Failed command", color: (V.policies.find((p) => p.id === "command-failed") || {}).color || "#b4441c" });
  // F2 (Antifeed PM, 2026-10-29): a chip or a priority segment shows how many cards it would show.
  // All has no count (the summary has the total); the sort segments have none.
  const num = (n) => ' <span class="cnt">' + n + "</span>";
  const seg = (key, opts, counts) => '<span class="seg" role="group">' + opts.map(([v, l, tip]) => '<button data-seg="' + key + '" data-v="' + esc(v) + '" class="' + (view[key] === v ? "on" : "") + '" aria-pressed="' + (view[key] === v) + '"' + (tip ? ' title="' + esc(tip) + '"' : "") + ">" + esc(l) + (counts && v !== "" ? num(counts(v)) : "") + "</button>").join("") + "</span>";
  // A chip row with many picks: a chip adds or removes its value; All (last, G3) clears the row.
  const multi = (key, label, opts, tip) =>
    '<div class="control"><span class="clabel" title="' + esc(tip) + '">' + label + "</span>" +
    opts.map(([v, l, t]) => '<button class="kchip all' + (view[key].includes(v) ? " on" : "") + '" data-multi="' + key + '" data-v="' + esc(v) + '"' + (t ? ' title="' + esc(t) + '"' : "") + ">" + esc(l) + num(countWith({ [key]: [v] })) + "</button>").join("") +
    '<button class="kchip all' + (view[key].length ? "" : " on") + '" data-multi="' + key + '" data-v="" title="Do not filter by this">All</button></div>';
  const s = sortOf();
  return (
    '<div class="controls' + (filtersOpen ? " open" : "") + '">' +
    '<div class="control"><span class="clabel" title="The kind of packet: its policy">' + T("kind", "Kind") + "</span>" +
    kinds.map((k) => '<button class="kchip' + (view.kinds.includes(k.key) ? " on" : "") + '" style="--kc:' + esc(k.color) + '" data-kind="' + esc(k.key) + '" title="Show ' + esc(k.name) + ' packets; ' + verb + ' it again to drop it">' + esc(k.name) + num(countWith({ kinds: [k.key] }, true)) + "</button>").join("") +
    '<button class="kchip all' + (view.kinds.length ? "" : " on") + '" data-kind="" title="Show every kind">All</button></div>' +
    '<div class="control"><span class="clabel" title="The priority the Predictor gives. Backlog and obsolete count as below P3, so a floor hides them. An action for you, an ask, or a packet with no Premove yet has no Predictor\'s priority, so it always shows">Predictor\'s priority</span>' + seg("floor", [["P0", "P0", "Only P0"], ["P1", "P0-P1", "P0 and P1"], ["P2", "P0-P2", "P0 to P2"], ["P3", "P0-P3", "P0 to P3"], ["", "All", "Every priority"]], (v) => countWith({ floor: v })) + "</div>" +
    multi("efforts", "Packet creator\'s effort", EFFORTS.concat("?").map((e) => [e, e === "?" ? "No estimate" : e, e === "?" ? "The packet creator gave no estimate" : HELP_EFFORT[e]]), "The packet creator's estimate of the work, not the Predictor's") +
    multi("conf", "Confidence", CONFS.map(([v, l, t]) => [v, l, t]), "How sure the Premove is") +
    '<div class="control"><span class="clabel" title="The order of the packets; an action for you is always first">Sort</span>' + seg("sort", SORTS.map(([k, l, t]) => [k, l, t])) + seg("dir", s[3].map(([d, l, w]) => [d, l, cap(w)])) + "</div>" +
    (DESK.matches ? "" : '<div class="control">' + searchBox() + "</div>") +
    "</div>"
  );
}
const HELP_EFFORT = { S: "S: under an hour of one worker pair, a file or two", M: "M: a few hours", L: "L: about a day, several areas", XL: "XL: multi-day, should be split" };

function block(b, c, i) {
  switch (b.type) {
    case "markdown":
      return b.tone === "warn" ? '<div class="warnline">' + md(b.text) + "</div>" : md(b.text);
    case "diff":
      return (b.path ? '<div class="diffpath">' + esc(b.path) + "</div>" : "") + diff(b.unified);
    case "image":
      return thumb(b, c);
    case "video":
      return '<video controls preload="metadata" playsinline src="/api/blobs/' + esc(b.blob) + '"></video>' + (b.caption ? "<p>" + esc(b.caption) + "</p>" : "");
    case "link":
      return '<p><a href="' + esc(b.url) + '" target="_blank" rel="noopener">' + esc(b.label) + "</a></p>";
    case "demo":
      return fold(c.id + ":" + i, "Open the demo here", '<iframe class="demo" loading="lazy" data-src="' + esc(b.url) + '"' + (openFolds.has(c.id + ":" + i) ? ' src="' + esc(b.url) + '"' : "") + "></iframe>");
    case "chart":
      return fold(c.id + ":" + i, "Chart (spec)", '<pre class="code">' + esc(JSON.stringify(b.spec, null, 1)) + "</pre>");
    case "draft": {
      const p = pickOf(c);
      return '<div class="draft"><div class="dlabel">Draft ' + esc(b.key) + ": you can edit it, and your text goes with your call</div><textarea data-draft=\"" + esc(b.key) + '" rows="4" aria-label="Draft ' + esc(b.key) + '">' + esc(p.call[b.key] ?? b.text) + "</textarea></div>";
    }
    case "checklist":
      return '<div class="checklist">' + b.items.map((x, j) => '<label><input type=checkbox data-tick="' + j + '"' + (pickOf(c).ticks[j] ? " checked" : "") + "> " + esc(x) + "</label>").join("") + "</div>";
    case "fields": {
      // Nil, 2026-10-29 ("I couldn't care less about how the task was sized"): the effort and its
      // Why show only as Effort in the head line, never in the body.
      const rows = b.rows.some((r) => r[0] === "Effort") ? b.rows.filter((r) => r[0] !== "Effort" && r[0] !== "Why") : b.rows;
      if (!rows.length) return "";
      return '<table class="fields">' + rows.map((r) => "<tr><td>" + esc(r[0]) + "</td><td>" + esc(r[1]) + "</td></tr>").join("") + "</table>";
    }
    // Slice 7: a command to copy, and a file to open or download.
    case "code":
      return '<div class="codeline"><pre class="code">' + esc(b.text) + '</pre><button class="btn small" data-copy="' + esc(b.text) + '" title="Copy the command">' + (copied.text === b.text && Date.now() < copied.until ? "Copied" : "Copy") + "</button></div>";
    case "file":
      return '<p><a class="filechip" href="/api/blobs/' + esc(b.blob) + '" target="_blank" rel="noopener" download="' + esc(b.name) + '">' + esc(b.name) + (typeof b.size === "number" ? ' <span class="muted">' + esc(b.size < 1024 ? b.size + " bytes" : Math.round(b.size / 1024) + " KB") + "</span>" : "") + "</a></p>";
    case "fold":
      return fold(c.id + ":" + i, esc(b.title), blocks(b.blocks, c, i + "."), "fold");
    default:
      return "";
  }
}

// L81: an image with `pair: {name, side}` is one half of a before/after pair.
const pairOf = (b) => (b && b.pair && typeof b.pair.name === "string" && (b.pair.side === "before" || b.pair.side === "after") ? b.pair : null);
// Round 9: an image with `focus` (the part that needs Nil's attention, as
// fractions of the image) shows on the card cropped around it, with a red box
// on it, so the defect reads without a tap; the viewer shows the whole image
// with the same box. An image with no focus keeps its shape.
const focusOf = (b) => {
  const f = b && b.focus;
  return f && [f.x, f.y, f.w, f.h].every((n) => typeof n === "number" && n >= 0 && n <= 1) && f.w > 0 && f.h > 0 ? f : null;
};
function thumb(b, c, side) {
  const pr = side && pairOf(b);
  const f = focusOf(b);
  const img = '<img src="/api/blobs/' + esc(b.blob) + '" alt="' + esc(b.caption || "image") + '">';
  return (
    '<button class="thumb' + (f ? " focus" : "") + (b.wide && !side ? " wide" : "") + '" data-lb="' + esc(c.id) + '" data-src="' + esc(b.blob) + '" data-cap="' + esc(b.caption || "") + '"' + (f ? ' data-focus="' + [f.x, f.y, f.w, f.h].join(",") + '"' : "") + (pr ? ' data-pair="' + esc(pr.name) + '" data-side="' + pr.side + '"' : "") + ' title="' + (pr ? "Open the pair large" : "Open it large") + '">' +
    (side ? '<span class="side">' + side + "</span>" : "") + (f ? '<span class="crop">' + img + '<i class="redbox"></i></span>' : img) + '<span>' + esc(b.caption || "") + '</span><span class="muted">' + VERB + (f ? " to see the whole image" : pr ? " to open the pair large" : " to open it large") + "</span></button>"
  );
}
// The crop of a focus image, once its size is known: the focus and 10 px
// around it on the screen (round 11: the same on a phone as on a desktop).
function layoutCrop(img) {
  const span = img.parentElement;
  const t = span && span.closest("[data-focus]");
  if (!t || !img.naturalWidth) return;
  const [x, y, w, h] = t.dataset.focus.split(",").map(Number);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const fx = x * W, fy = y * H, fw = w * W, fh = h * H;
  // Part I: the loop card's image is at most 260 px tall (120 px on a phone, Antifeed PM): a narrower crop.
  const maxH = t.closest(".lshot") ? (matchMedia("(max-width: 700px)").matches ? 120 : 260) : 0;
  if (maxH) span.style.width = "";
  let D, m, cx, cy, cw, ch;
  for (let pass = 0; pass < 2; pass++) {
    // The crop is D px wide on the screen and cw = fw + 2m image px, so 10 px on the screen is m = 10 fw / (D - 20).
    D = span.getBoundingClientRect().width;
    m = D > 40 ? (10 * fw) / (D - 20) : 0.06 * Math.min(fw, fh);
    cx = Math.max(0, fx - m), cy = Math.max(0, fy - m);
    cw = Math.min(W, fx + fw + m) - cx, ch = Math.min(H, fy + fh + m) - cy;
    if (!maxH || (D * ch) / cw <= maxH + 0.5) break;
    span.style.width = Math.floor((maxH * cw) / ch) + "px";
  }
  span.style.aspectRatio = cw + " / " + ch;
  Object.assign(img.style, { width: (W / cw) * 100 + "%", left: (-cx / cw) * 100 + "%", top: (-cy / ch) * 100 + "%" });
  Object.assign(span.querySelector(".redbox").style, { left: ((fx - cx) / cw) * 100 + "%", top: ((fy - cy) / ch) * 100 + "%", width: (fw / cw) * 100 + "%", height: (fh / ch) * 100 + "%" });
  span.classList.add("ready");
}
document.addEventListener("load", (e) => e.target.tagName === "IMG" && e.target.parentElement && e.target.parentElement.classList.contains("crop") && layoutCrop(e.target), true);
window.addEventListener("resize", () => document.querySelectorAll(".crop img").forEach((i) => i.complete && layoutCrop(i)));
// Images that follow each other share one row; the two halves of a pair sit
// side by side (stacked on a phone), before on the left.
function thumbRow(row, c) {
  let html = "";
  const used = new Set();
  row.forEach((b, i) => {
    if (used.has(i)) return;
    const pb = pairOf(b);
    const j = pb ? row.findIndex((x, k) => k !== i && !used.has(k) && pairOf(x) && pairOf(x).name === pb.name && pairOf(x).side !== pb.side) : -1;
    if (j < 0) return void (html += thumb(b, c));
    used.add(i);
    used.add(j);
    const [before, after] = pb.side === "before" ? [b, row[j]] : [row[j], b];
    html += '<div class="imgpair"><div class="pairname" title="Before and after, as a pair">' + esc(pb.name) + '</div><div class="pairimgs">' + thumb(before, c, "Before") + thumb(after, c, "After") + "</div></div>";
  });
  return '<div class="thumbs">' + html + "</div>";
}
function blocks(list, c, prefix = "") {
  let out = "";
  let row = [];
  (list || []).forEach((b, i) => {
    if (b.type === "image") return void row.push(b);
    if (row.length) out += thumbRow(row, c);
    row = [];
    out += block(b, c, prefix + i);
  });
  return out + (row.length ? thumbRow(row, c) : "");
}

// C8 (Nil: "I will never read multiple screens"): the packet fits one screen.
// A long text block (Nil, 2026-10-29: shown once) goes whole behind one
// "Full packet" toggle, closed at first. A long diff goes there too. The
// rest (short text, images, fields, folds) stays.
const LONG_TEXT = 600;
const LONG_DIFF = 40;
const isLong = (b) => (b.type === "markdown" && b.text.length > LONG_TEXT) || (b.type === "diff" && b.unified.split("\n").length > LONG_DIFF);
const hasFull = (c) => ((c.packet && c.packet.blocks) || []).some(isLong);
// Nil, 2026-10-29: the packet's drafts are in Your call, not in its body.
const noDrafts = (list) => (list || []).map((b) => (b.type === "draft" ? { type: "moved" } : b.type === "fold" ? { ...b, blocks: noDrafts(b.blocks) } : b));
function packetBody(c) {
  const list = noDrafts((c.packet && c.packet.blocks) || []);
  if (!list.some(isLong)) return blocks(list, c);
  // Each block keeps its place, so the fold keys (card:index) stay the same. Nil, 2026-10-29
  // ("the task is described AGAIN"): a long text shows only inside Full packet.
  const short = list.map((b) => (!isLong(b) ? b : { type: "moved" }));
  const long = list.filter(isLong);
  return blocks(short, c) + fold(c.id + ":full", "Full packet", blocks(long, c, "full."), "fold full");
}

// Folds Nil opened stay open across re-renders. A fold with data-text loads its text when opened.
const fold = (key, summary, body, cls = "") => '<details class="' + cls + '" data-dkey="' + esc(key) + '"' + (openFolds.has(key) ? " open" : "") + "><summary>" + summary + "</summary>" + body + "</details>";
function lazyText(url) {
  const t = texts[url];
  if (t === undefined || t === "loading") return '<p class="muted">Loading…</p>';
  if (t && t.error) return '<p class="err">' + esc(t.error) + "</p>";
  return '<pre class="input">' + esc(t) + "</pre>";
}
function wantText(url) {
  if (texts[url] !== undefined) return;
  texts[url] = "loading";
  fetch(url)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(url + " answered " + r.status))))
    .then((t) => (texts[url] = t))
    .catch((err) => (texts[url] = { error: err.message }))
    .finally(() => redraw());
}

// The rule for every card, in one sentence (DESIGN.md 13.8): a Premove with a
// basis (the consult agent, a quick model run, a vote, the author's pick) is
// filled in for Nil to confirm; a safe default is never filled in. Nothing
// decides on its own. How the guess was made sits in one fold.
// Who made the card's Premove, in the words of its zone label (C3: the author by name).
const madeBy = (c) => (c.prediction.by === "code:standin" && basisOf(c.prediction) === "author" ? pickName(c) : predictorLabel(c.prediction));
function premoveZone(c) {
  const pol = policyOf(c);
  const p = c.prediction;
  const who = consultName(c.project);
  if (!p) return '<section class="zone premove" data-shown="' + esc(c.id) + '" data-v="' + c.version + '"><div class="zlabel"><span>' + T("premove", "Premove") + "</span></div><p>" + esc(c.state === "predicting" ? cap(who) + " is predicting this packet." : "No Premove yet.") + "</p></section>";
  const si = isStandin(p);
  const nb = noBasis(p);
  const opt = premoveOption(c);
  const testCopy = p.by === "code:walkthrough-stub";
  let out = '<section class="zone premove' + (si && !nb ? " standin" : "") + '" data-shown="' + esc(c.id) + '" data-v="' + c.version + '">';
  // A Premove that changed under Nil (a late answer took a stand-in's place)
  // says so, and must be seen again before the bar confirms it.
  const psig = p.by + "|" + callText(pol, p.call, c);
  const key = c.id + "@" + c.version;
  if (zoneWas[key] !== undefined && zoneWas[key] !== psig) {
    zoneChangedAt[key] = Date.now();
    premoveSeen.delete(key);
    acted.delete(key);
  }
  zoneWas[key] = psig;
  const updated = Date.now() - (zoneChangedAt[key] || 0) < 60_000 ? '<span class="updtag">updated just now</span> ' : "";
  // C3: a stand-in from the pick names the packet creator; an agent shows as its chip (H2).
  const mb = madeBy(c);
  const byHtml = mb === predictorLabel(p) ? agentChip(mb) : esc(mb);
  // N3 (P9 on the card): a Premove of the Predictor names it with its term.
  const byPredictor = !nb && !si && (p.by === "code:walkthrough-stub" || mb === consultName(c.project));
  const predHtml = p.by === "code:walkthrough-stub" ? "by the " + T("predictor", "Predictor") + " (" + esc(TEST_COPY) + ")" : T("predictor", "Predictor") + ": " + byHtml;
  const label = updated + (nb ? "none: nothing gives a basis" : si ? '<span class="standin-tag">' + T("standin", "Stand-in") + "</span> " + byHtml : byPredictor ? predHtml : "by " + byHtml);
  out += '<div class="zlabel"><span>' + T("premove", "Premove") + '</span><span class="who">' + label + "</span></div>";
  if (nb) {
    out += '<div class="pcall">No basis: pick yourself</div>';
    out += "<p>" + esc(cap(ownWords(p, c, p.why).replace(/^No basis:\s*/, ""))) + "</p>";
  } else {
    // C2: the same mark as the Premove's chips in Your call.
    out += '<div class="pcall"><span class="pdot" aria-hidden="true"></span>' + esc(callText(pol, p.call, c)) + "</div>";
    out += '<div class="conf">' + confHtml(p, c, true) + "</div>";
    if (p.why) out += "<p>" + esc(ownWords(p, c, p.why)) + "</p>";
    if (si) out += '<p class="muted dyn"><span class=dv>' + esc(cap(who)) + "</span> did not make this one, so a stand-in did. It is filled in for you to confirm; a stand-in never decides on its own.</p>";
  }
  if (si && c.predict === "started" && !c.latePrediction) out += '<p class="muted dyn"><span class=dv>' + esc(cap(who)) + "</span> is still working on this packet. If it answers before you look at the packet, its answer takes this one's place; after that, it shows below.</p>";
  if (p.informed)
    out += '<p class="muted"><b>' + T("informed", "Informed") + ":</b> it already had your view of this packet, so this call does not count in its accuracy." + (testCopy ? " (Test copy: nobody talked with it.)" : "") + "</p>";
  if (c.latePrediction) {
    const lp = c.latePrediction;
    const same = callText(pol, lp.call, c) === callText(pol, p.call, c);
    out += same
      ? '<div class="late dyn"><span class=dv>' + esc(cap(shortLabel(lp))) + "</span> answered later with the same call (" + confHtml(lp, c) + ").</div>"
      : '<div class="late"><b>' + esc(cap(shortLabel(lp))) + " answered later:</b> " + "<span class=dv>" + esc(callText(pol, lp.call, c)) + "</span>, " + confHtml(lp, c) + (lp.why ? ". " + esc(lp.why) : "") + ' <span class="muted">You saw the stand-in (on this packet or its row in the queue) before this answer came, so the stand-in stays the Premove, and this answer does not count in accuracy.</span></div>';
  }
  const made = c.id + ":made";
  const raw = c.id + ":raw";
  const name = si ? cap(shortLabel(p)) : cap(who);
  const n = (p.precedent || []).length;
  let body = "";
  if (si) body += "<p><b>Why a stand-in:</b> " + esc(cap(plain(p.standin.reason))) + "." + (p.standin.predictorError ? " " + esc(cap(plain(p.standin.predictorError))) + "." : "") + (c.predict === "started" && !c.latePrediction ? "" : " <span class=dv>" + esc(cap(who)) + "</span> will not answer this packet now.") + "</p>";
  if (p.by === "code:standin") {
    const basis = basisOf(p);
    body +=
      basis === "vote"
        ? "<p>No model ran. Antifeed compared the words of this packet with your <span class=dv>" + n + "</span> past calls on <span class=dv>" + esc(pol.name) + "</span> packets and took the call that most of the similar ones got. It reads only words, not the evidence.</p>"
        : basis === "author"
          ? "<p>No model ran. You have no past calls on <span class=dv>" + esc(pol.name) + "</span> packets yet, so Antifeed took <span class=dv>" + esc(pickName(c)) + "</span>.</p>"
          : pol.noDefault
            ? "<p>No model ran: on <span class=dv>" + esc(pol.name) + "</span> packets only the Predictor fills in a call, and no prediction came from it. " + esc(pol.noDefault) + "</p>"
            : "<p>No model ran. You have no past calls on <span class=dv>" + esc(pol.name) + "</span> packets yet, and " + (pol.noAuthor ? "no prediction came from the Predictor" : (authorOf(c) ? "<span class=dv>" + esc(authorOf(c)) + "</span>" : "the packet creator") + " marked no pick") + ", so nothing gives a basis. The <span class=dv>" + esc(pol.name) + "</span> policy names a safe default (<span class=dv>" + esc(callText(pol, p.call, c)) + "</span>); it is not filled in.</p>";
  } else body += "<p><span class=dv>" + esc(name) + "</span> read: how you decide <span class=dv>" + esc(pol.name) + "</span> packets (the criteria), " + (p.pastCalls !== undefined ? "your <span class=dv>" + p.pastCalls + "</span> past calls on them, which it reads from Antifeed once a session" : "<span class=dv>" + n + "</span> of your past calls on similar packets") + ", the packet as you see it without <span class=dv>" + esc(pickName(c)) + "</span>, and the source link." + (p.usd ? " It cost <span class=dv>$" + p.usd.toFixed(3) + "</span>." : "") + "</p>";
  if (p.input || p.answer) {
    let inner = "";
    if (openFolds.has(made)) {
      if (p.input) {
        inner += "<h3>The exact text it got</h3>" + (openFolds.has(raw) ? lazyText("/api/blobs/" + p.input) : "");
        if (openFolds.has(raw)) wantText("/api/blobs/" + p.input);
      }
      if (p.answer) {
        inner += "<h3>Its answer, as it came</h3>" + (openFolds.has(raw) ? lazyText("/api/blobs/" + p.answer) : "");
        if (openFolds.has(raw)) wantText("/api/blobs/" + p.answer);
      }
    }
    body += fold(raw, "The raw text", inner);
  }
  out += fold(made, "How this Premove was made", body);
  return out + "</section>";
}

// ---- the chat on a card with its consult (round q1, H1) ---------------------
// Nil's words go to the card's consult through the office; its answer comes
// back here. A project with no consult agent (the Inbox for now) has none.
const CHAT_QUIET_MS = 10 * 60_000;
const chatDrafts = {}; // card id -> words not sent yet
const chatErr = {}; // card id -> why the last send was refused
const chatBusy = new Set(); // card ids with a send in flight
const chatRead = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem("af-chat-read") || "[]"));
  } catch {
    return new Set();
  }
})();
const mineMsg = (m) => String(m.by).startsWith("human:");
const senderOf = (m, name) => (mineMsg(m) ? "You" : String(m.by).startsWith("agent:") ? String(m.by).slice(6) : name);
const chatUnread = (c) => (c.thread || []).some((m) => !mineMsg(m) && !chatRead.has(m.id));
function markChatRead(c) {
  let changed = false;
  for (const m of c.thread || []) if (!mineMsg(m) && !chatRead.has(m.id)) changed = chatRead.add(m.id) && true;
  if (changed) localStorage.setItem("af-chat-read", JSON.stringify([...chatRead].slice(-500)));
}
// Where one of Nil's messages stands: on its way, sent, not sent, answered.
function chatState(m, name) {
  const again = ' <button class="btn small" data-chatagain="' + esc(m.id) + '" title="Send the same words again">Send again</button>';
  if (m.state === "sending") return '<p class="mstate">Sending…</p>';
  if (m.state === "failed") return '<p class="mstate err">Not sent: ' + esc(m.error || "no reason") + "." + again + "</p>";
  if (m.state === "maybe") return '<p class="mstate warn">It may not have gone out: ' + esc(m.error || "no reason") + "." + again + "</p>";
  if (m.state === "sent") return Date.now() - Date.parse(m.at) > CHAT_QUIET_MS ? '<p class="mstate warn">No answer yet after <span class=dv>' + Math.round((Date.now() - Date.parse(m.at)) / 60_000) + " min</span>." + again + "</p>" : '<p class="mstate">Sent to <span class=dv>' + esc(name) + "</span>. Its answer shows here.</p>";
  return "";
}
function chatPanel(c) {
  if (!consultOf(c.project)) return "";
  const ca = consultAgentOf(c);
  const name = (ca && ca.name) || consultName(c.project);
  const t = c.thread || [];
  const key = "chat:" + c.id;
  const unread = chatUnread(c);
  // An answer Nil has not read opens the thread; an open thread has no unread answer.
  if (unread) openFolds.add(key);
  if (openFolds.has(key)) markChatRead(c);
  const last = t[t.length - 1];
  // A closed thread shows one line about it; an open one shows only the heading.
  const head = "Chat with <span class=dv>" + esc(name) + "</span>";
  const sum = last ? '<span class="csum"> · <span class=dv>' + t.length + "</span> " + (t.length === 1 ? "message" : "messages") + ", the last from <span class=dv>" + esc(senderOf(last, name)) + "</span>, <span class=dv>" + esc(ago(last.at)) + "</span></span>" : "";
  const msgs = t
    .map((m) => '<div class="msg ' + (mineMsg(m) ? "mine" : "theirs") + '"><div class="mby"><b>' + (mineMsg(m) ? "You" : agentChip(senderOf(m, name))) + "</b> · " + esc(ago(m.at)) + '</div><div class="mtext">' + esc(m.text) + "</div>" + (mineMsg(m) ? chatState(m, name) : "") + "</div>")
    .join("");
  const busy = chatBusy.has(c.id);
  const form =
    '<div class="chatform"><textarea data-chatbox="' + esc(c.id) + '" rows="1" maxlength="4000" placeholder="Ask about this packet" aria-label="Your message to ' + esc(name) + '">' + esc(chatDrafts[c.id] || "") + "</textarea>" +
    '<button class="btn" data-chatsend="' + esc(c.id) + '"' + (busy ? " disabled" : "") + ' title="Send it to ' + esc(name) + ' (Enter). Shift+Enter makes a new line">' + (busy ? "Sending…" : "Send") + "</button></div>" +
    (chatErr[c.id] ? '<p class="err">' + esc(chatErr[c.id]) + "</p>" : "");
  // Round q1, H1 look: the text box shows with no click; only the thread folds.
  const thread = msgs
    ? '<details class="cthread" data-dkey="' + esc(key) + '"' + (openFolds.has(key) ? " open" : "") + "><summary>" + head + sum + '</summary><div class="thread">' + msgs + "</div></details>"
    : '<div class="chead">' + head + "</div>";
  return '<section class="chat">' + thread + form + "</section>";
}
// The chat box grows with its words, up to 6 lines (the New box 12), then scrolls.
function growBox(b, lines = 6) {
  b.style.height = "";
  // An empty box keeps one line (a long placeholder ends in "…"); a box on a
  // hidden tab has no size yet.
  if (!b.value) return;
  b.style.height = "auto";
  if (!b.scrollHeight) return void (b.style.height = "");
  const cs = getComputedStyle(b);
  const line = parseFloat(cs.lineHeight) || 1.4 * parseFloat(cs.fontSize);
  const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  b.style.height = Math.min(b.scrollHeight + border, lines * line + pad + border) + "px";
}
async function chatSend(cardId, text) {
  const words = String(text || "").trim();
  if (!words || chatBusy.has(cardId)) return;
  chatBusy.add(cardId);
  delete chatErr[cardId];
  redraw();
  try {
    await api("POST", "/api/cards/" + encodeURIComponent(cardId) + "/chat", { text: words });
    if ((chatDrafts[cardId] || "").trim() === words) delete chatDrafts[cardId];
  } catch (err) {
    chatErr[cardId] = err.message;
  } finally {
    chatBusy.delete(cardId);
    await poll(true);
    redraw();
  }
}

// ---- Nil's input that becomes a task (round q1, I) --------------------------
// New (Shift+N) on every page: his words, where they go, and Send. The app
// files them as an untagged task on that room's board and tells its PM.
// Sent lists the last ones, each with how it went and its next step.
let newOpen = false;
let newDraft = "";
let newTarget = null; // a target id; null: the first of the list
let newBusy = false;
let newErr = "";
let newClient = null; // one id per input, so a double tap files once
// Part K (Nil, 2026-10-30: "i can't attach screenshots to new tasks"): paste,
// drop or pick, up to 4, PNG, JPEG or WebP, at most 8 MB each. Each is stored
// as a blob when added; the task lists them by server path.
const SHOTS_MAX = 4;
const SHOT_BYTES = 8 * 2 ** 20;
const SHOT_TYPES = ["image/png", "image/jpeg", "image/webp"];
let newShots = []; // {id, url, name (the blob, once stored), busy, err}
function addShots(files) {
  newErr = "";
  for (const f of files) {
    if (!f || !/^image\//.test(f.type || "")) continue;
    if (newShots.length >= SHOTS_MAX) {
      newErr = "At most " + SHOTS_MAX + " screenshots.";
      break;
    }
    if (!SHOT_TYPES.includes(f.type)) {
      newErr = "Only PNG, JPEG or WebP screenshots.";
      continue;
    }
    if (f.size > SHOT_BYTES) {
      newErr = "That screenshot is " + (f.size / 2 ** 20).toFixed(1) + " MB; a screenshot is at most 8 MB.";
      continue;
    }
    const s = { id: newId(), url: URL.createObjectURL(f), name: null, busy: true, err: "" };
    newShots.push(s);
    fetch("/api/blobs", { method: "POST", headers: { "Content-Type": f.type }, body: f })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.blob) throw new Error(d.error || "the upload answered " + r.status);
        s.name = d.blob;
      })
      .catch((err) => (s.err = "Did not upload: " + err.message + ". Remove it and add it again."))
      .finally(() => ((s.busy = false), drawNew()));
  }
  drawNew();
}
// Paste into the New box, or drop on the panel: the images become screenshots.
document.addEventListener("paste", (e) => {
  if (!newOpen || !e.target.closest || !e.target.closest("#newpanel")) return;
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => /^image\//.test(f.type));
  if (!files.length) return;
  // A screenshot has no text with it; a copy with text pastes its text too.
  if (!e.clipboardData.getData("text/plain")) e.preventDefault();
  addShots(files);
});
document.addEventListener("dragover", (e) => {
  if (newOpen && e.target.closest && e.target.closest("#newpanel")) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  if (!newOpen || !e.target.closest || !e.target.closest("#newpanel")) return;
  e.preventDefault();
  addShots([...(e.dataTransfer ? e.dataTransfer.files : [])]);
});
function dropShot(id) {
  const s = newShots.find((x) => x.id === id);
  if (s) URL.revokeObjectURL(s.url);
  newShots = newShots.filter((x) => x.id !== id);
  drawNew();
}
const shotsHtml = () =>
  '<div class="newshots">' +
  newShots.map((s) => '<span class="newshot' + (s.err ? " bad" : "") + '"><img src="' + esc(s.url) + '" alt="Screenshot"' + (s.err ? ' title="' + esc(s.err) + '"' : "") + '><button class="btn small" data-newshotx="' + esc(s.id) + '" aria-label="Remove this screenshot" title="Remove">×</button>' + (s.busy ? '<span class="muted">Adding…</span>' : "") + "</span>").join("") +
  (newShots.length < SHOTS_MAX ? '<button class="btn small" data-newpick title="Add a screenshot: pick a file, or paste or drop one here (up to ' + SHOTS_MAX + ', at most 8 MB each)">Add screenshot</button>' : "") +
  "</div>" +
  newShots.filter((s) => s.err).map((s) => '<p class="err">' + esc(s.err) + "</p>").join("");
const newId = () => "in" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const inputsOf = () => (V && V.inputs) || { targets: [], sent: [] };
// The open packet's project first, then the rest in the list's order.
function newTargets() {
  const ts = inputsOf().targets;
  const c = tab === "queue" && cur && cardById(cur);
  const first = c && ts.find((t) => t.id === c.project);
  return first ? [first, ...ts.filter((t) => t !== first)] : ts;
}
const newPick = () => newTargets().find((t) => t.id === newTarget) || newTargets()[0] || null;
const INPUT_STATE = {
  sending: () => "Filing…",
  filed: (t) => "Filed. Telling <span class=dv>" + esc(t.pm) + "</span>…",
  told: (t) => "Filed, and <span class=dv>" + esc(t.pm) + "</span> is told.",
  untold: (t) => "Filed, but <span class=dv>" + esc(t.pm) + "</span> is not told",
  failed: () => "Not filed",
  maybe: () => "It may have been filed",
};
function sentRow(x) {
  const t = inputsOf().targets.find((y) => y.id === x.target) || { name: x.target, pm: "its PM" };
  const board = V && V.officeUrl ? V.officeUrl + "/tasks" : "";
  const task = x.taskId ? ' · task <a href="' + esc(board) + '" target="_blank" rel="noopener" title="Open the office board; the task id is ' + esc(x.taskId) + '"><code>' + esc(x.taskId) + "</code></a>" : "";
  const warn = x.state === "failed" || x.state === "maybe" || x.state === "untold";
  // The words in the line; the office call and its status in its tooltip (Antifeed PM, 2026-10-29).
  const why = x.error ? ": " + (x.detail ? '<span class="why" title="' + esc("The office's answer: " + x.detail) + '">' + esc(x.error) + "</span>" : esc(x.error)) + "." : x.state === "untold" ? "." : "";
  const check = x.state === "maybe" ? ' Check the <a href="' + esc(board) + '" target="_blank" rel="noopener">' + esc(t.name) + " board</a> first: Send again may file it twice." : "";
  const act =
    x.state === "untold" ? ' <button class="btn small" data-newtell="' + esc(x.id) + '" title="Send only the message to ' + esc(t.pm) + '">Tell again</button>'
    : (x.state === "failed" || x.state === "maybe") && x.text ? ' <button class="btn small" data-newagain="' + esc(x.id) + '" title="File the same words again, as a new task">Send again</button>'
    : "";
  const shots = (x.images || []).length ? '<div class="sentshots">' + x.images.map((n) => '<img src="/api/blobs/' + esc(n) + '" alt="Screenshot">').join("") + "</div>" : "";
  return '<li class="sent"><div><b>' + esc(x.title) + '</b> <span class="muted">to <span class=dv>' + esc(t.name) + "</span> · " + esc(ago(x.at)) + (x.images && x.images.length ? " · " + x.images.length + " screenshot" + (x.images.length > 1 ? "s" : "") : "") + "</span>" + task + "</div>" + shots + '<div class="sstate' + (warn ? " warn" : "") + '">' + INPUT_STATE[x.state](t) + why + check + act + "</div></li>";
}
// The box is drawn once per opening, so typing never loses it; the rest
// (where to, the error, Sent) is drawn again with each view.
function drawNew() {
  const el = $("#newpanel");
  el.hidden = !newOpen;
  // Below the tab bar, so no tab shows above it (Antifeed PM, 2026-10-29).
  if (newOpen) el.style.top = Math.round($("header").getBoundingClientRect().bottom + 8) + "px";
  if (!newOpen) return setHtml(el, "");
  if (!el.querySelector("[data-newbox]")) {
    el._html = null;
    el.innerHTML =
      '<div class="newhead"><h2>New</h2><span class="muted">Your words become a task on a board, and its PM is told.</span><button class="btn small" data-newclose title="Close (Esc). Your words stay here until you send them">Close</button></div>' +
      '<textarea data-newbox rows="3" maxlength="8000" placeholder="What should become a task? Paste or drop screenshots here too." aria-label="Your words for the new task"></textarea>' +
      '<input type="file" data-newfile accept="image/png,image/jpeg,image/webp" multiple hidden><div id="newdyn"></div>';
    el.querySelector("[data-newfile]").addEventListener("change", (e) => {
      addShots([...e.target.files]);
      e.target.value = "";
    });
    const box = el.querySelector("[data-newbox]");
    box.value = newDraft;
    growBox(box, 12);
    box.focus();
  }
  const pick = newPick();
  const chips = newTargets().map((t) => '<button class="chip' + (pick && t.id === pick.id ? " on" : "") + '" data-newto="' + esc(t.id) + '" aria-pressed="' + !!(pick && t.id === pick.id) + '" title="File it on the ' + esc(t.name) + " board and tell " + esc(t.pm) + '">' + esc(t.name) + "</button>").join("");
  const sent = inputsOf().sent;
  setHtml(
    $("#newdyn"),
    shotsHtml() +
    '<div class="newto"><span class="chips"><span class="lbl">To</span>' + chips + "</span>" +
      '<button class="btn primary" data-newsend' + (newBusy ? " disabled" : "") + ' title="File it (Enter). Shift+Enter makes a new line">' + (newBusy ? "Sending…" : "Send") + "</button></div>" +
      (newErr ? '<p class="err">' + esc(newErr) + "</p>" : "") +
      (pick ? '<p class="muted">It goes to the <span class=dv>' + esc(pick.name) + "</span> board, with no priority, and <span class=dv>" + esc(pick.pm) + "</span> is told.</p>" : "") +
      (sent.length ? "<h3>Sent</h3><ul class=\"sentlist\">" + sent.map(sentRow).join("") + "</ul>" : ""),
  );
}
async function newSend(text, target, again, images) {
  const words = String(text || "").trim();
  if (newBusy) return;
  if (!words) return void ((newErr = "Write something first."), drawNew());
  if (!again && newShots.some((s) => s.busy)) return void ((newErr = "A screenshot is still being added; send again in a moment."), drawNew());
  if (!again && newShots.some((s) => s.err)) return void ((newErr = "Remove the screenshot that did not upload, or add it again."), drawNew());
  const shots = again ? images || [] : newShots.map((s) => s.name);
  const t = target || (newPick() || {}).id;
  if (!newClient || again) newClient = newId();
  newBusy = true;
  newErr = "";
  drawNew();
  try {
    const c = tab === "queue" && cur && cardById(cur);
    await api("POST", "/api/inputs", { text: words, target: t, page: tab, ...(c && !again ? { card: c.id } : {}), clientId: newClient, ...(shots.length ? { images: shots } : {}) });
    newClient = null;
    if (!again) {
      newDraft = "";
      for (const s of newShots) URL.revokeObjectURL(s.url);
      newShots = [];
      const box = document.querySelector("[data-newbox]");
      if (box) (box.value = ""), growBox(box, 12);
    }
  } catch (err) {
    newErr = err.message;
  } finally {
    newBusy = false;
    await poll(true);
    drawNew();
  }
}
function toggleNew(open = !newOpen) {
  newOpen = open;
  drawNew();
}

function againstZone(c) {
  const p = c.prediction;
  if (!p) return "";
  // H2, C7: the Against has the Premove's writer, in the Premove's words, with no test-copy note.
  const mb = madeBy(c).replace(" (" + TEST_COPY + ")", "");
  const by = noBasis(p) ? "" : '<span class="who">by ' + (madeBy(c) === predictorLabel(p) ? agentChip(mb) : esc(mb)) + "</span>";
  return '<section class="zone against"><div class="zlabel"><span>' + T("against", "Against") + "</span>" + by + '</div><p>' + esc(ownWords(p, c, p.against) || "No case against was given.") + "</p></section>";
}

// What Nil changed from the Premove, in words: the option, each field, and
// the note when an option wrote it.
function changes(c, p) {
  const pol = policyOf(c);
  if (!c.prediction || noBasis(c.prediction)) return [];
  const pre = c.prediction.call || {};
  const opts = (c.packet && c.packet.options) || [];
  const popt = premoveOption(c);
  const out = [];
  if (opts.length && (p.option || null) !== (popt ? popt.id : null)) out.push("Option " + (popt ? optLetter(popt) : "none") + " → " + (p.option ? String(p.option).toUpperCase() : "none"));
  for (const [k, f] of fields(pol)) if ((pre[k] ?? null) !== (p.call[k] ?? null) && (k in pre || p.call[k] != null)) out.push(fieldLabel(k, f) + " " + valueLabel(pre[k] ?? null) + " → " + valueLabel(p.call[k] ?? null));
  const o = opts.find((x) => (x.fill.note || "").trim() && (x.fill.note || "").trim() === p.note.trim());
  if (o && (!popt || ((popt.fill.note || "").trim() !== p.note.trim()))) out.push("the note is now option " + optLetter(o) + "'s text");
  for (const [k, text] of Object.entries(draftsOf(c.packet && c.packet.blocks))) if (p.call[k] !== undefined && p.call[k] !== text) out.push(cap(k) + " text: you edited it");
  if (p.note.trim() && !o && p.note.trim() !== ((popt && popt.fill.note) || "").trim()) out.push("Note: added (counts as an edit)");
  return out;
}

// "backlog, priority none": every field of a call, a field with no value too.
function fullCallText(pol, call) {
  return fields(pol).filter(([k]) => k in (call || {})).map(([k, f]) => (call[k] === null ? fieldLabel(k, f).toLowerCase() + " none" : f.enum ? valueLabel(call[k]) : String(call[k]))).join(", ");
}
// What an option fills, without its own label again: an ask's option sends
// its label as the reply ("reply, with these words").
function optionFills(pol, o, own = "these words") {
  const same = fields(pol).filter(([k, f]) => !f.enum && o.fill[k] === o.label).map(([k]) => k);
  const rest = fullCallText(pol, Object.fromEntries(Object.entries(o.fill).filter(([k]) => !same.includes(k))));
  return same.length ? rest + (rest ? ", with " : "") + own : rest;
}
// The line over the fields, only when there is something to say: no basis
// (nothing is filled in), or the call from before an Undo is back.
function fillHtml(c, p) {
  const pol = policyOf(c);
  if (noBasis(c.prediction) && pol.noDefault) return "<span>No basis, so nothing is filled in: pick yourself. " + esc(pol.noDefault) + "</span>";
  if (noBasis(c.prediction)) return '<span>No basis, so nothing is filled in: pick yourself.</span> <button class="btn small" data-safe title="Fill in the policy\'s safe default; you still confirm it">Use the safe default (' + esc(pol.fallbackHelp || fullCallText(pol, c.prediction.call)) + ")</button>";
  if (p.restored) return "Your call from before the Undo is back.";
  return "";
}
// Nil, 2026-10-29 ("the 'back to premove' button disappears, and the rest of
// ui below it janks up and down"): the button keeps its place; with nothing
// changed it is disabled.
const resetHtml = (c, p) => '<button class="btn small" data-reset' + (changes(c, p).length ? "" : " disabled") + ' title="Put every field, the option and the note back as the Premove has them (a)">Back to the Premove<span class="kh" aria-hidden="true"> (a)</span></button>';
// Round Q1, C2 (Nil: "Can't you visually indicate that one field is the
// Premove and the other is the choice?"): the fields are the call. The
// Premove's value has one mark, a ring with a dot (.pm), on its chip and on
// its option; Nil's pick is the filled chip. An option is a shortcut that
// fills the fields; it shows as picked only while the fields hold its values.
const pmValue = (c, k) => (c.prediction && !noBasis(c.prediction) && c.prediction.call && k in c.prediction.call ? c.prediction.call[k] ?? null : undefined);
const PM_TIP = "The Premove's value";
// The option holds while each field it fills has its value (the note aside).
function optionHolds(c, p) {
  const o = p.option && ((c.packet && c.packet.options) || []).find((x) => x.id === p.option);
  return !!o && Object.entries(o.fill).every(([k, v]) => k === "note" || (p.call[k] ?? null) === (v ?? null));
}
// What an option fills, as a pill ("go · P2"): its fields without its own words.
function optionPill(pol, o) {
  const fill = Object.fromEntries(Object.entries(o.fill).filter(([k, v]) => k !== "note" && !(v === o.label && !((pol.answer || {})[k] || {}).enum)));
  const t = callText(pol, fill);
  return t === "no fields" ? "" : t;
}
// Round Q1, C4 (Antifeed Walker): a request for a new packet needs Nil's own
// words. An option's text in the note box (the Premove's option fills it) is
// not a request.
const ownNote = (c) => {
  const n = pickOf(c).note.trim();
  return n && !((c.packet && c.packet.options) || []).some((o) => (o.fill.note || "").trim() === n) ? n : "";
};
const newPacketNeeds = (c) => "A new packet needs a note: what " + creatorName(c) + " should write differently.";
// The packet creator by name, for the request row and its tips (G0).
const creatorName = (c) => authorOf(c) || "the packet creator";
function callZone(c) {
  const pol = policyOf(c);
  const p = pickOf(c);
  const opt = premoveOption(c);
  let out = '<section class="zone yourcall" data-callzone="' + esc(c.id) + '"><div class="zlabel"><span>Your call</span><span class="who" data-reset-slot>' + resetHtml(c, p) + "</span></div>";
  const fill = fillHtml(c, p);
  out += '<p class="fill frow" data-fill' + (fill ? "" : " hidden") + ">" + fill + "</p>";
  const opts = (c.packet && c.packet.options) || [];
  // Slice 7 walk: when every option fills the same way (an ask: reply, with
  // its own words), no option shows the pill.
  const pills = opts.map((o) => optionPill(pol, o));
  const oneWay = opts.length > 1 && pills.every((x) => x === pills[0]);
  if (opts.length)
    out +=
      '<div class="options">' +
      opts.map((o, j) => '<button class="option' + (p.option === o.id ? " on" : "") + (opt && opt.id === o.id ? " pm" : "") + '" aria-pressed="' + (p.option === o.id) + '" data-opt="' + esc(o.id) + '"' + (opt && opt.id === o.id ? ' aria-description="' + PM_TIP + '"' : "") + ">" + esc(o.label) + (!oneWay && pills[j] ? '<span class="ofill">' + esc(pills[j]) + "</span>" : "") + (o.cost ? '<span class="ocost">' + esc(o.cost) + "</span>" : "") + "</button>").join("") +
      "</div>";
  // Slice 8 walk: a card may offer fewer values of a field, or leave it out (packet.limit).
  const lim = (c.packet && c.packet.limit) || {};
  for (const [k, f] of fields(pol)) {
    if (lim[k] === null) continue;
    const vals = f.enum && Array.isArray(lim[k]) ? f.enum.filter((v) => lim[k].includes(v)) : f.enum;
    const label = '<span class="flabel">' + esc(fieldLabel(k, f)) + "</span>";
    const bad = p.err && p.errField === k;
    const pm = pmValue(c, k);
    if (f.enum)
      out += '<div class="frow' + (bad ? " bad" : "") + '" data-frow="' + esc(k) + '">' + label + vals.map((v) => '<button class="chip' + (k in p.call && (p.call[k] ?? null) === v ? " on" : "") + (pm === v ? " pm" : "") + '" aria-pressed="' + (k in p.call && (p.call[k] ?? null) === v) + '" data-field="' + esc(k) + '" data-v="' + esc(JSON.stringify(v)) + '"' + (pm === v ? ' aria-description="' + PM_TIP + '"' : "") + ">" + esc(valueLabel(v)) + "</button>").join("") + (bad ? '<span class="err rowerr" role="alert">' + esc(p.err) + "</span>" : "") + "</div>";
    // Slice 7: a long text (an ask's reply) gets a box of its own lines.
    else if (f.text && f.text.max > 500 && !(k in draftsOf(c.packet && c.packet.blocks))) out += '<div class="frow ftext' + (bad ? " bad" : "") + '" data-frow="' + esc(k) + '">' + label + '<textarea data-text="' + esc(k) + '" rows="4" aria-label="' + esc(fieldLabel(k, f)) + '">' + esc(p.call[k] ?? "") + "</textarea>" + (bad ? '<span class="err rowerr" role="alert">' + esc(p.err) + "</span>" : "") + "</div>";
    else if (f.text && !(k in draftsOf(c.packet && c.packet.blocks))) out += '<div class="frow">' + label + '<input type="text" data-text="' + esc(k) + '" value="' + esc(p.call[k] ?? "") + '" placeholder="optional" aria-label="' + esc(fieldLabel(k, f)) + '"></div>';
    if (f.help) out += '<p class="fhelp muted">' + esc(f.help) + "</p>";
  }
  out += '<p class="fhelp muted" role="status" data-auto' + (p.auto ? "" : " hidden") + ">" + esc(p.auto) + "</p>";
  // Nil, 2026-10-29 ("Who fills this? Why is it all the way down here?"): each draft of the packet
  // is a field of the call, with one plain label.
  for (const [k, text] of Object.entries(draftsOf(c.packet && c.packet.blocks)))
    out += '<div class="draft"><div class="dlabel">' + esc(cap(k)) + ", as " + esc(creatorName(c)) + ' proposes it: edit or keep</div><textarea data-draft="' + esc(k) + '" rows="4" aria-label="' + esc(cap(k)) + '">' + esc(p.call[k] ?? text) + "</textarea></div>";
  if (!pol.noNote) out += '<textarea data-note rows="2" aria-label="Note" placeholder="' + esc(pol.notePlaceholder || "Note: anything the packet creator or the actor should know") + '">' + esc(p.note) + "</textarea>";
  // C2: no line under Confirm (Antifeed PM: "it says nothing Nil does not
  // know"). The reason a locked Confirm waits shows beside it only after a
  // press it refused, and stays in its tooltip.
  out +=
    '<div class="actions"><button class="btn primary" data-confirm aria-label="Confirm" aria-keyshortcuts="Control+Enter">Confirm<kbd aria-hidden="true">Ctrl+Enter</kbd></button>' +
    '<button class="btn" data-later title="Move it to the end of the queue on this device">Later<span class="kh" aria-hidden="true"> (l)</span></button>' + hintLine(c, true) + "</div>";
  // C4: a request for a better packet is no call: it goes in its own row, apart from Confirm, named for who acts.
  if (pol.prepare) {
    const who = creatorName(c);
    out +=
      '<div class="reqrow"><span class="rlabel">Ask <span class=dv>' + esc(who) + "</span> for</span>" +
      '<button class="btn small" data-rewrite title="' + esc(cap(who) + " writes a new packet as your note asks. This is no call: the packet comes back as a new version.") + '">New packet<span class="kh" aria-hidden="true"> (w)</span></button>' +
      (opts.length ? '<button class="btn small" data-refine title="' + esc(cap(who) + " sends variants of the option you picked. This is no call.") + '">Closer to this option<span class="kh" aria-hidden="true"> (r)</span></button>' : "") +
      "</div>";
  }
  return out + (p.err && !p.errField ? '<div class="err" role="alert">' + esc(p.err) + "</div>" : "") + "</section>";
}

// Nil's picks change the call zone in place: no node is replaced, so a tap
// that starts on a button always lands on it (DESIGN.md 13.10).
// A loop-kind card draws again on each pick (its Priority row comes and goes);
// a draw calls syncCall again, which then only saves.
let loopSyncing = false;
function syncCall(c) {
  if (isLoop(c)) {
    savePicks();
    if (loopSyncing) return;
    loopSyncing = true;
    try {
      redraw();
    } finally {
      loopSyncing = false;
    }
    return;
  }
  const z = document.querySelector('[data-callzone="' + c.id + '"]');
  const p = pickOf(c);
  // An option stays picked only while the fields hold its values.
  if (p.option && !isAction(c) && !optionHolds(c, p)) p.option = null;
  if (z && !isAction(c)) {
    for (const b of z.querySelectorAll("[data-field]")) b.setAttribute("aria-pressed", b.classList.toggle("on", b.dataset.field in p.call && (p.call[b.dataset.field] ?? null) === JSON.parse(b.dataset.v)));
    for (const b of z.querySelectorAll("[data-opt]")) b.setAttribute("aria-pressed", b.classList.toggle("on", p.option === b.dataset.opt));
    for (const i of z.querySelectorAll("[data-text]")) if (i !== document.activeElement) i.value = p.call[i.dataset.text] ?? "";
    const n = z.querySelector("[data-note]");
    if (n && n !== document.activeElement) n.value = p.note;
    // A line that showed keeps its space when it goes (visibility, not
    // hidden), so nothing below it moves on an option switch.
    const set = (sel, html, hide) => {
      const el = z.querySelector(sel);
      if (!el) return;
      if (hide && !el.hidden) {
        el.style.visibility = "hidden";
        return;
      }
      setHtml(el, html);
      if (!hide) el.style.visibility = "";
      el.hidden = !!hide && el.style.visibility !== "hidden";
    };
    const fill = fillHtml(c, p);
    set("[data-fill]", fill, !fill);
    set("[data-auto]", esc(p.auto || ""), !p.auto);
    set("[data-reset-slot]", resetHtml(c, p));
    // The same refusal twice draws no new card (its data did not change), so
    // the zone's own error line is set here too (walk round, C4).
    const ze = z.querySelector(":scope > .err");
    if (p.err && !p.errField) {
      if (ze) ze.textContent = p.err;
      else z.insertAdjacentHTML("beforeend", '<div class="err" role="alert">' + esc(p.err) + "</div>");
    }
    // A pick clears a rule error.
    if (!p.err) {
      z.querySelectorAll(".frow.bad").forEach((x) => x.classList.remove("bad"));
      z.querySelectorAll(".rowerr, :scope > .err").forEach((x) => x.remove());
    }
  }
  const card = document.querySelector('[data-card="' + c.id + '"]');
  if (card) {
    for (const d of card.querySelectorAll("[data-draft]")) if (d !== document.activeElement) d.value = p.call[d.dataset.draft] ?? d.value;
    for (const t of card.querySelectorAll("[data-tick]")) t.checked = !!p.ticks[t.dataset.tick];
  }
  const sb = document.querySelector('[data-sticky="' + c.id + '"] [data-sbv]');
  if (sb && !isAction(c)) {
    const t = callText(policyOf(c), p.call, c);
    sb.textContent = t === "no fields" ? "none yet" : t;
  }
  savePicks();
}
const armText = (open, n) => "<span class=dv>" + open + "</span> of <span class=dv>" + n + "</span> steps are not ticked. If you did them, press Done again in a second.";
function actionZone(c) {
  const p = pickOf(c);
  const steps = [];
  const walk = (bs) => (bs || []).forEach((b) => (b.type === "checklist" ? steps.push(...b.items) : b.type === "fold" ? walk(b.blocks) : 0));
  walk(c.packet && c.packet.blocks);
  const open = steps.filter((_, j) => !p.ticks[j]).length;
  return (
    '<section class="zone yourcall" data-callzone="' + esc(c.id) + '"><div class="zlabel"><span>Your part</span></div>' +
    '<textarea data-note rows="2" aria-label="Note" placeholder="Note: what happened">' + esc(p.note) + "</textarea>" +
    '<div class="actions"><button class="btn primary" data-done aria-label="Done" aria-keyshortcuts="d">Done<kbd aria-hidden="true">d</kbd></button><button class="btn" data-failed>Could not do it<span class="kh" aria-hidden="true"> (f)</span></button><button class="btn" data-later title="Move it to the end of the queue on this device">Later<span class="kh" aria-hidden="true"> (l)</span></button></div>' +
    hintLine(c) +
    // Below the buttons, so Done does not move (V4).
    '<p class="err" role="alert" data-armwarn' + (p.armed && open ? "" : " hidden") + ">" + (p.armed && open ? armText(open, steps.length) : "") + "</p>" +
    (p.err ? '<div class="err" role="alert">' + esc(p.err) + "</div>" : "") +
    "</section>"
  );
}

function sourceLink(m) {
  if (m.raw && /^https?:/.test(m.raw)) return '<a href="' + esc(m.raw) + '" target="_blank" rel="noopener">Open the source' + (m.source ? " (" + esc(m.source) + ")" : "") + "</a>";
  // A demo card has no source to open; the packet names its author.
  if (String(m.raw || "").startsWith("demo:")) return "";
  return m.source ? "From " + esc(m.source === "antifeed" ? "Antifeed" : m.source) : "";
}

// The card head (slice 8 walk). Desk: the items wrap at the left, Previous
// and Next stay at the right of the first row. Phone: the kind and Previous
// / Next on row 1, then one fold with the board priority and the age as its
// summary and the rest inside; a "changed" warning stays in view.
function metaHtml(c, meta, nav) {
  const span = (x) => (x.startsWith('<span class="kind"') ? x : "<span>" + x + "</span>");
  if (DESK.matches) return '<div class="meta"><div class="mitems">' + meta.map(span).join("") + "</div>" + nav + "</div>";
  const m = c.meta || {};
  const warn = meta.filter((x) => x.includes('class="changed"'));
  const rest = meta.slice(1).filter((x) => !warn.includes(x));
  const sum = [m.priority ? "Board <span class=dv>" + esc(m.priority) + "</span>" : onBoard(c) ? "No board priority" : "", m.openedAt ? ptTime(m.openedAt) : ""].filter(Boolean).join(" · ");
  // Walk 2: the summary names what the fold opens, by the items in it; a source with no link by its own words.
  const src = sourceLink(m);
  const more = [c.subject && policyOf(c).subjectLabel !== null ? "task id" : "", m.effort ? "effort" : "", m.createdBy ? "sender" : "", src.startsWith("<a") ? "link" : src ? src.charAt(0).toLowerCase() + src.slice(1) : "", c.version > 1 && !isAction(c) ? "version" : ""].filter(Boolean);
  return (
    '<div class="meta">' + meta[0] + nav + "</div>" +
    (rest.length ? '<details class="metamore"' + (openFolds.has("meta:" + c.id) ? " open" : "") + ' data-dkey="meta:' + esc(c.id) + '"><summary>' + (sum || "Details") + (more.length ? '<span class="muted"> · ' + more.join(", ") + "</span>" : "") + '</summary><div class="mitems">' + rest.map(span).join("") + "</div></details>" : "") +
    warn.map((x) => '<div class="meta">' + span(x) + "</div>").join("")
  );
}

// ---- the loop kind (Nil, 2026-10-30: "yeah" on Isomux PM's finding: the Loop
// app's triage card got 553 calls in 10 days; copied from ~/nil/isomux-loop
// src/client.js openCard, head and body) --------------------------------------
const isLoop = (c) => !!c && !isAction(c) && policyOf(c).cardKind === "loop";
// Nil, 2026-10-30: a loop-kind card is open as soon as its packet comes; its Premove is not shown.
function loopOpen(v) {
  if (!v) return v;
  const loop = new Set(v.policies.filter((p) => p.cardKind === "loop").map((p) => p.id));
  for (const c of v.cards) if (c.state === "predicting" && c.kind !== "action" && loop.has(c.policy)) c.state = "open";
  return v;
}
// The packet creator's pick: the option named in recommended.
const loopPick = (c) => { const o = (c.packet && c.packet.options) || []; return o.find((x) => x.id === c.packet.recommended) || o[0] || null; };
const takesPriority = (ch) => ch === "go" || ch === "design" || ch === "hold";
// "P1 · go", or "backlog" and "obsolete", which have no priority.
const loopSummary = (call) => ("call" in call ? (call.call === "revert" ? "Revert" : "Approve") : call.choice == null ? "none yet" : takesPriority(call.choice) ? (call.priority || "no priority") + " · " + valueLabel(call.choice) : valueLabel(call.choice));
function daysAgo(ms) {
  if (!ms) return "";
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? "today" : d === 1 ? "1 day ago" : d + " days ago";
}
const loopChip = (field, v, on, mark) =>
  '<button class="chip' + (on ? " on" : "") + (mark ? " pm" : "") + '" aria-pressed="' + on + '" data-field="' + esc(field) + '" data-v="' + esc(JSON.stringify(v)) + '"' + (mark ? ' aria-description="The packet creator\'s pick"' : "") + ">" + esc(valueLabel(v)) + "</button>";
function loopCardHtml(c, nav) {
  const p = pickOf(c);
  const pick = loopPick(c);
  const fill = (pick && pick.fill) || {};
  const m = c.meta || {};
  const info = c.subjectInfo || {};
  const title = info.title || c.packet.question;
  const tag = /^\[\s*([a-z]+)\s*\|\s*([^\]]*?)\s*\]/.exec(title);
  const board = (info.priority || m.priority || "no priority") + " · " + (tag ? tag[1] + " | " + tag[2] : "no tag");
  const yours = p.rewrite ? "rewrite" : loopSummary(p.call);
  const pk = c.packet;
  // Part I (Nil, 2026-10-30): one image shows above the chips; a second one
  // goes to the Evidence fold.
  const imgs = pk.blocks.filter((b) => b.type === "image");
  const why = pk.blocks.filter((b) => b.type !== "fold" && b.type !== "image");
  const folds = pk.blocks.filter((b) => b.type === "fold");
  if (imgs.length > 1) {
    const ev = folds.findIndex((b) => /^evidence$/i.test(b.title));
    if (ev >= 0) folds[ev] = { ...folds[ev], blocks: [...folds[ev].blocks, ...imgs.slice(1)] };
    else folds.push({ type: "fold", title: "Evidence", blocks: imgs.slice(1) });
  }
  const desc = info.description ? fold("desc:" + c.id, "Current description", '<div class="ldesc">' + esc(info.description) + "</div>", "fold") : "";
  const choice = p.rewrite ? "rewrite" : p.call.choice;
  // Nil, 2026-10-30 (part H): the call is in reach with no scroll. Above the
  // chips only the head line and the title; the rest below Confirm, in folds.
  // Part H (3): a pick that is not go says why not under the title: the why's
  // first sentence, cut at 20 words.
  const first = ((why.find((b) => b.type === "markdown") || {}).text || "").trim().split(/(?<=[.!?])\s+/)[0] || "";
  const fw = first.split(/\s+/).filter(Boolean);
  const reason = fw.length > 20 ? fw.slice(0, 20).join(" ") + "…" : first;
  const whyFold = why.length ? fold("why:" + c.id, "Why", blocks(why, c), "fold") : "";
  const scopeFold = fill.title || fill.scope ? fold("scope:" + c.id, "Proposed scope", (fill.title ? '<div class="ltitle">' + esc(fill.title) + "</div>" : "") + (fill.scope ? '<div class="ldesc">' + esc(fill.scope) + "</div>" : ""), "fold") : "";
  let h =
    '<article class="card loop" style="--kc:' + esc(kindOf(c).color) + '" data-card="' + esc(c.id) + '">' +
    // Nil, 2026-10-30: who filed it, when, and the task id (with Copy) at the top with the other metadata.
    '<div class="meta lhead" data-shown="' + esc(c.id) + '" data-v="' + c.version + '"><span class="linfo"><span>Board: ' + esc(board) + ' → yours: <b data-yours>' + esc(yours) + "</b> · effort " + esc(m.effort || "?") + "</span>" +
    "<span>Filed by " + esc(m.createdBy || "unknown") + "</span>" + (info.createdAt ? "<span>" + esc(daysAgo(info.createdAt)) + "</span>" : "") +
    (c.subject ? '<span class="tid">Task <code>' + esc(c.subject) + '</code> <button class="btn small" data-copy="' + esc(c.subject) + '" title="Copy the task id">' + (copied.text === c.subject && Date.now() < copied.until ? "Copied" : "Copy") + "</button></span>" : "") +
    "</span>" + nav + "</div>" +
    '<div class="question">' + esc(title) + "</div>" +
    (c.reopened && c.state === "open" ? '<div class="lreason changed">' + esc(c.reopened) + "</div>" : "") +
    (fill.choice && fill.choice !== "go" && reason ? '<div class="lreason">' + esc(reason) + "</div>" : "") +
    (imgs.length ? '<div class="lshot">' + loopShot(imgs[0], c) + "</div>" : "") +
    '<section class="zone yourcall loopcall" data-callzone="' + esc(c.id) + '">' +
    '<div class="frow" data-frow="choice"><span class="flabel">Choice</span>' +
    LOOP_CHOICES.map((v) => loopChip("choice", v, !p.rewrite && p.call.choice === v, fill.choice === v)).join("") +
    '<button class="chip' + (p.rewrite ? " on" : "") + '" aria-pressed="' + !!p.rewrite + '" data-loopw title="Ask the packet creator to write it again, as your note says (w)">rewrite</button></div>' +
    (!p.rewrite && takesPriority(choice) ? '<div class="frow" data-frow="priority"><span class="flabel">Priority</span>' + ["P0", "P1", "P2", "P3"].map((v) => loopChip("priority", v, p.call.priority === v, fill.priority === v)).join("") + "</div>" : "") +
    '<textarea data-note rows="1" aria-label="Note" placeholder="' + (p.rewrite ? "Note: what to write differently (needed)" : "Note for the packet creator (optional)") + '">' + esc(p.note) + "</textarea>" +
    (p.err ? '<div class="err" role="alert">' + esc(p.err) + "</div>" : "") +
    '<div class="actions"><button class="btn primary" data-confirm aria-label="Confirm" aria-keyshortcuts="Control+Enter">Confirm<kbd aria-hidden="true">Ctrl+Enter</kbd></button></div>' +
    "</section>" +
    whyFold + scopeFold + desc + (folds.length ? blocks(folds, c) : "") +
    "</article>";
  return h;
}
// The loop card's image: cropped around its focus as thumb() does, at most
// 260 px tall (120 px on a phone, layoutCrop), no hint line; a tap opens it whole.
function loopShot(b, c) {
  const f = focusOf(b);
  const img = '<img src="/api/blobs/' + esc(b.blob) + '" alt="' + esc(b.caption || "image") + '">';
  return (
    '<button class="thumb' + (f ? " focus" : "") + '" data-lb="' + esc(c.id) + '" data-src="' + esc(b.blob) + '" data-cap="' + esc(b.caption || "") + '"' + (f ? ' data-focus="' + [f.x, f.y, f.w, f.h].join(",") + '"' : "") + ' title="' + VERB + (f ? " to see the whole image" : " to open it large") + '">' +
    (f ? '<span class="crop">' + img + '<i class="redbox"></i></span>' : img) + (b.caption ? "<span>" + esc(b.caption) + "</span>" : "") + "</button>"
  );
}
const LOOP_CHOICES = ["go", "design", "hold", "backlog", "obsolete"];

// ---- sign-off (Part J, Nil's go 2026-10-30; his rulings in
// projects/isomux/LOOP-APP-FEEDBACK.md, Sign-off): the loop kind with two
// answers, Approve and Revert; the Scout's pick starts the call; a comment
// field per string and per screenshot, with the Scout's suggestions in their
// places (only Use fills a field); the rest in folds under Confirm.
const isSO = (c) => isLoop(c) && c.policy === "signoff";
const soComments = (t) => {
  try {
    const o = typeof t === "string" ? JSON.parse(t) : t || {};
    return { copy: { ...(o.copy || {}) }, images: { ...(o.images || {}) } };
  } catch {
    return { copy: {}, images: {} };
  }
};
const soClean = (cm) => {
  const clean = (m) => Object.fromEntries(Object.entries(m || {}).filter(([, t]) => String(t).trim()));
  return { copy: clean(cm && cm.copy), images: clean(cm && cm.images) };
};
const soScout = (c) => (c.meta && c.meta.scout) || { verdict: "look", confidence: 0.5, suggestions: { copy: {}, images: {} } };
const VERDICT_WORDS = { stamp: "Quick stamp", look: "Look closer", pushback: "Push back" };
// A suggestion keyed on either image of a pair shows in the pair's field, on its first image (the Loop app's onPairFirst).
function soSuggestions(c) {
  const s = soScout(c).suggestions || {};
  const imgs = (c.subjectInfo && c.subjectInfo.signoff && c.subjectInfo.signoff.images) || [];
  const images = {};
  for (const [k, v] of Object.entries(s.images || {})) {
    const im = imgs[Number(k)];
    const key = im && im.pair ? String(imgs.findIndex((x) => x.pair === im.pair)) : k;
    images[key] = images[key] ? images[key] + " " + v : v;
  }
  return { copy: { ...(s.copy || {}) }, images };
}
const soSugCount = (c) => { const s = soSuggestions(c); return Object.keys(s.copy).length + Object.keys(s.images).length; };
// Word-level diff (LCS), copied from the Loop app's client.js (read only); too long a pair has no marks.
// Part M (Nil, 2026-10-30): when more than half of the words of the longer side
// are marked, Old and New show as plain text with no marks.
function wordDiff(a, b) {
  const x = a.split(/(\s+)/);
  const y = b.split(/(\s+)/);
  if (x.length * y.length > 4_000_000) return [esc(a), esc(b)];
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0;
  let j = 0;
  let oldH = "";
  let newH = "";
  let dels = 0;
  let inss = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      oldH += esc(x[i]);
      newH += esc(y[j]);
      i++;
      j++;
    } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) {
      if (/^\s*$/.test(y[j])) newH += esc(y[j]);
      else {
        newH += "<ins>" + esc(y[j]) + "</ins>";
        inss++;
      }
      j++;
    } else {
      if (/^\s*$/.test(x[i])) oldH += esc(x[i]);
      else {
        oldH += "<del>" + esc(x[i]) + "</del>";
        dels++;
      }
      i++;
    }
  }
  const words = (t) => t.filter((w) => !/^\s*$/.test(w)).length;
  const [nx, ny] = [words(x), words(y)];
  if (nx >= ny ? dels * 2 > nx : inss * 2 > ny) return [esc(a), esc(b)];
  return [oldH, newH];
}
// Soft line breaks joined (Nil, 2026-10-19: "this adds unnecessary line breaks"), as the Loop app's unwrap.
function unwrapText(text) {
  const block = (l) => /^\s*([-*+>|#]|\d+[.)]\s)/.test(l) || /^\s/.test(l);
  const lines = text.split("\n");
  let out = lines[0] ?? "";
  for (let i = 1; i < lines.length; i++) {
    const join = lines[i - 1].trim() && lines[i].trim() && !block(lines[i]) && !/^\s*(#|\|)/.test(lines[i - 1]);
    out += (join ? " " : "\n") + lines[i];
  }
  return out;
}
// A comment field, with the Scout's suggestion above it: selectable text, and Use fills the field.
function soCommentBox(c, kind, n) {
  const p = pickOf(c);
  const v = (p.comments && p.comments[kind] && p.comments[kind][String(n)]) || "";
  const sug = soSuggestions(c)[kind][String(n)];
  return (sug ? '<div class="sosug"><div class="sosughead"><b>Suggested comment</b> <span class="muted">by the Scout</span><button class="btn small" data-souse="' + esc(kind + ":" + n) + '" title="Put this text in the comment field">Use</button></div><div class="sosugtext">' + esc(sug) + "</div></div>" : "") +
    '<textarea rows="1" class="socomment" data-socomment="' + esc(kind + ":" + n) + '" placeholder="Comment: a note, or new text in quotes" aria-label="Comment">' + esc(v) + "</textarea>";
}
function soCardHtml(c, nav) {
  const p = pickOf(c);
  const info = (c.subjectInfo && c.subjectInfo.signoff) || { copy: [], images: [], summary: "", commit: "", mergedAt: null, taskId: c.subject };
  const sc = soScout(c);
  const pk = c.packet;
  const why = ((pk.blocks || []).find((b) => b.type === "markdown") || {}).text || "";
  const shots = (pk.blocks || []).filter((b) => b.type === "image");
  const nSug = soSugCount(c);
  const yours = loopSummary(p.call);
  // The Copy changes fold starts open when the verdict is not stamp (Nil, 2026-10-22: suggestions must not be missed).
  const copyKey = "socopy:" + c.id;
  const imgKey = "soimgs:" + c.id;
  if (!soOpened.has(c.id + "@" + c.version)) {
    soOpened.add(c.id + "@" + c.version);
    if (sc.verdict !== "stamp") {
      if (info.copy.length) openFolds.add(copyKey);
      if (Object.keys(soSuggestions(c).images).length) openFolds.add(imgKey);
    }
  }
  // Copy members read first at full weight; agent entries after, dimmed (Nil, 2026-10-19).
  const entries = info.copy.map((x, n) => [x, n]);
  const ordered = entries.filter(([x]) => x.audience !== "agent").concat(entries.filter(([x]) => x.audience === "agent"));
  const copyHtml = ordered.map(([x, n]) => {
    const [o, nw] = wordDiff(unwrapText(x.old || ""), unwrapText(x.new || ""));
    const agent = x.audience === "agent";
    return '<div class="soentry' + (agent ? " agent" : "") + '"><div class="sowhere"><span class="aud">' + (agent ? "for agents" : "for members") + "</span> " + esc(x.where) + '</div><div class="socols"><div><div class="flabel">Old</div><div class="socopy">' + (x.old ? o : '<span class="muted">New copy</span>') + '</div></div><div><div class="flabel">New</div><div class="socopy">' + nw + "</div></div></div>" + soCommentBox(c, "copy", n) + "</div>";
  }).join("");
  // Screenshots: pairs side by side (one comment on the pair's first image), lone images each with theirs.
  const imgs = info.images || [];
  const asBlock = (im) => ({ type: "image", blob: im.blob, caption: im.caption, ...(im.pair && im.side ? { pair: { name: im.pair, side: im.side } } : {}) });
  const groups = [];
  imgs.forEach((im, n) => {
    if (im.pair) {
      const g = groups.find((x) => x.pair === im.pair);
      if (g) return void g.list.push(asBlock(im));
      return void groups.push({ pair: im.pair, first: n, list: [asBlock(im)] });
    }
    groups.push({ pair: null, first: n, list: [asBlock(im)] });
  });
  let imgHtml = groups.map((g) => '<div class="sogroup">' + thumbRow(g.list, c) + soCommentBox(c, "images", g.first) + "</div>").join("");
  // A visual item with no shot keeps the Scout's image suggestion ("a marked shot") in its field (Nil, 2026-10-23).
  if (!imgs.length && Object.keys(soSuggestions(c).images).length) imgHtml = '<div class="sogroup"><p class="muted">The item has no screenshot.</p>' + soCommentBox(c, "images", Object.keys(soSuggestions(c).images)[0]) + "</div>";
  const nCopy = info.copy.length;
  const folds =
    (nCopy ? fold(copyKey, "Copy changes (" + nCopy + ")", copyHtml, "fold") : "") +
    (imgHtml ? fold(imgKey, "Screenshots (" + imgs.length + ")", imgHtml, "fold") : "") +
    (info.summary ? fold("sosum:" + c.id, "Summary", '<div class="ldesc">' + esc(info.summary) + "</div>", "fold") : "") +
    fold("socommit:" + c.id, "Commit", "<p>Commit <code>" + esc(info.commit || "") + "</code>" + (info.mergedAt ? ", merged " + esc(daysAgo(info.mergedAt)) : "") + "</p>", "fold") +
    fold("sotask:" + c.id, "Task", "<p>Task <code>" + esc(info.taskId || c.subject || "") + "</code>: " + esc((c.subjectInfo && c.subjectInfo.title) || "") + "</p>", "fold");
  const chip = (v, label) => '<button class="chip' + (p.call.call === v ? " on" : "") + ((loopPick(c) || { fill: {} }).fill.call === v ? " pm" : "") + '" aria-pressed="' + (p.call.call === v) + '" data-field="call" data-v="' + esc(JSON.stringify(v)) + '"' + ((loopPick(c) || { fill: {} }).fill.call === v ? ' aria-description="The Scout\'s pick"' : "") + ' title="' + esc(label) + " (" + v[0] + ')">' + esc(label) + "</button>";
  return (
    '<article class="card loop so" style="--kc:' + esc(kindOf(c).color) + '" data-card="' + esc(c.id) + '">' +
    '<div class="meta lhead" data-shown="' + esc(c.id) + '" data-v="' + c.version + '"><span>Sign-off · yours: <b data-yours>' + esc(yours) + "</b> · Scout: " + esc(VERDICT_WORDS[sc.verdict] || sc.verdict) + "</span>" + nav + "</div>" +
    '<div class="question">' + esc(pk.question) + "</div>" +
    (sc.verdict !== "stamp" && why ? '<div class="lreason">' + esc(why) + "</div>" : "") +
    (nSug ? '<div class="sosugline"><button class="btn small" data-soopen="' + esc(c.id) + '" title="Open the folds with the Scout\'s suggested comments">' + nSug + " suggested comment" + (nSug > 1 ? "s" : "") + "</button></div>" : "") +
    (shots.length ? '<div class="lshot lpair">' + thumbRow(shots, c) + "</div>" : "") +
    '<section class="zone yourcall loopcall" data-callzone="' + esc(c.id) + '">' +
    '<div class="frow" data-frow="call"><span class="flabel">Call</span>' + chip("approve", "Approve") + chip("revert", "Revert") + "</div>" +
    '<textarea data-note rows="1" aria-label="Note" placeholder="' + (p.call.call === "revert" ? "Note: what is wrong (needed)" : "Note (optional): it files a changes task") + '">' + esc(p.note) + "</textarea>" +
    (p.err ? '<div class="err" role="alert">' + esc(p.err) + "</div>" : "") +
    '<div class="actions"><button class="btn primary" data-confirm aria-label="Confirm" aria-keyshortcuts="Control+Enter">Confirm<kbd aria-hidden="true">Ctrl+Enter</kbd></button></div>' +
    "</section>" +
    '<div class="meta lfiled"><span>Task <code>' + esc(info.taskId || c.subject || "") + "</code></span>" + (info.mergedAt ? "<span>merged " + esc(daysAgo(info.mergedAt)) + "</span>" : "") + "</div>" +
    folds +
    "</article>"
  );
}
const soOpened = new Set();
// Decided counts a revert down to the Loop app's send (Nil, 2026-10-24: "can sign off have an undo?").
setInterval(() => {
  if (tab !== "decided" || !V) return;
  const ticking = cards().some((c) => c.policy === "signoff" && c.decision && (c.sends || []).length && (soSentText(c, c.sends[c.sends.length - 1]) || {}).tick);
  if (ticking) redraw();
}, 1000);
// What the Loop app does after a sign-off call reached it (Decided and the row).
const REVERT_HOLD_MS = 60_000;
function soSentText(c, k) {
  const call = (c.decision && c.decision.call) || {};
  if (k.type === "signoff.undo") return k.state === "done" ? { html: "Undone on the Loop app " + ptTime(k.doneAt) + ".", gone: true } : null;
  if (k.type !== "signoff.apply" || k.state !== "done" || k.notSent) return null;
  if (call.call === "revert") {
    const left = Math.ceil((Date.parse(k.doneAt) + REVERT_HOLD_MS - 5_000 - Date.now()) / 1000);
    return left > 0
      ? { html: "On the Loop app " + ptTime(k.doneAt) + ": Isomux Main gets the revert in " + (left + 5) + " s; Undo until then.", gone: false, tick: true }
      : { html: "Isomux Main has the revert request (sent by the Loop app 60 s after your Revert); it cannot be undone.", gone: true };
  }
  const files = !!(call.note && call.note.trim()) || !!call.comments;
  return { html: "Approved on the Loop app " + ptTime(k.doneAt) + (files ? ": it files the changes task, and the push waits for it." : ": it goes with the next push.") + " Undo until the push.", gone: false };
}

function cardHtml(c, i, n) {
  const m = c.meta || {};
  const meta = [
    kindChip(c),
    c.subject && policyOf(c).subjectLabel !== null ? '<span class="tid" title="The id of this packet\'s task in its source">Task <code>' + esc(c.subject) + '</code> <button class="btn small" data-copy="' + esc(c.subject) + '" title="Copy the task id">' + (copied.text === c.subject && Date.now() < copied.until ? "Copied" : "Copy") + "</button></span>" : "",
    m.priority ? '<span title="The priority the task has on its board now">Board <span class=dv>' + esc(m.priority) + "</span></span>" : onBoard(c) ? '<span title="The task has no priority on its board yet">No board priority</span>' : "",
    m.effort ? '<span title="The packet creator\'s estimate of the work. ' + esc(HELP_EFFORT[m.effort] || m.effort) + '">Effort <span class=dv>' + esc(m.effort) + "</span></span>" : "",
    m.createdBy ? (policyOf(c).createdByLabel ? '<span title="Who sent it">' + esc(policyOf(c).createdByLabel) + " " : '<span title="Who filed the task">Filed by ') + agentChip(m.createdBy) + "</span>" : "",
    // Nil, 2026-10-29: no Packet section, so the packet creator is named here when it is not the sender.
    actorName(m.author) && actorName(m.author) !== m.createdBy ? "<span>" + T("creator", "Packet creator") + ": " + agentChip(actorName(m.author)) + "</span>" : "",
    m.openedAt ? '<span title="When the packet came into the queue"><span class="long">Queued </span>' + ptTime(m.openedAt) + "</span>" : "",
    sourceLink(m),
    c.version > 1 && !isAction(c) ? '<span title="The packet creator wrote this packet again: this is version ' + c.version + '">Version <span class=dv>' + c.version + "</span></span>" : "",
    c.changedAfterPacket ? '<span class="changed">The task changed after this packet; a new one is coming.</span>' : "",
    c.reopened && c.state === "open" ? '<span class="changed">' + esc(c.reopened) + "</span>" : "",
  ].filter(Boolean);
  const pk = c.packet || { question: "(no packet yet)", blocks: [] };
  const packet = isAction(c)
    ? '<section class="zone packet"><div class="zlabel"><span>' + (policyOf(c).actionLabel ? "Details" : "Steps") + "</span></div>" + (blocks(pk.blocks, c) || '<p class="muted">The question says it all.</p>') + "</section>"
    : (() => {
        // Nil, 2026-10-29 ("the task is described AGAIN in this packet section"): the packet's
        // blocks show once, under the question, with no section of their own.
        const pb = packetBody(c);
        return pb ? '<section class="packet pbody">' + pb + (hasFolds(c) ? '<div class="pfolds">' + foldsButton(c) + "</div>" : "") + "</section>" : "";
      })();
  // Walk 2: a disabled button has no key hint; its key does nothing.
  const kh = (key, off) => (off ? "" : '<span class="kh" aria-hidden="true"> (' + key + ")</span>");
  const nav = n > 1 ? '<span class="cardnav"><button class="btn small" data-step="-1" aria-label="Previous packet"' + (i <= 0 ? " disabled" : "") + '><span class="long">Previous</span><span class="short">‹</span>' + kh("k", i <= 0) + '</button><button class="btn small" data-step="1" aria-label="Next packet"' + (i >= n - 1 ? " disabled" : "") + '><span class="long">Next</span><span class="short">›</span>' + kh("j", i >= n - 1) + "</button></span>" : "";
  if (isSO(c)) return soCardHtml(c, nav);
  if (isLoop(c)) return loopCardHtml(c, nav);
  // L154: Your call, with its options, comes before the long packet:
  // the question, Premove and Against, Your call, then the packet.
  // Round q1, H1: the chat with the card's consult, full width under Premove and Against
  // (the same consult wrote both), in place of a link to its office chat (H3).
  const body = isAction(c) ? packet + actionZone(c) : packet + '<div class="pa">' + premoveZone(c) + againstZone(c) + "</div>" + chatPanel(c) + callZone(c);
  return (
    '<article class="card' + (isAction(c) ? " action" + (policyOf(c).actionLabel ? " own" : "") : "") + '" style="--kc:' + esc(kindOf(c).color) + '" data-card="' + esc(c.id) + '">' +
    metaHtml(c, meta, nav) +
    '<div class="question">' + esc(questionOf(c) || pk.question) + "</div>" +
    body + "</article>"
  );
}

// The sticky bar: Nil's call and Confirm, while the call zone is off the screen.
function stickyBar(c) {
  if (!c) return "";
  if (isAction(c)) return '<div class="stickybar" data-sticky="' + esc(c.id) + '" style="--guard:' + guardMs() + 'ms" hidden><span class="sbcall">Your part: ' + esc(policyOf(c).actionLabel ? "the " + policyOf(c).actionLabel.replace(/ for you$/, "").toLowerCase() : "the steps") + '</span><span class="sbbtns"><button class="btn primary" data-done>Done</button><button class="btn" data-jump>Go to it</button></span></div>';
  const p = pickOf(c);
  const t = callText(policyOf(c), p.call, c);
  return '<div class="stickybar" data-sticky="' + esc(c.id) + '" style="--guard:' + guardMs() + 'ms" hidden><span class="sbcall">Your call: <b data-sbv>' + esc(t === "no fields" ? "none yet" : t) + '</b></span><span class="sbhint"></span><span class="sbbtns"><button class="btn primary" data-confirm>Confirm</button><button class="btn" data-jump>Change it</button></span></div>';
}

function rowRight(c) {
  if (isAction(c)) return "Your part";
  if (isLoop(c)) return loopPick(c) ? "Yours: <span class=dv>" + esc(loopSummary(loopPick(c).fill)) + "</span>" : "";
  const p = c.prediction;
  if (!p) return "";
  if (noBasis(p)) return "No basis: pick yourself";
  const lp = c.latePrediction;
  const call = "<span class=dv>" + esc(callText(policyOf(c), p.call, c)) + "</span>";
  if (lp) return "Stand-in: " + call + ", " + confHtml(p, c) + (callText(policyOf(c), lp.call, c) === callText(policyOf(c), p.call, c) ? "; <span class=dv>" + esc(consultName(c.project)) + "</span> agrees" : "; <span class=dv>" + esc(consultName(c.project)) + "</span> says <span class=dv>" + esc(callText(policyOf(c), lp.call, c)) + "</span>");
  return (isStandin(p) ? "Stand-in: " : "Premove: ") + call + ", " + confHtml(p, c) + (isStandin(p) && c.predict === "started" && !c.latePrediction ? ", <span class=dv>" + esc(consultName(c.project)) + "</span> still working" : "");
}
// A row whose Premove line changed says so for a minute ("updated").
const rowWas = {};
const zoneWas = {};
const zoneChangedAt = {};
const rowChangedAt = {};
function rowHtml(c) {
  const p = c.prediction;
  const later = laterIds().includes(c.id) ? '<span class="latertag">Later</span> ' : "";
  const right = rowRight(c);
  if (rowWas[c.id] !== undefined && rowWas[c.id] !== right) rowChangedAt[c.id] = Date.now();
  rowWas[c.id] = right;
  const upd = Date.now() - (rowChangedAt[c.id] || 0) < 60_000 ? '<span class="updtag">updated</span> ' : "";
  const answer = chatUnread(c) ? '<span class="newtag" title="The Predictor answered your message on this packet">New answer</span> ' : "";
  return '<button class="row" style="--kc:' + esc(kindOf(c).color) + '" data-cur="' + esc(c.id) + '"' + (p ? ' data-shown="' + esc(c.id) + '" data-v="' + c.version + '"' : "") + ">" + kindChip(c) + '<span class="q">' + later + esc(questionOf(c) || c.id) + '</span><span class="rp">' + answer + upd + right + "</span></button>";
}

function waitingRow(c) {
  const k = c.state === "predicting" ? consultName(c.project) + " is predicting" : "The packet creator is writing the packet";
  return '<div class="row waiting" style="--kc:' + esc(kindOf(c).color) + '">' + kindChip(c) + '<span class="q">' + (c.packet ? esc(questionOf(c)) : "A new packet for <span class=dv>" + esc(c.subject || c.id) + "</span>") + '</span><span class="rp">' + esc(k) + ", " + esc(ago(c.meta && c.meta.openedAt)) + "</span></div>";
}

function queueParts() {
  const { list, waiting, total, open } = queueLists();
  if (!list.some((c) => c.id === cur)) setCur(list[0] ? list[0].id : null);
  const i = list.findIndex((x) => x.id === cur);
  const c = list[i];
  if (c) shownAt[c.id + "@" + c.version] ??= new Date().toISOString();
  const out = [];
  // Queue round 1 (S1): a source that cannot be read is one line first, with a
  // link to the Sources tab. Nil's Inbox access is on that tab only.
  const broken = (V.sourceAlerts || []).map((a) => sourceName(a.key));
  if (broken.length) out.push(["sourcealert", '<p class="warn dyn" data-source-alert role="status">Antifeed cannot read ' + broken.map((n) => "the <span class=dv>" + esc(n) + "</span>").join(" and ") + '. <a href="#sources" data-goto="sources">Sources</a> says why.</p>']);
  if (total || filtersOn()) out.push(["controls", filterNote(total, list.length) + controls(total, list.length, open)]);
  // A held action stays in sight, with its Undo, until it is sent.
  const heldNow = cards().filter((x) => x.held);
  if (heldNow.length)
    out.push(["held", '<h2>Waiting to be sent (' + heldNow.length + ')</h2><div class="rows">' + heldNow.map((x) => '<div class="row heldrow" style="--kc:var(--warn)">' + kindChip(x) + '<span class="q">' + esc((x.held.ok ? "Done: " : "Could not do it: ") + questionOf(x)) + '</span><span class="rp">goes out at ' + esc(new Date(x.held.until).toLocaleTimeString("en-US", { timeZone: PT, hour: "numeric", minute: "2-digit", second: "2-digit" })) + ' PT <button class="btn small" data-undo="' + esc(x.id) + '">Undo</button></span></div>').join("") + "</div>"]);
  if (!total && !waiting.length) out.push(["empty", '<div class="empty">The queue is empty. Nothing needs you now. <a href="#decided" data-goto="decided">Your recent calls are in Decided.</a></div>']);
  else if (!list.length && total) out.push(["empty", '<div class="empty">No packet matches these filters.</div>']);
  // The card is drawn again only when its data from the server changes; Nil's
  // own picks are applied in place (syncCall), so no tap is lost.
  if (remoteNotice) {
    const mine = remoteNotice.mine && remoteNotice.mine !== "no fields" ? '<div class="muted dyn">Your pick here (<span class=dv>' + esc(remoteNotice.mine) + "</span>) was not sent.</div>" : "";
    out.push(["remote", '<div class="remote" role="alert"><b>' + esc(remoteNotice.text) + "</b><div>" + esc(remoteNotice.q) + "</div>" + mine + '<button class="btn primary" data-remote-ok>Show the next packet</button></div>']);
    out.push(["sticky", "", ""]);
    return out;
  }
  if (c) {
    const p = pickOf(c);
    const blobs = c.prediction ? [c.prediction.input, c.prediction.answer].filter(Boolean).map((b) => "/api/blobs/" + b) : [];
    const sig = JSON.stringify([c, i, list.length, [...openFolds].filter((k) => k.startsWith(c.id)), blobs.map((u) => (texts[u] === "loading" ? "loading" : typeof texts[u])), p.err, p.errField, isLoop(c) ? [p.call, !!p.rewrite] : null]);
    out.push(["card:" + c.id, () => cardHtml(c, i, list.length), sig]);
  }
  const rest = list.filter((x) => x.id !== cur);
  if (rest.length) out.push(["rest", "<h2>Next in the queue (" + rest.length + ')</h2><div class="rows">' + rest.map(rowHtml).join("") + "</div>"]);
  if (waiting.length) out.push(["waiting", "<h2>Coming (" + waiting.length + ')</h2><div class="rows">' + waiting.map(waitingRow).join("") + "</div>"]);
  // Round Q1, C1: the call bar is at the bottom of the screen on every screen (Nil: the bar over the tabs "doesn't make sense").
  out.push(["sticky", () => stickyBar(c), "bar:" + (c ? c.id + "@" + c.version : "")]);
  return out;
}

// ---- the other tabs -------------------------------------------------------

// What Nil did with the Premove, in words.
function outcomeText(c) {
  const pr = c.prediction;
  // Walk round 3: a Premove with no basis (a safe default, never filled in) says so.
  if (pr && noBasis(pr)) return "no basis";
  if (!pr || c.outcome === "unpredicted") return "no basis";
  if (c.outcome === "matched") return "you confirmed the Premove";
  const was = callText(policyOf(c), pr.call, c);
  return c.outcome === "edited" ? "you edited the Premove (" + was + ")" : c.outcome === "changed" ? "you changed the Premove (" + was + ")" : "";
}
// Slice 7: what Nil's call started, in words, and whether it went out (no Undo then).
// Slice 8: a sent call lands when its effect shows (a Wall Game call line on
// the board); after LANDING_LATE_MS without it, the page says so.
const LANDING_LATE_MS = 24 * 3600_000;
const landingOf = (id) => (V && V.landing ? V.landing.find((l) => l.card === id) : null);
function landingText(l) {
  if (l.landedAt) return { html: "On the board " + ptTime(l.landedAt) + ".", late: false };
  if (Date.now() - Date.parse(l.sentAt) > LANDING_LATE_MS) return { html: '<span class="warn">Not on the board</span>: ' + esc(l.to) + " has not written its line in 24 h.", late: true };
  return { html: "Not on the board yet.", late: false };
}
function sentText(c) {
  const ks = c.sends || [];
  if (!ks.length) return null;
  const k = ks[ks.length - 1];
  const so = c.policy === "signoff" && soSentText(c, k);
  if (so) return so;
  // html: ptTime gives markup (its tip); every other part is escaped here.
  // Slice 8: a call that goes in a burst waits until Nil pauses; Undo works until then.
  if (k.state === "issued" && k.burstMs) return { html: "Goes out once you make no new call of this kind for " + Math.round(k.burstMs / 60000) + " minutes; you can undo it until then.", gone: false };
  if (k.state === "issued") return { html: "Waits for its Undo time, then goes out.", gone: false };
  if (k.state === "cancelled") return { html: esc(packetWords(k.reason) || "Not sent."), gone: true };
  // Slice 8 walk: a send with no clear answer may have gone; say which, and where its failure card is.
  if (k.state === "failed") return { html: (k.maybeSent ? "May have gone: " : "Not sent: ") + esc(packetWords(k.error) || "the office refused it") + "." + (k.failCard ? " A packet for it is in the queue." : k.dropped ? " You dropped it." : ""), gone: true };
  const l = k.state === "done" && landingOf(c.id);
  if (l) return { html: "Sent to " + esc(l.to) + " " + ptTime(k.doneAt) + "; it cannot be taken back. " + landingText(l).html, gone: true };
  if (k.state === "done") return { html: k.notSent ? esc(packetWords(k.notSent)) : "Sent " + ptTime(k.doneAt) + "; it cannot be taken back.", gone: true };
  return { html: "Going out now; it cannot be taken back.", gone: true };
}
// L167: why a card left the queue with no call of Nil's, from the event that withdrew it.
function withdrawnText(c) {
  const w = c.withdrawn || {};
  if (w.reason) return packetWords(w.reason);
  const t = w.task || {};
  if (w.cause === "board.task.closed") return "The task was closed on the board" + (t.status ? " (" + t.status + ")" : "") + ", so it no longer waits for you.";
  if (w.cause === "board.task.changed" || w.cause === "board.task.seen" || w.cause === "board.task.filed") {
    if (/^\[\s*[a-z]+\s*\|/.test(t.title || "")) return "The task got a tag on the board (" + String(t.title).match(/^\[[^\]]*\]/)[0] + "), so it no longer waits for you.";
    if (t.status && t.status !== "open") return "The task is " + t.status + " on the board, so it no longer waits for you.";
    if (t.priority !== undefined && !/^P[0-3]$/.test(String(t.priority))) return "The task moved to " + (t.priority || "no priority") + " on the board, so it no longer waits for you.";
    return "The task changed on the board, so it no longer waits for you.";
  }
  return "Its policy took it back" + (w.cause ? " (after " + w.cause + ")" : "") + ".";
}
// Round q1b, P2: a decided packet opens in place to its details: the packet
// as it was, the Premove and the Against, your call and note, what ran and
// its result, and the chat. The view keeps a decided card slim (no blocks),
// so its blocks load from GET /api/cards/:id when the row first opens.
const fullCards = {}; // card id -> the full card, "loading", or {error}
// It asks once per open: a failed load shows its error until Nil opens the row
// again or presses Try again, so a restart never starts a loop of requests.
function wantCard(id, again) {
  if (fullCards[id] !== undefined && !(again && fullCards[id].error)) return;
  fullCards[id] = "loading";
  fetch("/api/cards/" + encodeURIComponent(id))
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Antifeed answered " + r.status))))
    .then((c) => (fullCards[id] = c))
    .catch((err) => (fullCards[id] = { error: err.message }))
    .finally(() => {
      stale.decided = true;
      if (tab === "decided") drawTab("decided");
    });
}
// A decided packet's drafts and steps show as text: nothing on it is edited now.
const asRead = (list) =>
  (list || []).map((b) =>
    b.type === "draft" ? { type: "fields", rows: [["Draft " + b.key, b.text]] } : b.type === "checklist" ? { type: "fields", rows: b.items.map((x, j) => [String(j + 1), x]) } : b.type === "fold" ? { ...b, blocks: asRead(b.blocks) } : b,
  );
// One command of the call, in words: what it does, who does it, and where it stands.
// Round q1b look (Antifeed PM): "it cannot be taken back" shows only where Undo is gone.
function ranLine(c, k, hasUndo) {
  const decl = (policyOf(c).commands || {})[k.type] || {};
  const head = "<b>" + esc(cap(decl.what || k.type)) + "</b>" + (decl.actor ? ", by " + agentChip(actorWords(c.project, decl.actor)) : "");
  const st = sentText({ ...c, sends: [k] });
  let html = st ? st.html.replace(/^[A-Z]/, (x) => x.toLowerCase()) : esc(STATES[k.state] || k.state);
  if (hasUndo) html = html.replace("; it cannot be taken back.", ".");
  return '<div class="dran">' + head + ": " + html + "</div>";
}
function decidedDetail(c, hasUndo) {
  const sec = (label, body) => '<div class="dsec"><div class="dlab">' + label + "</div>" + body + "</div>";
  const lab = (l, v) => '<div class="dfield"><span class="dlab">' + esc(l) + ":</span> " + esc(v) + "</div>";
  const pol = policyOf(c);
  let out = "";
  // Round q1 P2: a withdrawn row says why once, in the row itself.
  const pr = c.prediction;
  if (!isAction(c)) {
    out += pr
      ? sec(T("premove", "Premove") + " by " + agentChip(shortLabel(pr)), "<p><b>" + esc(noBasis(pr) ? "none: nothing gave a basis" : callText(pol, pr.call, c)) + "</b> · " + esc(confText(pr)) + "</p>" + (pr.why ? "<p>" + esc(pr.why) + "</p>" : "")) +
        (pr.against ? sec(T("against", "Against") + " by " + agentChip(shortLabel(pr)), "<p>" + esc(pr.against) + "</p>") : "")
      : sec(T("premove", "Premove"), "<p>None: nothing made a Premove for this packet.</p>");
  }
  const opts = (c.packet && c.packet.options) || [];
  const d = c.decision;
  if (opts.length && !isAction(c)) {
    const pre = pr && !noBasis(pr) ? opts.find((o) => o.fill && fields(pol).every(([k]) => (o.fill[k] ?? null) === (pr.call[k] ?? null))) : null;
    const mark = (o) => [o.id === c.packet.recommended ? "the packet creator's pick" : "", pre && o.id === pre.id ? "the Premove's pick" : "", d && d.option === o.id ? "your pick" : ""].filter(Boolean);
    out += sec("Options", opts.map((o) => '<div class="dfield"><b>' + esc(optLetter(o)) + ".</b> " + esc(optText(o)) + (mark(o).length ? ' <span class="muted">(' + esc(mark(o).join(", ")) + ")</span>" : "") + "</div>").join(""));
  }
  if (d && !isAction(c)) {
    let body = "";
    for (const [k, f] of Object.entries(pol.answer || {})) if (k !== "note" && f.text && d.call && d.call[k]) body += lab(fieldLabel(k, f), d.call[k]);
    for (const k of Object.keys(d.call || {})) if (!(k in (pol.answer || {})) && k !== "note") body += lab(cap(k) + " text that went with your call" + ((c.editedDrafts || []).includes(k) ? " (you edited it)" : ""), d.call[k]);
    // The note shows in the row itself.
    if (body) out += sec("With your call", body);
  }
  const ran = (c.sends || []).map((k) => ranLine(c, k, hasUndo)).join("");
  if (ran) out += sec("What ran", ran);
  const th = c.thread || [];
  if (th.length) out += sec("Chat with the " + T("predictor", "Predictor"), th.map((m) => '<div class="dmsg"><b>' + (mineMsg(m) ? "You" : agentChip(senderOf(m, consultName(c.project)))) + '</b> <span class="muted">' + ptTime(m.at) + '</span><div class="mtext">' + esc(m.text) + "</div></div>").join(""));
  // The packet as it was: its blocks load when the row first opens.
  const f = fullCards[c.id];
  const full = f && f !== "loading" && !f.error ? f : null;
  const pkBody = full ? asRead((full.packet && full.packet.blocks) || []) : null;
  if (f && f.error) out += '<p class="err">The packet did not load: ' + esc(f.error) + '. <button class="btn small" data-cardagain="' + esc(c.id) + '">Try again</button></p>';
  else out += fold(
    "dec:" + c.id + ":packet",
    isAction(c) ? "The steps as they were" : "Full packet",
    f === "loading" || f === undefined ? '<p class="muted">Loading…</p>' : '<div data-dcard="' + esc(c.id) + '">' + (blocks(pkBody, full) || '<p class="muted">The question is the whole packet.</p>') + (full.meta && full.meta.raw && /^https?:/.test(full.meta.raw) ? '<p><a href="' + esc(full.meta.raw) + '" target="_blank" rel="noopener">The source</a></p>' : "") + "</div>",
    "dpacket",
  );
  // Each row is its own region for the dotted words: a closed row above must not take the underline from an open one.
  return '<div class="ddetail tregion">' + out + "</div>";
}
function decidedParts() {
  const list = cards().filter((c) => (c.decision && (c.state === "decided" || c.state === "preparing")) || (isAction(c) && (c.state === "done" || c.held)) || c.state === "withdrawn");
  if (!list.length) return [["empty", '<div class="empty">No decisions yet. Your calls show here, newest first, each with Undo. So do the actions you finish and the packets that leave the queue with no call of yours.</div>']];
  const lab = (l, v) => '<div class="dfield"><span class="dlab">' + esc(l) + ":</span> " + esc(String(v).slice(0, 300)) + "</div>";
  return [
    ["head", '<p class="muted">Your calls and finished actions, newest first (the last 200 are shown here). ' + VERB + " one to see its details. Undo puts a packet back in the queue with your call. What your call or your Done starts waits " + UNDO_S + " for an Undo; after that it goes out, and an Undo cannot stop it. A packet that left the queue with no call of yours (withdrawn) says why.</p>"],
    [
      "list",
      list
        .map((c) => {
          let what;
          let extra = "";
          let undo = "";
          if (c.state === "withdrawn") {
            what = "Withdrawn";
            extra += ' <span class="muted">· ' + esc(withdrawnText(c)) + "</span>";
          } else if (isAction(c)) {
            const a = c.action || {};
            const failed = a.state === "failed" || (a.state === "held" && !a.ok);
            what = failed ? "Could not do it" : "Done";
            const decl = a.type && (policyOf(c).commands || {})[a.type];
            extra += ' <span class="muted">· ' + (a.state === "held" ? "waits for its Undo time, then goes to its policy" : failed && decl && decl.failedWords ? esc(decl.failedWords) : "sent: its policy may have acted on it, so it cannot be undone") + "</span>";
            if (a.note) extra += lab("Your note", a.note);
            if (a.state === "held") undo = '<button class="btn small" data-undo="' + esc(c.id) + '">Undo</button>';
          } else {
            const d = c.decision;
            const pol = policyOf(c);
            const opts = (c.packet && c.packet.options) || [];
            const og = d.generic && d.generic.option && opts.find((o) => o.id === d.generic.option);
            what = d.generic ? (d.generic.kind === "rewrite" ? "New packet" : "Closer to option " + (og ? optLetter(og) : String(d.generic.option).toUpperCase())) : callText(pol, d.call, c);
            const oo = !d.generic && d.option && opts.find((o) => o.id === d.option);
            if (oo) what += " (option " + optLetter(oo) + ")";
            const oc = d.generic ? "" : outcomeText(c);
            if (oc) extra += ' <span class="muted">· ' + esc(oc) + "</span>";
            if (d.call && d.call.note) extra += lab("Your note", d.call.note);
            if (!String(d.by).startsWith("human:")) extra += ' <span class="muted">(decided by ' + esc(shortLabel(d.by)) + ")</span>";
            // Slice 7: a call that cannot be taken back says what became of it, and has no Undo once it went out.
            // Walk 2: a drop that frees a task waits for its Undo time like a send, and has no Undo after it.
            const tasks = (n) => (n > 1 ? "their tasks" : "its task");
            const out = c.freed ? { html: "Your drop freed " + tasks(c.freed) + "; it cannot be taken back. " + (c.freed > 1 ? "Each task" : "The task") + " may have a new packet.", gone: true } : c.dropping ? { html: "Frees " + tasks(c.dropping) + " when its Undo time ends; you can undo it until then.", gone: false } : pol.undoUntilSent || c.policy === "signoff" ? sentText(c) : null;
            // Slice 8 walk: after a labelled line (a note), the send line is a line of its own, with no leading dot.
            if (out) extra += extra.endsWith("</div>") ? '<div class="muted sendline">' + out.html + "</div>" : ' <span class="muted sendline">· ' + out.html + "</span>";
            undo = out && out.gone ? "" : '<button class="btn small" data-undo="' + esc(c.id) + '">Undo</button>';
          }
          const key = "dec:" + c.id;
          if (openFolds.has(key)) wantCard(c.id);
          return (
            '<div class="line dline" style="--kc:' + esc(kindOf(c).color) + '"><details class="drow" data-dkey="' + esc(key) + '"' + (openFolds.has(key) ? " open" : "") + '><summary title="Show or hide its details"><div class="dtop">' + kindChip(c) + " <span>" + esc(questionOf(c) || c.id) + '</span> <span class="muted dtime">' + ptTime(c.decidedAt) + "</span></div>" +
            '<div><span class="dcall">' + esc(what) + "</span>" + extra + "</div></summary>" + decidedDetail(c, !!undo) + "</details>" + undo + "</div>"
          );
        })
        .join(""),
    ],
  ];
}

// A table that becomes labelled lines on a phone.
// A head cell is its words, or [words, tip].
function rtable(head, rows) {
  const words = (h) => (Array.isArray(h) ? h[0] : h);
  return '<table class="grid resp"><thead><tr>' + head.map((h) => "<th" + (Array.isArray(h) ? ' title="' + esc(h[1]) + '"' : "") + ">" + esc(words(h)) + "</th>").join("") + "</tr></thead><tbody>" + rows.map((r) => "<tr>" + r.map((x, i) => '<td data-label="' + esc(words(head[i])) + '"><span>' + x + "</span></td>").join("") + "</tr>").join("") + "</tbody></table>";
}

// Nil's definition of an effective decision (2026-10-26; DESIGN.md 15).
const NEEDED_TIP = "Calls where two reasonable people could disagree, or where a model may get it wrong (your definition, 2026-10-26): every call you changed or edited, every call with no basis, and every confirm of a Premove that was less than 90% sure by its record.";
const BAND_WORDS = { ">= 0.9": "90% or more", "0.7-0.9": "70% to 89%", "0.5-0.7": "50% to 69%", "< 0.5": "under 50%" };
// From the rate, so a short time never reads as 0 s next to a rate.
function timeOnCards(w) {
  const min = w.dpm ? w.decisions / w.dpm : 0;
  const sec = Math.round(min * 60);
  return sec < 60 ? sec + " s" : Math.round(min) + " min";
}
function accuracyParts() {
  const x = V.accuracy;
  // Slice 8 walk: the kind's name as the queue gives it ("Triage (Wall Game)").
  const name = (id) => { const p = V.policies.find((x) => x.id === id); return p ? kindName(p) : id; };
  let out = readOnly("How often the Premove matches your call, and how fast you decide. A Premove matches when you confirm it as it is. A note you add counts as an edit, so it is not a match.");
  // While no band can be 90% sure, every confirm needed Nil: the two rates are equal.
  const noneSure = x.weeks.every((w) => !w.sureConfirms) && !x.cals.some((c) => c.calibration.some((k) => k.bands.some((b) => b.lower >= 0.9)));
  out += "<h2>Weekly</h2><p class=\"muted\">A week starts on Monday at 00:00 Pacific time, where you live.</p>";
  out += x.weeks.length
    ? rtable(
        ["Week of", "Kind", "Your calls", "Matched the Premove", "Calls per minute", ["Calls that needed you, per minute", NEEDED_TIP], "Time on packets"],
        x.weeks.map((w) => [
          esc(w.week),
          esc(w.policy === "all" ? "All kinds" : name(w.policy)),
          w.decisions + ": " + w.matched + " matched, " + (w.changed - w.noteOnly) + " changed or edited" + (w.noteOnly ? ", " + w.noteOnly + " matched with a note (counts as edited)" : "") + (w.unpredicted ? ", " + w.unpredicted + " with no basis" : ""),
          w.matchRate === null ? "no Premoves" : pct(w.matchRate),
          w.dpm.toFixed(1),
          w.edpm.toFixed(1),
          timeOnCards(w),
        ]),
      ) +
      (noneSure ? '<p data-nonesure>Every confirm counts as needing you until a kind has 35 matching calls in a row at the same confidence.</p>' : "") +
      '<p class="muted">Calls per minute: your calls, divided by the time on packets. Time on packets runs from the moment a packet showed to your call, up to 5 minutes a packet, so fast calls give high numbers. Calls that needed you leave out only your confirms of a Premove that was 90% sure or more by its record. A worse Predictor raises them, so read them next to the match rate. These numbers are worked out again from your calls at each look.</p>'
    : '<p class="muted">No decisions yet.</p>';
  out += "<h2>" + T("calibration", "Calibration") + '</h2><p class="muted">For each Predictor: of its Premoves at each confidence, how many you confirmed as they were. Stand-ins (a quick model run, a vote of your past calls, the packet creator\'s pick, a safe default) and informed Premoves have their own rows. Confidence bands with no Premoves yet are left out. The safe estimate is the match rate that is 95% sure with so few packets: 1 match of 1 gives only 21%.</p>';
  let any = false;
  for (const c of x.cals) {
    const rows = c.calibration.filter((k) => k.bands.some((b) => b.n));
    if (!rows.length) continue;
    any = true;
    out += "<h3>" + esc(name(c.policy)) + "</h3>";
    const sure = x.weeks.filter((w) => w.policy === c.policy).reduce((a, w) => a + w.sureConfirms, 0);
    out += '<p data-sure="' + esc(c.policy) + '">' + sure + " call" + (sure === 1 ? "" : "s") + " you confirmed at 90% or more: candidates for a threshold.</p>";
    for (const k of rows) {
      const inf = k.predictor.endsWith("(informed)");
      const by = k.predictor.replace(/ \(informed\)$/, "");
      const si = by === "code:standin" || by.startsWith("agent:standin@");
      out += "<p><b>" + (si ? "Stand-in: " + esc(predictorLabel(by, k.basis)) : esc(cap(predictorLabel(by, k.basis)))) + (inf ? ", informed" : "") + "</b>" + (k.switchedAt ? " · switched " + ptTime(k.switchedAt) : "") + "</p>";
      out += rtable(["Confidence", "Matched", "Safe estimate (95% sure; low with few packets)"], k.bands.filter((b) => b.n).map((b) => [esc(BAND_WORDS[b.label] || b.label), b.matched + " of " + b.n, pct(b.lower) + (b.frozen ? " · frozen: these packets no longer reach you" : "")]));
    }
  }
  if (!any) out += '<p class="muted">No Premoves on your calls yet.</p>';
  return [["all", out]];
}

// Round 11: `ids` adds the handler's id (Setup, which has every detail); Policies says it in words only.
// Round q1b, G0: the agent that makes the Premove is the Predictor.
function deciderText(cfg, ids, proj) {
  if (!cfg) return "Nobody. The policy does the same for every event.";
  if (cfg.kind === "nil") return "You decide; " + (cfg.predictor ? predictorConfigText(cfg.predictor, ids, proj) + " makes the Premove" : "no Premove");
  if (cfg.kind === "threshold") return cap(predictorConfigText(cfg.agent, ids, proj)) + " decides at " + pct(cfg.min) + " or more; below that, you";
  return cap(predictorConfigText(cfg, ids, proj)) + " decides";
}
function predictorConfigText(cfg, ids, proj) {
  if (!cfg) return "nobody";
  // Round q1 P2: a project with no Predictor agent (the Inbox) gets its Premoves from the stand-in.
  if (cfg.kind === "consult") return proj && !consultOf(proj) ? "a quick model run" : "the Predictor" + (proj && consultAgentOf({ project: proj }) ? " (" + consultName(proj) + ")" : "");
  if (cfg.kind === "agent") return "a model run (" + cfg.model + ")";
  if (cfg.kind === "code") return (proj === "antifeed" ? "a rule inside Antifeed" : "a rule in the policies file") + (ids ? " (" + cfg.handler + ")" : "");
  return cfg.kind;
}
// Who carries out a project's command, in words.
function actorWords(proj, id) {
  const def = projectOf(proj);
  const a = def && def.actors.find((x) => x.id === id);
  return !a ? id : a.kind === "human" ? "you" : a.kind === "agent" ? a.agentName : "a small program inside Antifeed";
}

// Per policy, in words: what it reads, who decides, and what it did, with
// each command counted by its final state (an Undo is never counted as sent).
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);
const STATE_WORDS = [["done", "done"], ["waiting", "waiting"], ["failed", "failed"], ["cancelled", "cancelled"], ["superseded", "closed when a newer packet came"], ["undone", "cancelled by your Undo"], ["doneThenUndone", "ran before your Undo (an Undo does not reverse it)"]];
// G1: the counts are bold. These return html.
const nb = (n) => "<span class=dv>" + Number(n) + "</span>";
function stateCounts(m) {
  const parts = STATE_WORDS.filter(([k]) => m && m[k]).map(([k, w]) => nb(m[k]) + " " + w);
  return parts.length ? parts.join(", ") : "none yet";
}
// Round q1b, P4: every read-only page opens with the same words.
const readOnly = (text) => '<div class="note"><b>Read only.</b> ' + text + "</div>";
const policiesFile = (proj) => "projects/" + proj + "/policies.ts";
// Round q1b, P3: the groups are projects, and each policy says when it sends
// a command and whether it sends one, one of several (as your call says), or
// all of them. A command declares its `when` and, for one of several, `only`.
function policiesParts() {
  let out = readOnly("What each policy reads, who decides, and what it sends, with the numbers so far. A project's policies come from its policies file in the Antifeed repo; a change to a policy is a change to that file. <a href=\"#setup\" data-goto=\"setup\">Setup</a> has every detail.");
  if (V.replayDiffs) out += '<p class="warn">' + V.replayDiffs + " replay differences: see Status.</p>";
  if (V.sourceInfo && V.sourceInfo.moved) out += "<p>" + esc(V.sourceInfo.moved) + "</p>";
  const groups = [...new Set(V.policies.map((p) => p.project))];
  for (const proj of groups) {
    const def = projectOf(proj);
    out += '<section class="tregion">' + (proj === "antifeed" ? "<h2>Built into Antifeed</h2>" : "<h2><span class=\"hpre\">Project:</span> " + esc((def && def.name) || proj) + '</h2><p class="muted pfile">Its policies file: <code>' + esc(policiesFile(proj)) + "</code></p>");
    const pols = V.policies.filter((x) => x.project === proj);
    const from = (t) => {
      const e = def && def.events[t];
      return e ? " from " + [].concat(e.from).join(", ") : "";
    };
    // Round 10: an event or a command says in words what it is; its id is in the tip.
    const named = (kind, id, what) => (what ? '<span class="named" title="' + esc(kind + " " + id) + '">' + esc(what) + "</span>" : esc(id));
    const evWhat = (t) => {
      const e = def && def.events[t];
      return e && e.what ? named("Event", t + from(t), e.what) : esc(t) + esc(from(t));
    };
    const evLine = (t) => T("event", "Event") + ": " + evWhat(t) + '<span class="sep"> · </span><span class="n">' + nb(V.counts[t] || 0) + " in the log</span>";
    // The policies of a project often read the same events: say it once.
    const shared = pols.length > 1 && !pols[0].builtin && pols.every((p) => !p.builtin && p.on.join() === pols[0].on.join()) && pols[0].on.length;
    if (shared) out += '<div class="flowreads"><b>Every policy here reads:</b> ' + pols[0].on.map((t) => '<span class="ev">' + evLine(t) + "</span>").join("") + '<span class="muted">Each event names the policy it is for.</span></div>';
    // Round q1b look: the actor is plain text; it repeats too often to be a link.
    const human = (c) => { const a = def && def.actors.find((x) => x.id === c.actor); return !!(a && a.kind === "human"); };
    // What one policy does: a list of {what, n} (n: its count so far), or
    // {what, subs: [{what, n}]} for a group of commands sent at one time.
    const does = (p) => {
      const f = (V.flow && V.flow[p.id]) || { cards: 0, decided: 0, commands: {} };
      const cmdWhat = (t, c) => (c.what ? named("Command", t, c.what) : esc(t));
      const to = (c) => (human(c) ? "an action for you" : "to " + esc(actorWords(proj, c.actor)));
      // The commands, grouped by when the policy sends them, in the file's order.
      const whens = [];
      for (const [t, c] of Object.entries(p.commands)) {
        const w = c.when || "When its rules say";
        let g = whens.find((x) => x.when === w);
        if (!g) whens.push((g = { when: w, list: [] }));
        g.list.push([t, c]);
      }
      // One command: "After your call, it sends one command to Isomux Curator: write your call to the board".
      const one = (g) => {
        const [t, c] = g.list[0];
        return "<b>" + esc(g.when) + ", " + (human(c) ? "it gives you one action" : "it sends one command " + to(c)) + ":</b> " + cmdWhat(t, c);
      };
      const groupHead = (g) => "<b>" + esc(g.when) + ", it sends " + (g.list.some(([, c]) => c.only) ? "one of these, as your call says" : "all of these") + ":</b>";
      return [
        ...(p.answer ? [{ what: "Gives you a packet to decide", n: nb(f.cards) + (f.cards === 1 ? " packet" : " packets") + ", " + nb(f.decided) + " decided now" }] : []),
        ...(p.predictor && p.predictor.kind === "consult"
          ? [!consultOf(proj)
              ? { what: "<b>For each packet, a quick model run makes the Premove.</b>", n: "" }
              : { what: "<b>For each packet, it asks the Predictor for one Premove:</b> " + (consultAgentOf({ project: proj }) ? agentChip(consultName(proj)) : "in this test copy, a script plays the Predictor"), n: stateCounts(f.commands.predict) }]
          : []),
        ...whens.map((g) =>
          g.list.length === 1
            ? { what: one(g), n: stateCounts(f.commands[g.list[0][0]]) }
            : { what: groupHead(g), subs: g.list.map(([t, c]) => ({ what: (c.only ? cap(c.only) + ", " : "") + to(c) + ": " + cmdWhat(t, c), n: stateCounts(f.commands[t]) })) },
        ),
        ...p.emits.map((t) => ({ what: "Writes an event: " + evWhat(t) + (p.final.includes(t) ? " (the last step)" : ""), n: nb(V.counts[t] || 0) + " in the log" })),
      ];
    };
    const nHtml = (n) => (n ? '<span class="n">' + n + "</span>" : "");
    const doesHtml = (x) => '<div class="ev">' + x.what + (x.subs ? x.subs.map((s) => '<div class="sub">' + s.what + nHtml(s.n) + "</div>").join("") : nHtml(x.n)) + "</div>";
    const polHead = (p) => '<a href="#setup-policy-' + esc(p.id) + '" data-goto="setup-policy-' + esc(p.id) + '"><b>' + esc(p.name) + "</b></a>";
    // Round 9: policies that read and do the same things show as one table,
    // a column each, so nothing is said three times.
    const same = shared && pols.every((p) => does(p).map((x) => x.what).join("|") === does(pols[0]).map((x) => x.what).join("|"));
    if (same) {
      const head = ["", ...pols.map((p) => p.name)];
      const cell = (x) => (x.subs ? x.subs.map((s) => s.n).join("<br>") : x.n);
      const rows = [
        [T("decider", "Who decides"), ...pols.map((p) => esc(deciderText(p.config, false, proj)))],
        ...does(pols[0]).map((x, i) => [x.what + (x.subs ? x.subs.map((s) => '<div class="sub">' + s.what + "</div>").join("") : ""), ...pols.map((p) => cell(does(p)[i]))]),
      ];
      out += '<table class="grid resp flowtable"><thead><tr>' + head.map((h, i) => "<th" + (i ? ' style="--kc:' + esc(pols[i - 1].color) + '"' : "") + ">" + (i ? polHead(pols[i - 1]) : "") + "</th>").join("") + "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + r.map((x, i) => (i ? '<td data-label="' + esc(head[i]) + '"><span>' + x + "</span></td>" : '<th scope="row">' + x + "</th>")).join("") + "</tr>").join("") + "</tbody></table></section>";
      continue;
    }
    out += '<div class="flowgrid' + (shared ? " noreads" : "") + '">';
    for (const p of pols) {
      const ins = p.builtin
        ? '<div class="ev">Every command\'s progress: a failure, or no result in time</div>'
        : p.on.map((t) => '<div class="ev">' + evLine(t) + "</div>").join("") || '<div class="ev">Its own packets and commands</div>';
      const outs = does(p).map(doesHtml).join("");
      out += (shared ? "" : '<div class="fcol"><div class="fhead">Reads</div>' + ins + '</div><div class="farrow" aria-hidden="true"></div>') + '<div class="pol" style="--kc:' + esc(p.color) + '">' + polHead(p) + "<div>" + T("decider", "Who decides") + ": " + esc(deciderText(p.config, false, proj)) + '</div></div><div class="farrow" aria-hidden="true"></div><div class="fcol"><div class="fhead">Does</div>' + (outs || '<div class="ev">Nothing</div>') + "</div>";
    }
    out += "</div></section>";
  }
  return [["all", out]];
}

const DELIVERY = { "at-least-once": "sent again if the actor does not confirm it", "at-most-once": "sent once, never again" };
function setupParts() {
  let out = readOnly("What each project declares in its policies file in the Antifeed repo, and what runs now. A change here is a change to that file, or your switch of a decider.");
  for (const d of V.projects) {
    out += '<h2 id="setup-project-' + esc(d.project) + '"><span class="hpre">Project:</span> ' + esc(d.name || d.project) + '</h2><p class="muted pfile">Its policies file: <code>' + esc(policiesFile(d.project)) + "</code></p>";
    const k = d.consult;
    if (k) {
      const a = k.agent || {};
      out +=
        '<div class="setup-pol" id="setup-consult-' + esc(d.project) + '" style="--kc:var(--pre)"><h3><span class="hpre">' + T("predictor", "Predictor") + ":</span> " + esc(a.name || k.actor) + "</h3>" +
        '<dl class="kv">' +
        "<dt>In the office</dt><dd>" + (k.kind !== "agent" ? "Not here: in this walkthrough copy, a stub in the code plays it." : a.live ? '<span class="ok">Live</span>' + (a.room ? ", in the " + esc(a.room) + " room" : "") + (a.busy ? ", working now" : ", idle") : '<span class="warn">Not found in the office</span>') + "</dd>" +
        (a.model ? "<dt>Model</dt><dd>" + esc(a.model) + (a.effort ? ", " + esc(a.effort) + " effort" : "") + "</dd>" : "") +
        (k.handoffTokens ? "<dt>Memory</dt><dd>One long session for every packet of " + esc(d.project) + ". At " + Math.round(k.handoffTokens / 1000) + "k tokens it hands off to a fresh session, with a brief of what you taught it.</dd>" : "") +
        "<dt>Its jobs</dt><dd>It makes the Premove of each " + esc(d.name || d.project) + " packet, and it answers your questions about them in its own chat" + (agentChat(a) ? ' (<a href="' + esc(agentChat(a)) + '" target="_blank" rel="noopener">open it</a>)' : "") + ". " + esc(chatAgent()) + ", in Chat beside the app, is for the app itself. It never writes a packet.</dd>" +
        "<dt>For each packet it gets</dt><dd>The exact text Antifeed sends it: the criteria, your past calls on similar packets, the packet as you see it (without the packet creator's pick), the source link and the answer fields. Each packet shows that text under \"How this Premove was made\".</dd>" +
        "<dt>What it may do</dt><dd>Read the code, the board and Antifeed; ask a packet's creator one question per message of yours. Never decide a packet, write the board, edit files, or act as you.</dd>" +
        "<dt>How that holds</dt><dd><b>Only its instructions:</b> they tell it to read only, and nothing technical stops it (Isomux PM's call on 2026-10-25; yours to change). It has the tools of any Claude Code agent in the office; its instructions say read only.</dd>" +
        "</dl>" +
        (k.instructions ? fold("setup:instr:" + d.project, "Its instructions, in full: the exact text it reads, written for the agent", '<pre class="input">' + esc(k.instructions) + "</pre>") : "") +
        "</div>";
    }
    out += "<h3>" + T("actor", "Actors") + "</h3>" +
      rtable(["Id", "Who", "Where it runs"], d.actors.map((a) => [
        '<span id="setup-actor-' + esc(d.project + "-" + a.id) + '">' + esc(a.id) + "</span>",
        a.kind === "agent" ? esc(a.agentName + (a.skill ? " (skill " + a.skill + ")" : "")) : a.kind === "human" ? esc(a.member + " (you)") : a.handler === "walkthrough-stub" ? "In this test copy, a script that plays the Predictor" : '<span title="' + esc("Its handler in the policies file: " + a.handler) + '">A small program in the policies file</span>',
        a.kind === "agent" ? (a.agent && a.agent.live ? '<span class="ok">An office agent, live</span>' : '<span class="warn">An office agent, not found</span>') : a.kind === "human" ? "You, in this app" : "Inside Antifeed",
      ]));
    if (d.sources.length) out += "<h3>Sources</h3><p>" + d.sources.map((s) => esc(s.id + ": " + s.kind + (s.roomId ? ", room " + s.roomId : ""))).join("<br>") + "</p>";
    const subs = (t) => V.policies.filter((p) => p.project === d.project && p.on.includes(t)).map((p) => p.name);
    out += "<h3>" + T("event", "Events") + "</h3>" + rtable(["Type", "What it is", "Who may write it", "Who reacts", "In the log"], Object.entries(d.events).map(([t, e]) => [esc(t), esc(e.what || ""), esc([].concat(e.from).join(", ")), esc(subs(t).join(", ") || "nobody: the end of the flow"), String(V.counts[t] || 0)]));
    out += "<h3>" + T("policy", "Policies") + "</h3>";
    for (const p of V.policies.filter((x) => x.project === d.project)) out += policySetup(p);
  }
  const built = V.policies.filter((p) => p.builtin);
  if (built.length) out += "<h2>Antifeed itself</h2>" + built.map(policySetup).join("");
  return [["all", out]];
}

function policySetup(p) {
  const crit = p.predictor && p.predictor.criteria;
  const key = "setup:crit:" + p.id;
  if (crit && openFolds.has(key)) wantText("/api/criteria/" + encodeURIComponent(p.id));
  return (
    // A fold, open on a desktop and closed on a phone, so Setup stays short there.
    '<details class="setup-pol" id="setup-policy-' + esc(p.id) + '" style="--kc:' + esc(p.color) + '" data-dkey="setup:pol:' + esc(p.id) + '"' + (DESK.matches || openFolds.has("setup:pol:" + p.id) ? " open" : "") + '><summary><span class="kind" style="--kc:' + esc(p.color) + '">' + esc(p.name) + "</span> <code>" + esc(p.id) + "</code></summary>" +
    '<dl class="kv">' +
    "<dt>Reacts to</dt><dd>" + esc(p.builtin ? "every command's progress" : p.on.join(", ") || "its own packets and commands") + "</dd>" +
    "<dt>Emits</dt><dd>" + esc(p.emits.join(", ") || "nothing") + "</dd>" +
    "<dt>" + T("command", "Commands") + "</dt><dd>" + (Object.entries(p.commands).map(([t, c]) => '<div class="cmdline"><b>' + esc(t) + "</b>" + (c.what ? " (" + esc(c.what) + ")" : "") + " to " + esc(c.actor) + ": " + (c.when ? esc(c.when.charAt(0).toLowerCase() + c.when.slice(1) + (c.only ? ", " + c.only : "")) + "; " : "") + esc(DELIVERY[c.delivery] || c.delivery) + (c.burstMs ? "; waits until you pause " + Math.round(c.burstMs / 60000) + " min" : "") + (c.timeoutMs ? "; a failure packet after " + Math.round(c.timeoutMs / 60000) + " min with no result" : "") + "</div>").join("") || "none") + "</dd>" +
    (p.config || p.fileDecider ? "<dt>" + T("decider", "Decider now") + "</dt><dd>" + esc(deciderText(p.config, true, p.project)) + (p.setAt ? " (you switched it " + ptTime(p.setAt) + ")" : "") + "</dd><dt>Decider in the file</dt><dd>" + esc(deciderText(p.fileDecider, true, p.project)) + "</dd><dt>Automatic decisions</dt><dd>" + (p.autoAllowed ? "allowed, if you switch it" : "never: it stays with you") + "</dd>" : "") +
    (p.answer ? "<dt>Your answer</dt><dd>" + fields(p).map(([k, f]) => esc(fieldLabel(k, f)) + ": " + esc(f.enum ? f.enum.map(valueLabel).join(", ") : "free text") + (f.help ? " (" + esc(f.help) + ")" : "")).join("<br>") + "</dd>" : "") +
    (p.noDefault ? "<dt>Safe default</dt><dd>None: " + esc(p.noDefault) + "</dd>" : "") +
    (p.fallback ? "<dt>Safe default</dt><dd>" + esc(p.fallbackHelp || callText(p, p.fallback)) + ": the last stand-in, when nothing gives a basis</dd>" : "") +
    (p.author ? "<dt>Packet creator</dt><dd>" + esc([].concat(p.author).join(", ")) + "</dd>" : "") +
    "</dl>" +
    (crit ? fold(key, "Predictor criteria: " + esc(crit), openFolds.has(key) ? lazyText("/api/criteria/" + encodeURIComponent(p.id)) : "") : "") +
    "</details>"
  );
}

// A timer's name in words (slice 7 walk); the name stays in the tip.
function timerWords(k) {
  const fixed = { clock: "The clock (wake-ups and stand-ins)", actions: "Sends the held actions", agents: "Reads the office's agent list", dispatch: "Sends the commands" };
  if (fixed[k]) return fixed[k];
  const m = /^(board|inbox):([^/]+)\/(.+)$/.exec(k);
  if (m && m[1] === "inbox") return "Reads your Inbox in the office (asks and pages)";
  if (m) return "Reads the board for " + m[2];
  return k;
}
const STATES = { issued: "waiting to be sent", delivered: "sent, not started yet", started: "started", done: "done", failed: "failed", cancelled: "cancelled" };
function statusParts() {
  const s = status;
  if (!s) return [["all", readOnly("The commands that Antifeed sends now, the ones that failed, the health of the log, and the timers.") + '<p class="muted">Reading the status…</p>']];
  // An action for Nil waits for him, in the queue: say so in his words.
  const human = (k) => { const d = projectOf(k.project); const a = d && d.actors.find((x) => x.id === k.actor); return a && a.kind === "human"; };
  const cmd = (k) => {
    if (human(k)) {
      const c = k.card && cardById(k.card);
      const pol = V && V.policies.find((x) => x.id === k.policy);
      return '<div class="line"><b>' + esc(pol && pol.actionLabel ? pol.actionLabel : "An action for you") + "</b>" + (c ? ": " + esc(questionOf(c)) : "") + ". " + (k.state === "failed" ? "Failed" : 'It waits for you in the <a href="#queue" data-goto="queue">Queue</a>') + ", since " + ptTime(k.issuedAt) + "." + (k.error ? '<div class="err">' + esc(k.error) + "</div>" : "") + "</div>";
    }
    // Round 10: a command of your call waits for the call's Undo time.
    const hold = k.state === "issued" && s.held && s.held[k.id] ? Math.max(0, Math.ceil((Date.parse(s.held[k.id]) - Date.now()) / 1000)) : null;
    // Round 11: what the command does and who does it, in words; the ids are in the tip.
    const pol = V && V.policies.find((x) => x.id === k.policy);
    const decl = pol && pol.commands && pol.commands[k.type];
    const what = k.about ? k.about.title : k.type === "predict" ? "make the Premove" : decl && decl.what ? decl.what : k.type;
    const head = '<b title="' + esc("Command " + k.type + " to " + k.actor + (k.subject ? ", " + k.subject : "")) + '">' + esc(what.charAt(0).toUpperCase() + what.slice(1)) + "</b>";
    // Slice 7 walk: a command with plain words names its subject in words (the ask's question), not by its id.
    const first = k.about && k.about.rows && k.about.rows[0];
    // Slice 8 walk: a call in Nil's words (about.one) names its task in the title already; its first row is the call, not a quote.
    const sub = first ? (k.about.one ? " · " + esc(first[1].slice(0, 80)) : " · “" + esc(first[1].slice(0, 80)) + "”") : k.subject ? " · " + esc(k.subject) : "";
    const by = k.about ? "" : " (" + esc(actorWords(k.project, k.actor)) + ")";
    const err = k.error ? '<div class="err">' + esc(k.error) + "</div>" : "";
    // Round 13: a held command says only when it goes out (no "since": it started just now).
    if (hold !== null) return '<div class="line">' + head + by + sub + ": goes out in " + hold + " s, when your Undo time ends." + err + "</div>";
    return '<div class="line">' + head + (k.about ? "" : ", by " + esc(actorWords(k.project, k.actor))) + ": " + esc(STATES[k.state] || k.state) + ", since " + ptTime(k.startedAt || k.issuedAt) + sub + err + "</div>";
  };
  // A Premove request the card outran (Nil decided first) is not a failure.
  const outran = s.failed.filter((k) => k.type === "predict" && k.error === "card moved on");
  const failed = s.failed.filter((k) => !outran.includes(k));
  let out = readOnly("The commands that Antifeed sends now, the ones that failed, the health of the log, and the timers.");
  // Slice 7: the Inbox's read, first, while the office gives no reach (or fails).
  for (const [k, v] of Object.entries(s.timers || {})) {
    if (!k.startsWith("inbox:")) continue;
    const why = v.error || (v.result && v.result.asksOff);
    if (why) out += '<p class="warn" data-inbox-status>Inbox: ' + esc(why) + ". Last tried " + ptTime(v.at) + ".</p>";
  }
  out += "<h2>Commands in flight (" + s.inFlight.length + ")</h2>" + (s.inFlight.map(cmd).join("") || "<p>None.</p>");
  out += "<h2>Failed commands (" + failed.length + ")</h2>" + (failed.map(cmd).join("") || "<p>None.</p>");
  if (outran.length) out += '<p class="muted">' + outran.length + " Premove request" + (outran.length > 1 ? "s" : "") + " stopped because the packet moved on before " + (outran.length > 1 ? "they were" : "it was") + " answered. That is not a failure.</p>";
  // Slice 8: each call that went out, and whether its line is on the board yet.
  const ls = ((V && V.landing) || []).slice().sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  if (ls.length) {
    const late = ls.filter((l) => landingText(l).late).length;
    out += "<h2>Calls sent (" + ls.length + (late ? ", " + late + " not on the board" : "") + ")</h2>" + ls.map((l) => '<div class="line" data-landing="' + esc(l.card) + '"><b>' + esc(l.title) + "</b>: " + esc(l.call) + ", sent to " + esc(l.to) + " " + ptTime(l.sentAt) + ". " + landingText(l).html + "</div>").join("");
  }
  out += '<h2>The log</h2><div class="line">' + (s.log.broken ? '<span class="warn">The log takes no input until a restart: ' + esc(s.log.broken) + "</span>" : '<span class="ok">Healthy: every event is written to disk.</span>') + (s.log.torn ? "<br>A torn last batch was moved to " + esc(s.log.torn) : "") + (s.decisionsRebuilt ? "<br>decisions.jsonl was rebuilt from the events at start." : "") + '<br><span class="muted">A call that Antifeed refuses writes nothing: its error shows on the packet.</span></div>';
  if (s.replayDiffs.length) out += '<h2 class="warn">Replay differences (' + s.replayDiffs.length + ")</h2><p>The policies code changed: replaying it over the log gives other outputs than the log holds. Nothing was sent.</p>" + s.replayDiffs.slice(0, 50).map((d) => '<div class="line">' + esc(d.policy) + " on " + esc(d.event) + ": now " + esc(d.expected.join(", ") || "nothing") + "; logged " + esc(d.logged.join(", ") || "nothing") + "</div>").join("");
  if (s.refusedProjects && s.refusedProjects.length) out += '<h2 class="warn">Policies files that did not load</h2>' + s.refusedProjects.map((r) => '<div class="line">' + esc(r.path) + "<br>" + r.problems.map(esc).join("<br>") + "</div>").join("");
  // Round q1b, P5: what the runs are, in plain words; the numbers are bold (G1).
  if (s.spendToday) out += '<h2>Quick model runs</h2><div class="line">Today: <span class=dv>' + s.spendToday.standinRuns + "</span> " + (s.spendToday.standinRuns === 1 ? "run" : "runs") + ", cost <span class=dv>$" + s.spendToday.standinUsd.toFixed(2) + '</span>. Antifeed makes a quick model run for a Premove when the Predictor is not available. The day starts at midnight Pacific time.</div>';
  if (s.timers) out += "<h2>Timers</h2>" + Object.entries(s.timers).map(([k, v]) => '<div class="line" title="' + esc(k) + '">' + esc(timerWords(k)) + ": last ran " + ptTime(v.at) + (v.error ? ' <span class="err">' + esc(v.error) + "</span>" : "") + "</div>").join("");
  return [["all", out]];
}

// Each term: [key, the word, its one-line definition (the tooltip), more for Help].
// Round q1b, G0: the words are Predictor and packet creator, not consult or author.
const TERMS = [
  ["packet", "Packet", "One decision that waits for you: the question, the evidence and the options that the packet creator wrote.", "The Queue shows each packet with its Premove and its Against."],
  ["creator", "Packet creator", "The agent or the program that writes a packet, for example Isomux Curator for a task on the isomux board.", "It is never the Predictor: the agent that writes the case for a call does not also guess your call."],
  ["predictor", "Predictor", "One agent for each project that makes the Premove of each packet and answers your questions about it.", "It works in the project's room (Isomux Consult, Wall Game Consult) and keeps what you tell it. It never writes a packet. " + "Antifeed PM, in the chat beside the app, is for the app itself."],
  ["premove", "Premove", "The Predictor's guess of your call, with how sure it is and why. You confirm it or change it.", "A Premove with a basis (the Predictor, a quick model run, a vote of your past calls, the packet creator's pick) is filled in for you. A safe default is never filled in. Nothing decides a packet on its own."],
  ["confidence", "Confidence", "How sure the Premove is, for example \"82% sure\".", "Calibration shows how often a Premove at each confidence matched your call."],
  ["against", "Against", "The best case against the Premove, by the agent that made it, so you see the other side before you confirm.", ""],
  ["standin", "Stand-in", "A Premove made another way when the Predictor is busy or fails.", "First a quick model run; if that fails, a vote of your past calls on similar packets; with no past calls, the packet creator's pick; with no pick, a safe default from the policy, which is never filled in. A stand-in never decides: you confirm it."],
  ["informed", "Informed", "A Premove made with your view of the packet: you talked with the Predictor about it, or you saw an earlier version.", "It carries your own view, so it does not count in the Predictor's accuracy."],
  ["event", "Event", "A fact that happened, written once to the log: a task was filed on a board.", "Events come from a project's sources (a board), from your calls, and from the results of commands."],
  ["source", "Source", "Where packets came from: a board in the office (Isomux, Wall Game), your office Inbox, the Loop app or the Wall Game video page. Every kind moved to the Isomux Inbox (Nil, 2026-10-31), so Antifeed reads no source now.", "The Sources tab shows when Antifeed last read each one, and why it could not."],
  ["policy", "Policy", "The rules for one kind of decision: which events it reads, when it gives you a packet, and which commands it sends after your call.", "Each project keeps its policies in its policies file, projects/<project>/policies.ts in the Antifeed repo. The Policies tab shows them."],
  ["kind", "Kind", "The name of a packet's policy (for example Triage (Wall Game)), in that policy's color.", "An action for you is its own kind."],
  ["decider", "Decider", "Who makes a policy's calls: you, or, only after you switch it, a program or an agent above a confidence you set.", ""],
  ["command", "Command", "An order from a policy to one actor, for example \"send your reply to the agent\" or \"write your call to the board\".", "The actor does it and reports the result, which is a new event."],
  ["actor", "Actor", "Who carries out a command: an agent (Wall Game PM), a small program inside Antifeed, or you.", ""],
  ["action", "Action", "A command whose actor is you: a step that only you can do, for example approve a sign-in on your phone.", "It shows in the Queue with its steps, and Done or Could not do it."],
  ["precedent", "Precedent", "Your past calls on packets of the same kind. The Predictor reads the most similar ones before it guesses.", ""],
  ["calibration", "Calibration", "For each confidence a Predictor gives, how often you confirmed its Premove as it was.", "A good Predictor at 90% is right about 9 times in 10."],
  ["edpm", "Calls per minute", "Your calls divided by the time the packets were on your screen.", "Read the calls that needed you next to the match rate."],
  ["needed", "Calls that needed you", NEEDED_TIP, ""],
  ["safe", "Safe estimate", "The match rate that is 95% sure, given how many packets there are.", "With few packets it is low even when every Premove matched: 1 of 1 gives 21%, 20 of 20 gives 84%."],
];

// Round q1b, P6 and P7: Help opens with what Antifeed is, then the path of a
// packet as a numbered list (the old row of boxes broke into rows that
// started with an arrow), then one packet on the screen, then the terms.
// Round q1b, P8: the examples come from more than one source.
function stepsHtml() {
  const step = (n, head, text) => '<li><span class="stepn" aria-hidden="true">' + n + "</span><div><b>" + head + ":</b> " + text + "</div></li>";
  return (
    '<ol class="steps tregion">' +
    step(1, T("event", "Event"), "Something happens in a project: a task is filed on a board.") +
    step(2, T("policy", "Policy"), "The project's policy for that event reads it. When the event needs your call, a packet creator (an agent, or Antifeed's own code) writes the packet: the question, the evidence, the options.") +
    step(3, T("premove", "Premove"), "The project's Predictor reads the packet and your past calls on similar packets. It guesses your call, says how sure it is, and writes the Against: the best case against its guess.") +
    step(4, "Your call", "In the Queue you confirm the Premove or change it. You can undo it for " + UNDO_S + ".") +
    step(5, T("command", "Command"), "The policy sends a command to an actor (an agent, a small program inside Antifeed, or you) to carry out your call.") +
    step(6, "A new event", "The result is a new event, so it can start the next step: a filed task, for example, comes back as a new packet.") +
    "</ol>"
  );
}
function anatomyHtml() {
  return (
    '<div class="anatomy tregion" role="img" aria-label="One packet, top to bottom: the kind and the question; the Premove next to the Against; the chat with the Predictor; your call; the packet">' +
    '<div class="az head"><b>' + T("kind", "Kind") + ", priority, source</b><span>The question, in large type</span></div>" +
    '<div class="az-pair"><div class="az pre"><b>' + T("premove", "Premove") + "</b><span>the guessed call, how sure, why</span></div>" +
    '<div class="az ag"><b>' + T("against", "Against") + "</b><span>the best case against it</span></div></div>" +
    '<div class="az"><b>Chat with the ' + T("predictor", "Predictor") + "</b><span>ask about this packet without leaving the queue</span></div>" +
    '<div class="az"><b>Your call</b><span>the options, the fields, a note, Confirm</span></div>' +
    '<div class="az"><b>' + T("packet", "Packet") + "</b><span>from the packet creator: the evidence, drafts</span></div></div>"
  );
}
function helpParts() {
  return [
    [
      "all",
      "<h2>What Antifeed is</h2><p class=\"lead\">Antifeed is one queue for the calls that only you can make. Agents do the work. When an agent cannot safely guess your call, the question comes to you here as a packet, with the Predictor's guess filled in. You confirm it or change it, and Antifeed sends your call on.</p>" +
        (V.sourceInfo && V.sourceInfo.moved ? "<h2>Moved to the Isomux Inbox</h2><p>" + esc(V.sourceInfo.moved) + "</p>" : "") +
        "<h2>From an event to your call to the action</h2>" + stepsHtml() +
        "<h2>One packet in the Queue</h2>" + anatomyHtml() +
        '<h2>Terms</h2><p class="muted">A dotted word in a heading or a label shows its line from this list.</p><dl class="terms">' + TERMS.map(([k, t, d, more]) => '<dt id="help-' + k + '">' + esc(t) + "</dt><dd>" + esc(d) + (more ? " " + esc(more) : "") + "</dd>").join("") + "</dl>",
    ],
  ];
}

// ---- sources (queue round 1, S1) ---------------------------------------------

// A source by its timer's key ("board:wallgame/board", "inbox:inbox/inbox"): "Wall Game board", "Office Inbox".
function sourceName(key) {
  const m = /^(board|inbox):([^/]+)\//.exec(key);
  if (!m) return key;
  if (m[1] === "inbox") return "Office Inbox";
  const d = V && V.projects.find((x) => x.project === m[2]);
  return (d ? d.name : cap(m[2])) + " board";
}
// An error as a sentence: one stop at the end ("...the url?" keeps its "?").
const sentence = (t) => (/[.?!]$/.test(String(t).trim()) ? String(t).trim() : String(t).trim() + ".");
// One line per source the projects declare. G1: the dynamic words are bold.
function sourcesParts() {
  // The server's words and timers (view.sourceInfo), so the tab cannot drift from them.
  const info = V.sourceInfo || {};
  const ASKS_OFF = info.asksOff;
  const every = (ms) => (ms % 60000 === 0 ? (ms === 60000 ? "every minute" : "every " + ms / 60000 + " minutes") : "every " + Math.round(ms / 1000) + " s");
  const out = [["head", '<div class="note">Where the packets come from (' + T("source", "sources") + "). Antifeed reads each board " + every(info.boardMs || 60000) + (info.inbox === false ? "" : " and the Inbox " + every(info.inboxMs || 10000)) + ".</div>"]].concat(info.moved ? [["moved", "<p>" + esc(info.moved) + "</p>"]] : []);
  if (!status) return [...out, ["all", '<p class="muted">Reading the sources…</p>']];
  const lines = [];
  for (const d of V.projects)
    for (const s of d.sources || []) {
      if (s.kind !== "isomux-board" && s.kind !== "isomux-inbox") continue;
      const key = (s.kind === "isomux-board" ? "board:" : "inbox:") + d.project + "/" + s.id;
      const t = (status.timers || {})[key];
      const name = "<span class=dv>" + esc(sourceName(key)) + "</span>";
      const n = cards().filter((c) => c.project === d.project && c.state === "open" && !c.held).length;
      // ptTime: "3 min ago", its tip the time in PT.
      const at = (x) => "<span class=dv>" + ptTime(x) + "</span>";
      const r = (t && t.result) || {};
      const asksErr = r.asksOff && r.asksOff !== ASKS_OFF ? r.asksOff : null;
      let line;
      let bad = false;
      if (!t) line = name + ": not read yet.";
      else if (t.error || asksErr) {
        bad = true;
        line = name + ": Antifeed cannot read it: <span class=dv>" + esc(sentence(t.error || asksErr)) + "</span> Last tried " + at(t.at) + ".";
      } else {
        line = name + ": read " + at(t.at) + ", <span class=dv>" + n + "</span> " + (n === 1 ? "packet" : "packets") + " in the queue.";
        if (r.asksOff) line += " " + cap(ASKS_OFF) + ".";
        const errs = r.errors || [];
        if (errs.length) line += " <span class=dv>" + errs.length + "</span> " + (errs.length === 1 ? "item" : "items") + " did not read: <span class=dv>" + esc(sentence(errs[0])) + "</span>";
      }
      lines.push('<p class="srcline dyn' + (bad ? " warn" : "") + '" data-source="' + esc(key) + '">' + line + "</p>");
    }
  return [...out, ["all", lines.join("") || (info.moved ? "<p>Antifeed reads no source now.</p>" : "<p>No project declares a source.</p>")]];
}

const PARTS = { queue: queueParts, decided: decidedParts, accuracy: accuracyParts, policies: policiesParts, setup: setupParts, sources: sourcesParts, status: statusParts, help: helpParts };

// ---- drawing --------------------------------------------------------------

// Replaces only the parts whose html changed; keeps focus in a replaced part.
function patch(el, list, name) {
  const had = parts[name] || {};
  const now = {};
  const keys = list.map(([k]) => k);
  const focus = document.activeElement && el.contains(document.activeElement) && document.activeElement.matches("textarea, input") ? { sel: focusSel(document.activeElement), pos: document.activeElement.selectionStart } : null;
  for (const node of [...el.children]) if (!keys.includes(node.dataset.part)) node.remove();
  let prev = null;
  for (const [k, html, sig] of list) {
    const key = sig === undefined ? html : sig;
    now[k] = key;
    let node = [...el.children].find((n) => n.dataset.part === k);
    if (!node || had[k] !== key) {
      const fresh = document.createElement("div");
      fresh.dataset.part = k;
      fresh.innerHTML = typeof html === "function" ? html() : html;
      if (node) node.replaceWith(fresh);
      node = fresh;
    }
    const want = prev ? prev.nextSibling : el.firstChild;
    if (want !== node) el.insertBefore(node, want);
    prev = node;
  }
  parts[name] = now;
  dedupeTerms(el);
  for (const b of el.querySelectorAll("[data-chatbox]")) growBox(b);
  if (focus) {
    const f = focus.sel && el.querySelector(focus.sel);
    if (f && f !== document.activeElement) {
      f.focus();
      if (focus.pos != null && f.setSelectionRange) f.setSelectionRange(focus.pos, focus.pos);
    }
  }
  observeShown(el);
}

function focusSel(el) {
  const card = el.closest("[data-card]");
  const inCard = card ? '[data-card="' + card.dataset.card + '"] ' : "";
  for (const a of ["data-note", "data-draft", "data-text", "data-view", "data-chatbox", "data-socomment"]) if (el.hasAttribute(a)) return inCard + "[" + a + (el.getAttribute(a) ? '="' + el.getAttribute(a) + '"' : "") + "]";
  return null;
}

function drawTab(name) {
  if (!V) return;
  const ps = PARTS[name]();
  // On a phone, More does not name the tab behind it that is open, so the tab names itself.
  if (MORE_TABS.includes(name)) ps.unshift(["tabname", '<h2 class="tabname">' + esc(TABS.find(([k]) => k === name)[1]) + "</h2>"]);
  patch($("#tab-" + name), ps, name);
  stale[name] = false;
  const c = name === "queue" && cur && cardById(cur);
  if (c) syncCall(c);
}

function drawChrome() {
  // L63: with a filter on, the tab says how many of the cards it shows ("Queue (3 of 7)").
  const ql = V ? queueLists() : { list: [], total: 0 };
  const open = ql.total;
  drawTitle(open);
  const qCount = !open ? "" : filtersOn() && ql.list.length !== open ? " (" + ql.list.length + " of " + open + ")" : " (" + open + ")";
  // On a phone, Policies, Setup, Sources, Status and Help sit behind More, so the tabs keep one row.
  // Queue round 1 (Antifeed PM, 2026-10-29): with one of them open, More reads "More ▾" (its name was
  // too wide: "Sources ▾" wrapped the row); the open tab is marked in the menu, and named in the tip.
  const rest = MORE_TABS;
  const html =
    TABS.map(([k, l]) => '<button data-tab="' + k + '"' + (k === tab ? ' aria-current="page"' : "") + ' title="' + esc(TAB_TIPS[k]) + '" class="' + (k === tab ? "on" : "") + (rest.includes(k) ? " more" : "") + '">' + l + (k === "queue" ? qCount : "") + "</button>").join("") +
    '<button class="moretab' + (rest.includes(tab) ? " on" : "") + '" data-more title="' + esc(MORE_TIP() + (rest.includes(tab) ? ". Open now: " + TABS.find(([k]) => k === tab)[1] : "")) + '" aria-expanded="' + moreOpen + '">' + (moreOpen ? "Less" : rest.includes(tab) ? 'More<span aria-hidden="true"> ▾</span>' : "More") + "</button>";
  $("#tabs").classList.toggle("more-open", moreOpen);
  setHtml($("#tabs"), html);
  const chat = FRAMED ? "" : V ? '<a href="' + esc(V.chatUrl) + '" target="_blank" rel="noopener" title="Open the office page with this app and ' + esc(chatAgent()) + '\'s chat, for the app itself">Open with the chat</a>' : "";
  setHtml($("#chatlink"), chat);
  setHtml($("#newbtn"), V ? '<button class="btn small' + (newOpen ? " on" : "") + '" data-new aria-expanded="' + newOpen + '" title="Write something that becomes a task on a board (Shift+N)">New</button>' : "");
  drawNew();
  // Round 11: the Undo toast shows on every tab for its whole time, so a tab switch never takes its Undo away.
  drawToast(!!toast);
  $("#keys").innerHTML = keysBox();
  $("#keys").hidden = !showKeys;
  $("#lb").hidden = !lb;
  document.body.classList.toggle("lb-open", !!lb);
  if (lb) {
    // A pair shows as the pair, before and after side by side; on a phone, one half at a time.
    const it = lb.items[lb.i];
    const half = it.pair && it.srcs.length === 1;
    const box = (f) => (f ? '<i class="redbox" style="left:' + f[0] * 100 + "%;top:" + f[1] * 100 + "%;width:" + f[2] * 100 + "%;height:" + f[3] * 100 + '%"></i>' : "");
    const fig = (x) => "<figure>" + (x.side ? '<div class="lb-label">' + (x.side === "before" ? "Before" : "After") + "</div>" : "") + '<span class="lbimg"><img src="/api/blobs/' + esc(x.src) + '" alt="' + esc(x.cap) + '" data-lb-zoom title="' + VERB + ' for 100%, and again to fit">' + box(x.focus) + "</span>" + ((it.srcs.length > 1 || half) && x.cap ? "<figcaption>" + esc(x.cap) + "</figcaption>" : "") + "</figure>";
    $("#lb").innerHTML =
      '<div class="lb-bar"><span>' + esc(half ? it.pair + ", " + (it.srcs[0].side === "before" ? "before" : "after") : it.pair ? "Before and after: " + it.pair : it.cap) + " (" + (lb.i + 1) + " of " + lb.items.length + ")</span><span>" +
      (lb.items.length > 1 ? '<button class="btn" data-lb-step="-1" title="The previous image (Left arrow, or a swipe right)">Previous</button><button class="btn" data-lb-step="1" title="The next image (Right arrow, or a swipe left)">Next</button>' : "") +
      '<button class="btn" data-lb-close title="Close the viewer (Esc, Back, or a ' + verb + ' on the black)">Close</button></span></div><div class="lb-body' + (it.srcs.length > 1 ? " pair" : "") + '">' + it.srcs.map(fig).join("") + "</div>";
  }
}

// The current tab, and the chrome. Other tabs draw when they are opened.
function redraw() {
  savePicks();
  drawChrome();
  drawTab(tab);
  for (const [k] of TABS) if (k !== tab) stale[k] = true;
  watchCallZone();
}

// Each tab and term link is a step in the browser's history, so Back returns.
function go(hash) {
  hash = newHash(hash);
  if (location.hash.slice(1) !== hash) history.pushState({ cur }, "", "#" + hash);
  const name = hash.split("-")[0];
  showTab(TABS.some(([k]) => k === name) ? name : "queue", hash.includes("-") ? hash : null);
}

function showTab(name, anchor) {
  const t0 = performance.now();
  closePop();
  tab = name;
  for (const [k] of TABS) $("#tab-" + k).hidden = k !== name;
  drawChrome();
  if (stale[name] !== false || !parts[name]) drawTab(name);
  if (name === "status" || name === "sources") loadStatus();
  watchCallZone();
  requestAnimationFrame(() => {
    window.AF_TIMES.push({ what: "tab:" + name, ms: Math.round((performance.now() - t0) * 10) / 10 });
    if (anchor) {
      const el = document.getElementById(anchor);
      if (el) {
        // A link into a closed fold opens it.
        for (let x = el; x; x = x.parentElement) if (x.tagName === "DETAILS") x.open = true;
        // Below the sticky header, with a little of the page above it.
        const head = getComputedStyle($("header")).position === "sticky" ? $("header").offsetHeight : 0;
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - head - 16);
        const lit = [el, el.tagName === "DT" ? el.nextElementSibling : null].filter(Boolean);
        lit.forEach((x) => x.classList.add("hl"));
        setTimeout(() => lit.forEach((x) => x.classList.remove("hl")), 4000);
      }
    } else window.scrollTo(0, 0);
  });
}

const hasFolds = (c) => hasFull(c) || ((c.packet && c.packet.blocks) || []).some((b) => FOLD_TYPES.includes(b.type));
// L31: one button (and e) opens every fold of the packet, and closes them when all are open.
const packetFolds = (id) => [...document.querySelectorAll('[data-card="' + id + '"] .packet details')];
// The folds at the top of the packet decide what the button says.
const topFolds = (id) => packetFolds(id).filter((x) => !x.parentElement.closest(".packet details"));
const FOLD_TYPES = ["fold", "demo", "chart"];
function foldsButton(c) {
  const ks = (c.packet.blocks || []).map((b, i) => (FOLD_TYPES.includes(b.type) ? c.id + ":" + i : null)).filter(Boolean).concat(hasFull(c) ? [c.id + ":full"] : []);
  const all = ks.length && ks.every((k) => openFolds.has(k));
  return '<button class="btn small" data-openall title="' + (all ? "Close every fold of the packet (e)" : "Open every fold of the packet (e)") + '">' + (all ? "Close all folds" : "Open all folds") + '<span class="kh" aria-hidden="true"> (e)</span></button>';
}
function toggleFolds(id) {
  const open = !topFolds(id).every((x) => x.open);
  packetFolds(id).forEach((x) => (x.open = open));
}
// The button says what it does next, after any fold opens or closes.
function syncFoldsButton(id) {
  const b = document.querySelector('[data-card="' + id + '"] [data-openall]');
  const c = cardById(id);
  if (!b || !c) return;
  const all = topFolds(id).every((x) => x.open);
  const label = all ? "Close all folds" : "Open all folds";
  if (!b.textContent.startsWith(label)) {
    b.firstChild.textContent = label;
    b.title = all ? "Close every fold of the packet (e)" : "Open every fold of the packet (e)";
  }
}
// The keys that work on the current card, each with its button on the page.
function keysBox() {
  if (!showKeys) return "";
  const c = tab === "queue" && cur && cardById(cur);
  const rows = [["j / k", "next / previous packet (the Next and Previous buttons)"]];
  if (c && isSO(c)) {
    rows.push(["a r", "Approve or Revert"], ["n", "write a note (Esc leaves it); Revert needs one"], ["l", "later, on this device"], ["Ctrl+Enter", "confirm; the next packet comes"]);
  } else if (c && isLoop(c)) {
    rows.push(["g d h b o w", "choice: go, design, on hold, backlog, obsolete, rewrite"], ["0 1 2 3", "priority P0 to P3"], ["n", "write a note (Esc leaves it)"], ["l", "later, on this device"], ["Ctrl+Enter", "confirm; the next packet comes"]);
  } else if (c && !isAction(c)) {
    const pol = policyOf(c);
    const km = keyMap(c);
    const ks = Object.values(km);
    if (ks.length) rows.push([ks.map((m) => m.key).join(" "), "pick: " + ks.map((m) => m.key + " " + valueLabel(m.value)).join(", ")]);
    rows.push(["a", "back to the Premove (when you changed it)"]);
    if (c.packet && c.packet.options && c.packet.options.length) rows.push(["p", "next option"]);
    rows.push(["n", "write a note (Esc leaves it)"]);
    if (pol.prepare) rows.push(["w", "new packet: the packet creator writes it again as your note says"]);
    if (pol.prepare && c.packet && c.packet.options && c.packet.options.length) rows.push(["r", "closer to the option you picked"]);
    if (hasFolds(c)) rows.push(["e", "open all folds of the packet, or close them when all are open"]);
    rows.push(["l", "later, on this device"], ["Ctrl+Enter", "confirm"]);
  } else if (c) rows.push(["n", "write a note"], ["d", "Done (Ctrl+Enter never finishes an action)"], ["f", "could not do it (with a note)"], ["l", "later, on this device"]);
  rows.push(["Ctrl+Z", "undo the last call (while its toast shows)"], ["/", "search"], ["Shift+N", "New: words that become a task on a board"], ["?", "show or hide this list"]);
  return '<div class="keys-in" role="dialog" aria-label="Keys"><div class="keys-head"><b>Keys for this packet</b><button class="btn small" data-keys-close>Close</button></div><table>' + rows.map(([k, v]) => "<tr><td><kbd>" + esc(k) + "</kbd></td><td>" + esc(v) + "</td></tr>").join("") + "</table></div>";
}

// ---- what Nil sees: card.shown, the consult's focus, the sticky call bar -------

let focusTimer = null;
let focusSent = null;
function setCur(id) {
  if (cur === id) return;
  if (id !== keptDraft) keptDraft = null;
  cur = id;
  travel = 0;
  armGuard();
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    if (!cur || cur === focusSent) return;
    focusSent = cur;
    api("POST", "/api/consult/focus", { card: cur }).catch(() => (focusSent = null));
  }, 300);
}

const observed = new WeakSet();
const io =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            // Half of it on the screen, or, for a zone taller than the screen, half the screen.
            const half = en.intersectionRatio >= 0.5 || (en.rootBounds && en.intersectionRect.height >= en.rootBounds.height * 0.5);
            if (!en.isIntersecting || !half) continue;
            const id = en.target.dataset.shown;
            const v = Number(en.target.dataset.v);
            const key = id + "@" + v;
            if (reported.has(key)) continue;
            reported.add(key);
            api("POST", "/api/cards/" + id + "/shown", { version: v }).catch(() => reported.delete(key));
          }
        },
        { threshold: [0, 0.25, 0.5, 0.75, 1] },
      )
    : null;
function observeShown(el) {
  if (!io) return;
  for (const n of el.querySelectorAll("[data-shown]")) {
    if (observed.has(n)) continue;
    observed.add(n);
    io.observe(n);
  }
}

// The call bar shows while the current card's Confirm row is off the screen,
// so one Confirm is always on the screen, and never two (round 10: on a
// desktop too; under the sticky header counts as off).
// Round 11: the bar shows as soon as the card's Confirm (or Done) is not all
// on the screen, and hides only when it is, so no frame has two Confirms or
// none. Under the sticky header, or under a phone's toast, counts as off.
let zoneSeen = true;
let watched = null;
function watchCallZone() {
  watched = tab === "queue" && cur ? document.querySelector('[data-callzone="' + cur + '"] .actions') : null;
  stickyShow();
}
function confirmSeen() {
  const b = watched && watched.isConnected && watched.querySelector("[data-confirm], [data-done]");
  if (!b) return false;
  const r = b.getBoundingClientRect();
  if (!r.height) return false;
  let top = 0;
  let bottom = window.innerHeight;
  const head = $("header");
  if (getComputedStyle(head).position === "sticky") top = head.getBoundingClientRect().bottom;
  const t = $("#toast");
  if (!t.hidden && getComputedStyle(t).position === "fixed") bottom = Math.min(bottom, t.getBoundingClientRect().top);
  // Round Q1, C1 (Antifeed Walker's walk): on a desktop nothing floats over
  // Your call while any of it is on the screen, so no press meant for a field
  // lands on a Confirm. The bar shows once the whole call zone is scrolled
  // away; until then the card's own Confirm (or Ctrl+Enter) confirms.
  if (DESK.matches) {
    const z = (watched.closest(".yourcall") || watched).getBoundingClientRect();
    return z.bottom > top && z.top < bottom;
  }
  return r.top >= top && r.bottom <= bottom;
}
window.addEventListener("resize", () => stickyShow());
// A new current card: Confirm waits, so a second press never decides a card
// Nil has not seen. The wait starts when the new card is painted (two frames
// after the change), and again when the page has loaded.
const fresh = () => performance.now() - curSince < guardMs();
function armGuard() {
  curSince = Infinity;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      curSince = performance.now();
      stickyShow();
      setTimeout(stickyShow, guardMs() + 20);
    }),
  );
}
window.addEventListener("load", armGuard);
// The Premove counts as seen when enough of it is on the screen and not under
// the toast, the sticky header or the call bar: half of it, or 40% of the screen.
function checkSeen() {
  const c = tab === "queue" && cur && cardById(cur);
  if (!c || isAction(c) || !c.prediction) return;
  const key = c.id + "@" + c.version;
  if (premoveSeen.has(key)) return;
  const z = document.querySelector('[data-card="' + c.id + '"] .premove');
  if (!z) return;
  const r = z.getBoundingClientRect();
  let top = 0;
  let bottom = window.innerHeight;
  const head = $("header");
  if (getComputedStyle(head).position === "sticky") top = Math.max(top, head.getBoundingClientRect().bottom);
  const t = $("#toast");
  if (!t.hidden && getComputedStyle(t).position === "fixed") {
    const tr = t.getBoundingClientRect();
    if (tr.top < window.innerHeight / 2) top = Math.max(top, tr.bottom);
    else bottom = Math.min(bottom, tr.top);
  }
  const bar = document.querySelector("[data-sticky]");
  if (bar && !bar.hidden && getComputedStyle(bar).position === "fixed") bottom = Math.min(bottom, bar.getBoundingClientRect().top);
  const h = Math.max(0, Math.min(r.bottom, bottom) - Math.max(r.top, top));
  if (h >= Math.min(r.height * 0.5, window.innerHeight * 0.4)) premoveSeen.add(key);
}
let seenQueued = false;
window.addEventListener("scroll", () => {
  if (seenQueued) return;
  seenQueued = true;
  requestAnimationFrame(() => ((seenQueued = false), stickyShow()));
}, { passive: true });
// The bar's Confirm is ready only after the guard, and only once the
// Premove was on the screen: it fades in, and says why while it waits.
function stickyShow() {
  const bar = document.querySelector("[data-sticky]");
  if (bar) {
    // Round 9: not while the filters are open: the card is down the page then.
    zoneSeen = confirmSeen();
    bar.hidden = tab !== "queue" || zoneSeen || !watched || filtersOpen;
    checkSeen();
    const c = cardById(bar.dataset.sticky);
    const why = readyFor(c);
    bar.dataset.state = why ? "locked" : "ready";
    for (const b of bar.querySelectorAll("[data-confirm], [data-done]")) b.disabled = !!why;
    const hint = bar.querySelector(".sbhint");
    if (hint) hint.textContent = why;
  }
  // The card's own Confirm and Done show the same state, with the same reason.
  const c2 = tab === "queue" && cur && cardById(cur);
  const z = c2 && document.querySelector('[data-callzone="' + c2.id + '"]');
  if (z) {
    const why = readyFor(c2);
    // Round 11: while the bar shows, the card's own Confirm (a strip of it under the header, say) is hidden in place, so one Confirm shows.
    const barUp = !!bar && !bar.hidden;
    for (const b of z.querySelectorAll(".actions [data-confirm], .actions [data-done]")) {
      b.classList.toggle("locked", !!why);
      b.classList.toggle("barup", barUp);
    }
    const h = z.querySelector("[data-cfhint]");
    const line = why || readyLine(c2);
    if (h && h.textContent !== line) h.firstChild.textContent = line;
  }
  // On a phone, the toast sits above the bar, and the page keeps room for both at its end.
  document.body.style.setProperty("--barh", bar && !bar.hidden ? bar.offsetHeight + 12 + "px" : "0px");
  // Round 12: on a phone the toast sits on the bottom edge, or just above the
  // bar while it shows (--barh), so it floats over nothing. Its Undo is on the
  // right and every Confirm and Done on the left, so they never meet (V3).
  const t = $("#toast");
  // The page keeps room at its end for the toast and the bar under it.
  document.body.style.setProperty("--toasth", !t.hidden && !DESK.matches ? (bar && !bar.hidden ? bar.offsetHeight + 12 : FRAMED ? 80 : 8) + t.offsetHeight + 8 + "px" : "0px");
}

// ---- actions --------------------------------------------------------------

async function confirm(id, generic) {
  const c = cardById(id);
  if (notReady(c)) return;
  const p = pickOf(c);
  // The loop kind: rewrite is a choice on the card; Confirm sends it.
  if (isLoop(c) && !generic && p.rewrite) generic = { kind: "rewrite" };
  const call = { ...p.call, note: p.note };
  p.err = "";
  // Part J: a sign-off call takes its comments; Revert needs a note (the Loop app's rule).
  if (isSO(c)) {
    const cm = soClean(p.comments);
    if (Object.keys(cm.copy).length + Object.keys(cm.images).length) call.comments = JSON.stringify(cm);
    if (call.call === "revert" && !p.note.trim()) {
      p.err = "Revert needs a note: what is wrong, for Isomux Main.";
      redraw();
      focusNote(id);
      return;
    }
  }
  if (generic && generic.kind === "rewrite" && !ownNote(c)) {
    p.err = newPacketNeeds(c);
    redraw();
    syncCall(c);
    focusNote(id);
    return;
  }
  // The policy's rules first: a call the engine would refuse never leaves the card.
  const bad = generic ? null : ruleError(policyOf(c), p.call);
  p.errField = bad ? bad[1] : null;
  if (bad) {
    p.err = bad[0];
    redraw();
    jumpTo(id);
    return;
  }
  const t0 = performance.now();
  const body = { version: c.version, call: generic ? { note: p.note } : call, shownAt: shownAt[c.id + "@" + c.version] };
  // A shape policy (a field marked inLine "option", triage's scope): the
  // option Nil started from goes with his call after an edit too, so an
  // edited scope of the Premove's option is an edit, not another shape.
  const from = !generic && !isLoop(c) && (p.option || (fields(policyOf(c)).some(([, f]) => f.inLine === "option") ? p.from : null));
  if (from) body.option = from;
  if (generic) body.generic = generic;
  // The card leaves at once; the request runs after.
  sent();
  const next = nextAfter(id);
  pending.add(id);
  // C4: a request for a new packet is no decision, and the toast says so.
  setToast([toastTitle(c), toastWhat(c, call, generic)], id);
  redraw();
  flash(next, true);
  requestAnimationFrame(() => window.AF_TIMES.push({ what: "confirm", ms: Math.round((performance.now() - t0) * 10) / 10 }));
  try {
    await api("POST", "/api/cards/" + id + "/decide", body);
    pending.delete(id);
    await poll(true);
  } catch (err) {
    // Refused: the card comes back as the current card, with the reason.
    pending.delete(id);
    clearToast();
    p.err = "Antifeed did not take this call: " + err.message;
    // The card may have moved on elsewhere: read the view at once.
    setTimeout(() => poll(true), 0);
    setCur(id);
    redraw();
    flash(id, true);
  } finally {
    pending.delete(id);
  }
}

// Done goes to the engine at once; the engine holds it for its Undo time
// (DESIGN.md 13.8), so a reload or another card's Undo never loses it.
// src: "card" (the card's Done button), "bar" or "key". Unticked steps: the
// first press warns, next to the button, with no scroll; only the card's own
// Done, more than 1 s after the warning, goes on.
async function finishAction(id, ok, src = "card") {
  const c = cardById(id);
  if (notReady(c)) return;
  const p = pickOf(c);
  p.err = "";
  if (!ok && !p.note.trim()) {
    p.err = "Say in the note what stopped you.";
    redraw();
    focusNote(id);
    return;
  }
  const steps = document.querySelectorAll('[data-card="' + id + '"] [data-tick]');
  const open = [...steps].filter((x) => !x.checked).length;
  if (ok && open && (!p.armed || src !== "card" || performance.now() - p.armedAt < 1000)) {
    // A refused press starts the second again, so a hurried run never passes.
    p.armedAt = performance.now();
    p.armed = true;
    // In place: the card is not drawn again, so nothing moves (V4).
    const w = document.querySelector('[data-card="' + id + '"] [data-armwarn]');
    if (w) {
      w.textContent = armText(open, steps.length);
      w.hidden = false;
    }
    savePicks();
    return;
  }
  p.armed = false;
  sent();
  const next = nextAfter(id);
  pending.add(id);
  setToast((ok ? "Done: " : "Could not do it: ") + questionOf(c).slice(0, 60), id);
  redraw();
  flash(next, true);
  try {
    await api("POST", "/api/cards/" + id + "/action", { ok, note: p.note });
    await poll(true);
  } catch (err) {
    clearToast();
    p.err = "Antifeed did not take this: " + err.message;
    setCur(id);
    redraw();
  } finally {
    pending.delete(id);
    redraw();
  }
}

function nextAfter(id) {
  const { list } = queueLists();
  const i = list.findIndex((c) => c.id === id);
  const n = list[i + 1] || list[i - 1];
  setCur(n ? n.id : null);
  return cur;
}
// The current card is always first in the queue: going to the top shows the
// filters and the whole card head, never under the header.
function flash(id, force) {
  requestAnimationFrame(() => {
    const el = id && document.querySelector('[data-card="' + id + '"]');
    if (!el) return;
    el.classList.add("arrived");
    const top = el.getBoundingClientRect().top;
    const head = $("header").getBoundingClientRect().bottom;
    if (force || top < head || top > window.innerHeight * 0.6) window.scrollTo({ top: 0, behavior: "smooth" });
  });
}
// Your call's top in view, and the focus on its first picked chip, so a key or a tap goes on from there.
function jumpTo(id) {
  requestAnimationFrame(() => {
    const z = document.querySelector('[data-callzone="' + id + '"]');
    if (!z) return;
    const head = getComputedStyle($("header")).position === "sticky" ? $("header").offsetHeight : 0;
    window.scrollTo({ top: z.getBoundingClientRect().top + window.scrollY - head - 12, behavior: "smooth" });
    const f = z.querySelector(".chip.on, .option.on, .chip, textarea");
    if (f) f.focus({ preventScroll: true });
  });
}
// id: the card an Undo takes back; null for a toast that only tells. The
// Undo button counts down the seconds that are left.
// The toast and Confirm never share a place (V3), so an Undo is always an Undo.
function toastUndo() {
  if (!toast) return;
  if (toast.fn) {
    const fn = toast.fn;
    clearToast();
    fn();
  } else if (toast.id) undo(toast.id);
}
function clearToast() {
  clearTimeout(toast && toast.timer);
  clearInterval(toast && toast.tick);
  toast = null;
}
// fn: an Undo that runs here (Later), in place of a card's Undo.
// The card's title leads a decision's toast, so its Undo says which card it is
// for; the header cuts the title, never the call after it (PM, 2026-10-26).
// Such a toast's text is [title, call].
function toastTitle(c) {
  const q = questionOf(c);
  return q.length > 60 ? q.slice(0, 59) + "…" : q;
}
function setToast(text, id, ms = UNDO_MS, fn = null) {
  clearToast();
  toast = { text, id, fn, shownAt: performance.now(), until: Date.now() + ms, timer: setTimeout(() => (clearInterval(toast.tick), (toast = null), drawChrome()), ms), tick: id || fn ? setInterval(() => drawToast(true), 1000) : null };
}
// The toast shows on every tab: its Undo must not go away with a tab switch.
// A toast that only tells has a Close button.
function drawToast(show) {
  const el = $("#toast");
  show = show && !!toast;
  const left = toast ? Math.max(1, Math.ceil((toast.until - Date.now()) / 1000)) : 0;
  const undoable = toast && (toast.id || toast.fn);
  const full = show ? [].concat(toast.text).join("") : "";
  const text = show && Array.isArray(toast.text) ? '<span class="ttext tsplit" title="' + esc(full) + '"><span class="ttitle">' + esc(toast.text[0]) + '</span><span class="tcall">' + esc(toast.text[1]) + "</span></span>" : '<span class="ttext" title="' + esc(full) + '">' + esc(full) + "</span>";
  const html = show ? text + (undoable ? '<button class="btn small" data-toast-undo title="Take back the last call (Ctrl+Z)">Undo (' + left + ' s)<span class="kh" aria-hidden="true"> Ctrl+Z</span></button>' : '<button class="btn small" data-toast-close aria-label="Close" title="Close this notice">Close</button>') : "";
  setHtml(el, html);
  const was = el.hidden;
  el.hidden = !show;
  if (was !== el.hidden) stickyShow();
}
// A held action's toast comes back after a reload, for the time that is left.
// A decision's toast comes back too, while its Undo time (UNDO_MS) is not over.
function heldToast() {
  if (toast && (toast.id || toast.fn)) return;
  const h = cards().find((c) => c.held && Date.parse(c.held.until) > Date.now());
  if (h) return setToast((h.held.ok ? "Done: " : "Could not do it: ") + questionOf(h).slice(0, 60), h.id, Date.parse(h.held.until) - Date.now());
  const d = cards().filter((c) => c.decision && String(c.decision.by).startsWith("human:") && c.decidedAt && Date.now() - Date.parse(c.decidedAt) < UNDO_MS).sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
  if (d) setToast([toastTitle(d), toastWhat(d, d.decision.call, d.decision.generic)], d.id, UNDO_MS - (Date.now() - Date.parse(d.decidedAt)));
}
// C4: a request for a new packet is no decision, and the toast says so.
const toastWhat = (c, call, generic) => (generic ? (generic.kind === "rewrite" ? " · Asked for a new packet" : " · Asked for variants of option " + String(generic.option).toUpperCase()) : " · Decided " + callText(policyOf(c), call, c));
// Part L (Nil, 2026-10-30: "the undo panel is covering important part of the
// ui"): the toast lives at the bottom of the screen, bottom right on a
// desktop and full width on a phone, above the call bar while it shows.
function placeDock() {
  const t = $("#toast");
  if (t.parentElement !== document.body) document.body.appendChild(t);
}
DESK.addEventListener("change", () => {
  placeDock();
  for (const [k] of TABS) stale[k] = true;
  redraw();
});
// Undo brings back Nil's own call, not the Premove: the fields, the option,
// the note and the draft text that went (or an action's note). The view
// carries the same call (`undone`), so another device gets it too. Undo
// stays on its tab, and the card is the current one when the Queue opens.
function restoreCall(c) {
  if (c.decision) fromCall(c, c.decision.call, c.decision.option);
  else if (c.action) {
    const p = pickOf(c);
    p.note = c.action.note || p.note;
  }
  savePicks();
}
async function undo(id) {
  const before = cardById(id);
  clearToast();
  try {
    await api("POST", "/api/cards/" + id + "/undo");
    if (before) restoreCall(before);
    await poll(true);
    setCur(id);
    if (tab === "queue") flash(id, true);
    // Round 9: within its Undo time, nothing of the call ran; after it, what ran stays done.
    const late = before && before.decidedAt && Date.now() - Date.parse(before.decidedAt) > UNDO_MS;
    // Slice 8 walk 2: no card title, which a desk cut; the card is open behind the toast.
    setToast("Back in the queue with your call." + (late ? " What the call started already ran, and stays done." : ""), null, 5000);
    redraw();
  } catch (err) {
    setToast("Antifeed did not undo it: " + err.message, null, 6000);
    redraw();
  }
}
// L39: the task id goes to the clipboard; the button says so for a moment.
async function copyId(btn, text) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // No clipboard API (a page over plain http): a selected textarea.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch {}
    ta.remove();
  }
  // Round 13: the card can draw again within the moment (a view update), so
  // the draw keeps "Copied" too, and the label changes on the button in the page now.
  copied = ok ? { text, until: Date.now() + 1500 } : { text: null, until: 0 };
  const btns = () => [btn, ...document.querySelectorAll("[data-copy]")].filter((b) => b.dataset.copy === text);
  for (const b of btns()) b.textContent = ok ? "Copied" : "Copy failed";
  clearTimeout(copyId.t);
  copyId.t = setTimeout(() => btns().forEach((b) => (b.textContent = "Copy")), 1500);
}
function focusNote(id) {
  const el = document.querySelector('[data-card="' + id + '"] [data-note]');
  if (el) el.focus();
}

// An option fills the fields; it fills the note only when the note is empty
// or still holds another option's text, so Nil's own words stay.
function choose(c, optId) {
  const opts = c.packet.options;
  const o = opts.find((x) => x.id === optId);
  const p = pickOf(c);
  const before = { ...p.call };
  p.option = optId;
  p.from = optId;
  const optionNotes = opts.map((x) => (x.fill.note || "").trim()).filter(Boolean);
  // A note that starts with another option's text and goes on with Nil's own
  // words: that option's text is swapped for this one's, his words stay.
  const lead = optionNotes.find((n) => p.note.trim().startsWith(n));
  for (const [k, v] of Object.entries(o.fill))
    if (k === "note") {
      if (!p.note.trim() || optionNotes.includes(p.note.trim())) p.note = v || "";
      else if (lead) p.note = ((v || "") + p.note.trim().slice(lead.length)).trim();
    } else p.call[k] = v;
  if (!("note" in o.fill) && lead) p.note = p.note.trim().slice(lead.length).trim();
  p.restored = false;
  p.err = "";
  p.errField = null;
  p.auto = "";
  syncCall(c);
  // C2: the chips the option changed flash once, so Nil sees what it filled.
  const z = document.querySelector('[data-callzone="' + c.id + '"]');
  if (z)
    for (const b of z.querySelectorAll("[data-field].on"))
      if ((before[b.dataset.field] ?? null) !== (p.call[b.dataset.field] ?? null)) {
        b.classList.remove("filled");
        void b.offsetWidth;
        b.classList.add("filled");
      }
}
// The next card is picked before this one moves to the end, so Later goes to
// the next card, not the oldest.
function later(id) {
  const c = cardById(id);
  nextAfter(id);
  const l = laterIds().filter((x) => x !== id);
  l.push(id);
  sessionStorage.setItem("af.later", JSON.stringify(l));
  setToast("Later, on this device only: " + (c ? questionOf(c).slice(0, 60) : id), null, UNDO_MS, () => {
    sessionStorage.setItem("af.later", JSON.stringify(laterIds().filter((x) => x !== id)));
    setCur(id);
    redraw();
    flash(id, true);
  });
  redraw();
  flash(cur, true);
}
// F2 (Antifeed PM, 2026-10-29): after a change of the sort or a filter the
// open card is the first of the new order, unless Nil started a call on it
// (a field, the option or the note differs from what was filled in, a ticked
// step, or chat words not sent): then it stays open and the summary says so.
let keptDraft = null;
const SEARCH_SETTLE_MS = 800;
let searchTimer = null;
function hasDraft(c) {
  if ((chatDrafts[c.id] || "").trim()) return true;
  const p = picks[c.id];
  if (!p || p.v !== c.version) return false;
  if (p.restored || p.note.trim() !== (isAction(c) ? "" : ((premoveOption(c) || { fill: {} }).fill.note || "").trim())) return true;
  if (Object.values(p.ticks || {}).some(Boolean)) return true;
  if (isAction(c)) return false;
  const opt = premoveOption(c);
  const fresh = { ...premoveCall(c), ...draftsOf(c.packet && c.packet.blocks) };
  const keys = new Set([...Object.keys(fresh), ...Object.keys(p.call)]);
  return (p.option || null) !== (opt ? opt.id : null) || [...keys].some((k) => (fresh[k] ?? null) !== (p.call[k] ?? null));
}
function reorder() {
  const { list } = queueLists();
  const c = cur && cardById(cur);
  keptDraft = null;
  if (c && list.some((x) => x.id === cur) && hasDraft(c)) {
    if (list[0].id !== cur) keptDraft = cur;
    return;
  }
  if (list[0]) setCur(list[0].id);
}
function saveView() {
  localStorage.setItem("af.view4", JSON.stringify(view));
}
function step(n) {
  const { list } = queueLists();
  const i = list.findIndex((x) => x.id === cur);
  if (!list[i + n]) return;
  setCur(list[i + n].id);
  redraw();
  flash(cur, true);
}
function refine(c) {
  const p = pickOf(c);
  if (!p.option) {
    p.err = "Pick an option first: " + creatorName(c) + " sends variants close to it.";
    redraw();
    syncCall(c);
    return;
  }
  confirm(c.id, { kind: "refine", option: p.option });
}

document.addEventListener("click", (e) => {
  // L80: a click on the black around the image closes the viewer.
  if (lb && e.target.closest("#lb") && !e.target.closest("button, img, .lb-bar, figcaption, .lb-label")) {
    closeLb();
    return;
  }
  if (showKeys && !e.target.closest("#keys, [data-keys]")) {
    showKeys = false;
    drawChrome();
  }
  const t = e.target.closest("button, summary, a[data-term], a[data-goto], [data-lb-zoom], input[data-tick]");
  if (!t) return;
  const d = t.dataset;
  if (d.term !== undefined) {
    e.preventDefault();
    if (lastPointer === "mouse") go("help-" + d.term);
    else termPop(t);
    return;
  }
  if (d.goto !== undefined) {
    e.preventDefault();
    go(d.goto);
    return;
  }
  const cardEl = t.closest("[data-card]");
  const id = (cardEl && cardEl.dataset.card) || (t.closest("[data-sticky]") && t.closest("[data-sticky]").dataset.sticky);
  const c = id && cardById(id);
  if (d.tick !== undefined && c) {
    pickOf(c).ticks[d.tick] = t.checked;
    pickOf(c).armed = false;
    const w = document.querySelector('[data-card="' + c.id + '"] [data-armwarn]');
    if (w) w.hidden = true;
    savePicks();
    return;
  }
  if (d.tab) {
    moreOpen = false;
    go(d.tab);
  }
  else if (d.cur) {
    // A pick from the list is a history step: Back returns to the card before.
    history.replaceState({ ...(history.state || {}), cur }, "", location.hash || "#queue");
    history.pushState({ cur: d.cur }, "", location.hash || "#queue");
    setCur(d.cur);
    redraw();
    flash(d.cur, true);
  } else if (d.kind !== undefined) {
    // Several kinds at once (Nil, 2026-10-30: "why can't i select multiple kinds at once"): a chip adds or drops its kind; All clears them.
    view.kinds = !d.kind ? [] : view.kinds.includes(d.kind) ? view.kinds.filter((x) => x !== d.kind) : [...view.kinds, d.kind];
    saveView();
    reorder();
    redraw();
  } else if (d.multi) {
    const k = d.multi;
    view[k] = !d.v ? [] : view[k].includes(d.v) ? view[k].filter((x) => x !== d.v) : [...view[k], d.v];
    saveView();
    reorder();
    redraw();
  } else if (d.seg) {
    // A new sort key starts in its first direction.
    if (d.seg === "sort" && view.sort !== d.v) view.dir = (SORTS.find((x) => x[0] === d.v) || SORTS[0])[3][0][0];
    view[d.seg] = d.v;
    saveView();
    reorder();
    redraw();
  } else if (t.hasAttribute("data-clear")) {
    Object.assign(view, { ...VIEW0, sort: view.sort, dir: view.dir, kinds: [], efforts: [], conf: [] });
    saveView();
    reorder();
    redraw();
  } else if (d.new !== undefined) {
    toggleNew();
    drawChrome();
  } else if (d.newclose !== undefined) {
    toggleNew(false);
    drawChrome();
  } else if (d.newto) {
    newTarget = d.newto;
    drawNew();
  } else if (d.newsend !== undefined) {
    newSend(newDraft);
  } else if (d.newtell) {
    api("POST", "/api/inputs/" + encodeURIComponent(d.newtell) + "/tell", {})
      .catch((err) => (newErr = err.message))
      .then(() => poll(true))
      .then(drawNew);
  } else if (d.newagain) {
    const x = inputsOf().sent.find((y) => y.id === d.newagain);
    if (x) newSend(x.text, x.target, true, x.images);
  } else if (d.newpick !== undefined) {
    const f = document.querySelector("[data-newfile]");
    if (f) f.click();
  } else if (d.newshotx) {
    dropShot(d.newshotx);
  } else if (d.chatsend) {
    const box = document.querySelector('[data-chatbox="' + CSS.escape(d.chatsend) + '"]');
    chatSend(d.chatsend, box ? box.value : chatDrafts[d.chatsend]);
  } else if (d.cardagain) {
    wantCard(d.cardagain, true);
    stale.decided = true;
    drawTab("decided");
  } else if (d.chatagain) {
    const c = cards().find((x) => (x.thread || []).some((m) => m.id === d.chatagain));
    const m = c && c.thread.find((x) => x.id === d.chatagain);
    if (m) chatSend(c.id, m.text);
  } else if (t.hasAttribute("data-filters")) {
    filtersOpen = !filtersOpen;
    drawTab(tab);
    stickyShow();
  } else if (d.step) step(Number(d.step));
  else if (d.field !== undefined && c) {
    const p = pickOf(c);
    p.call[d.field] = JSON.parse(d.v);
    if (d.field === "choice") p.rewrite = false;
    p.err = "";
    p.errField = null;
    p.restored = false;
    settle(c, p, d.field);
    syncCall(c);
  } else if (d.opt && c) choose(c, d.opt);
  else if (d.souse && c) {
    // Only Use fills a field with the Scout's suggestion (Nil, 2026-10-23).
    const [kind, n] = d.souse.split(":");
    const p = pickOf(c);
    p.comments = p.comments || { copy: {}, images: {} };
    p.comments[kind][n] = soSuggestions(c)[kind][n] || "";
    const box = document.querySelector('[data-card="' + c.id + '"] [data-socomment="' + kind + ":" + n + '"]');
    if (box) box.value = p.comments[kind][n];
    savePicks();
  } else if (d.soopen && c) {
    for (const k of ["socopy:", "soimgs:"]) openFolds.add(k + c.id);
    redraw();
  } else if (t.hasAttribute("data-loopw") && c) {
    pickOf(c).rewrite = true;
    pickOf(c).err = "";
    syncCall(c);
    focusNote(c.id);
  }
  else if (t.hasAttribute("data-reset") && c) {
    resetToPremove(c);
    syncCall(c);
  } else if (t.hasAttribute("data-safe") && c) {
    const p = pickOf(c);
    Object.assign(p.call, c.prediction.call);
    p.auto = "";
    p.err = "";
    p.errField = null;
    syncCall(c);
  } else if (t.hasAttribute("data-openall") && c) toggleFolds(c.id);
  else if (d.copy !== undefined) copyId(t, d.copy);
  else if (t.hasAttribute("data-jump") && id) {
    acted.add(actKey());
    jumpTo(id);
  }
  else if ((t.hasAttribute("data-confirm") || t.hasAttribute("data-done")) && t.closest("[data-sticky]") && t.closest("[data-sticky]").dataset.state !== "ready") return;
  else if (t.hasAttribute("data-confirm")) confirm(id);
  else if (t.hasAttribute("data-rewrite")) confirm(id, { kind: "rewrite" });
  else if (t.hasAttribute("data-refine") && c) refine(c);
  else if (t.hasAttribute("data-later")) later(id);
  else if (t.hasAttribute("data-done")) finishAction(id, true, t.closest("[data-sticky]") ? "bar" : "card");
  else if (t.hasAttribute("data-failed")) finishAction(id, false);
  else if (d.undo) undo(d.undo);
  else if (t.hasAttribute("data-toast-undo")) toastUndo();
  else if (t.hasAttribute("data-remote-ok")) {
    remoteNotice = null;
    armGuard();
    redraw();
    flash(cur, true);
  } else if (t.hasAttribute("data-more")) {
    moreOpen = !moreOpen;
    drawChrome();
  } else if (t.hasAttribute("data-toast-close")) {
    clearToast();
    drawChrome();
  }
  else if (t.hasAttribute("data-keys")) {
    showKeys = !showKeys;
    drawChrome();
  } else if (t.hasAttribute("data-keys-close")) {
    showKeys = false;
    drawChrome();
  } else if (d.lb) {
    // One viewer step per image, or per pair. Round 10: on a phone, one step
    // per image, at full width: Previous, Next and a swipe go from Before to After.
    const items = [];
    for (const x of document.querySelectorAll('[data-card="' + d.lb + '"] [data-lb], [data-dcard="' + d.lb + '"] [data-lb]')) {
      const one = { src: x.dataset.src, cap: x.dataset.cap, side: x.dataset.side || null, focus: x.dataset.focus ? x.dataset.focus.split(",").map(Number) : null };
      const it = DESK.matches && x.dataset.pair && items.find((y) => y.pair === x.dataset.pair && y.srcs.length < 2);
      if (it) it.srcs.push(one);
      else items.push({ pair: x.dataset.pair || null, cap: one.cap, srcs: [one] });
    }
    lb = { items, i: Math.max(0, items.findIndex((x) => x.srcs.some((y) => y.src === d.src))) };
    // The viewer is a history step, so Back on a phone closes it and stays in the app.
    history.pushState({ ...(history.state || {}), lb: true }, "", location.hash);
    lbPushed = true;
    drawChrome();
  } else if (d.lbStep) {
    lb.i = (lb.i + Number(d.lbStep) + lb.items.length) % lb.items.length;
    drawChrome();
  } else if (t.hasAttribute("data-lb-close")) closeLb(); else if (t.hasAttribute("data-lb-zoom")) $("#lb").classList.toggle("zoom");
});

document.addEventListener("toggle", (e) => {
  const k = e.target.dataset && e.target.dataset.dkey;
  if (!k) return;
  if (e.target.open) openFolds.add(k);
  else openFolds.delete(k);
  const fc = e.target.closest("[data-card]");
  if (fc) syncFoldsButton(fc.dataset.card);
  // A row drawn again opens with a toggle too, so only a close forgets a failed load.
  if (/^dec:[^:]+$/.test(k)) {
    if (e.target.open) wantCard(k.slice(4));
    else if (fullCards[k.slice(4)] && fullCards[k.slice(4)].error) delete fullCards[k.slice(4)];
  }
  const fr = e.target.open && e.target.querySelector("iframe[data-src]");
  if (fr && !fr.src) fr.src = fr.dataset.src;
  // A fold whose text loads when opened draws again.
  if (e.target.open && (k.endsWith(":made") || k.endsWith(":raw") || k.startsWith("setup:crit:"))) {
    for (const [name] of TABS) stale[name] = true;
    drawTab(tab);
  }
}, true);

document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.view !== undefined) {
    view[t.dataset.view] = t.value;
    saveView();
    // Round 9: the whole page, so the tab's count and the header bar follow the search.
    redraw();
    // F2: the open card moves to the first of the new order only when the typing
    // stops (SEARCH_SETTLE_MS after the last key), so it does not jump at each key.
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      reorder();
      redraw();
    }, SEARCH_SETTLE_MS);
    return;
  }
  if (t.dataset.newbox !== undefined) return void ((newDraft = t.value), growBox(t, 12));
  // The chat box is not part of the call.
  if (t.dataset.chatbox !== undefined) return void ((chatDrafts[t.dataset.chatbox] = t.value), growBox(t));
  const cardEl = t.closest("[data-card]");
  const c = cardEl && cardById(cardEl.dataset.card);
  if (!c) return;
  const p = pickOf(c);
  markActed(e);
  if (t.hasAttribute("data-note")) p.note = t.value;
  else if (t.dataset.socomment) {
    // Part J: a sign-off comment, kept with the note in this tab (sessionStorage) until the call.
    const [kind, n] = t.dataset.socomment.split(":");
    p.comments = p.comments || { copy: {}, images: {} };
    p.comments[kind][n] = t.value;
  } else if (t.dataset.draft) p.call[t.dataset.draft] = t.value;
  else if (t.dataset.text) p.call[t.dataset.text] = t.value || null;
  if (!isAction(c)) p.restored = false;
  // "Changed from the Premove" keeps up with every key.
  syncCall(c);
});

document.addEventListener("keydown", (e) => {
  const t = e.target;
  // In the chat box, Enter sends and Shift+Enter makes a new line; no other key of the page acts.
  if (t.dataset && t.dataset.chatbox !== undefined) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      chatSend(t.dataset.chatbox, t.value);
    }
    return;
  }
  // In the New box, Enter sends, Shift+Enter makes a new line, Esc closes.
  if (t.dataset && t.dataset.newbox !== undefined) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      newSend(t.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      toggleNew(false);
      drawChrome();
    }
    return;
  }
  const typing = t.tagName === "TEXTAREA" || t.tagName === "INPUT";
  if (lb) {
    if (e.key === "Escape") return void (e.preventDefault(), closeLb());
    else if (e.key === "ArrowRight") lb.i = (lb.i + 1) % lb.items.length;
    else if (e.key === "ArrowLeft") lb.i = (lb.i - 1 + lb.items.length) % lb.items.length;
    else return;
    e.preventDefault();
    drawChrome();
    return;
  }
  if (showKeys && e.key === "Escape") {
    showKeys = false;
    drawChrome();
    return e.preventDefault();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && toast && (toast.id || toast.fn) && !typing) {
    e.preventDefault();
    toastUndo();
    return;
  }
  const c = tab === "queue" && !remoteNotice && cur && cardById(cur);
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && c) {
    e.preventDefault();
    if (typing && t.closest("[data-card]") && t.closest("[data-card]").dataset.card !== cur) return;
    if (fresh()) return;
    // An action is never finished by Ctrl+Enter: it takes d or its button.
    if (isAction(c)) {
      pickOf(c).err = "An action takes its own key, d, or the Done button.";
      redraw();
      return;
    }
    confirm(c.id);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  if (typing) {
    if (e.key === "Escape") t.blur();
    return;
  }
  if (e.key === "N") {
    toggleNew(true);
    drawChrome();
    return e.preventDefault();
  }
  if (newOpen && e.key === "Escape") {
    toggleNew(false);
    drawChrome();
    return e.preventDefault();
  }
  if (e.key === "?") {
    showKeys = !showKeys;
    drawChrome();
    return e.preventDefault();
  }
  if (e.key === "/" && tab === "queue") {
    if (!filtersOpen) {
      filtersOpen = true;
      drawTab(tab);
      stickyShow();
    }
    const s = document.querySelector("[data-view=q]");
    if (s) {
      e.preventDefault();
      s.focus();
    }
    return;
  }
  if (!c) return;
  const k = e.key;
  // A key that works on the card (a pick, a note, the folds, an option) is an act on it.
  if (["n", "e", "a", "p"].includes(k) || keyMap(c)[k]) markActed(e);
  if (k === "j" || k === "ArrowDown") step(1);
  else if (k === "k" || k === "ArrowUp") step(-1);
  else if (k === "n") focusNote(c.id);
  else if (k === "e") toggleFolds(c.id);
  else if (k === "l") later(c.id);
  else if (isAction(c)) {
    if (k === "f") finishAction(c.id, false);
    else if (k === "d" && !fresh()) finishAction(c.id, true, "key");
    else return;
  } else if (isSO(c) && (k === "a" || k === "r")) {
    const p = pickOf(c);
    p.call.call = k === "a" ? "approve" : "revert";
    p.err = "";
    syncCall(c);
    if (k === "r" && !p.note.trim()) focusNote(c.id);
  } else if (isSO(c) && ["p", "w"].includes(k)) return;
  else if (isLoop(c) && ["a", "p", "r"].includes(k)) return;
  else if (isLoop(c) && k === "w") {
    pickOf(c).rewrite = true;
    pickOf(c).err = "";
    syncCall(c);
  } else if (k === "a") {
    if (!changes(c, pickOf(c)).length) return;
    resetToPremove(c);
    syncCall(c);
  } else if (k === "p" && c.packet.options && c.packet.options.length) {
    const opts = c.packet.options;
    const j = opts.findIndex((o) => o.id === pickOf(c).option);
    choose(c, opts[(j + 1) % opts.length].id);
  } else if (k === "w" && policyOf(c).prepare) {
    if (ownNote(c)) confirm(c.id, { kind: "rewrite" });
    else {
      pickOf(c).err = newPacketNeeds(c);
      redraw();
      syncCall(c);
      focusNote(c.id);
    }
  } else if (k === "r" && policyOf(c).prepare) refine(c);
  else {
    const m = keyMap(c)[k];
    if (!m) return;
    const p = pickOf(c);
    p.call[m.field] = m.value;
    if (m.field === "choice") p.rewrite = false;
    p.err = "";
    p.errField = null;
    settle(c, p, m.field);
    syncCall(c);
  }
  e.preventDefault();
});

// ---- hover help (L129) ----------------------------------------------------------

// Every button, chip and label says what it does when the mouse rests on it.
// An element that has its own title keeps it. On a phone, the same words
// show as the help lines under the fields and the Terms links.
// Round q1b, P4: the read-only tabs say so in the same words.
const TAB_TIPS = { queue: "The packets that wait for your call", decided: "Your recent calls; open one for its details, Undo puts it back", accuracy: "How often the Premove matches your call (read only)", policies: "What each policy reads, who decides, and what it sends (read only)", setup: "What each project declares (read only)", sources: "Where the cards come from, and whether Antifeed can read each source (read only)", status: "Commands in flight, failures, the log (read only)", help: "What Antifeed is, how a packet goes, and its words" };
const MORE_TIP = () => "Show or hide the other tabs: " + TABS.filter(([k]) => MORE_TABS.includes(k)).map(([, l]) => l).join(", ");
const fieldOf = (el) => {
  const c = cardById((el.closest("[data-card]") || {}).dataset?.card || (el.closest("[data-sticky]") || {}).dataset?.sticky || "");
  return c && [c, policyOf(c)];
};
const TIPS = [
  ["[data-tab]", (el) => TAB_TIPS[el.dataset.tab]],
  ["[data-more]", MORE_TIP],
  ["[data-filters]", () => "Show or hide the filters and the sort"],
  ["[data-seg=sort]", (el) => (SORTS.find((x) => x[0] === el.dataset.v) || [])[2]],
  ["[data-seg=dir]", (el) => cap((dirOf() && sortOf()[3].find((x) => x[0] === el.dataset.v) || [, , ""])[2])],
  ["[data-clear]", () => "Clear every filter; the sort stays"],
  ["[data-step]", (el) => (el.dataset.step === "1" ? "The next packet in the queue (j)" : "The packet before it in the queue (k)")],
  ["[data-field]", (el) => {
    const x = fieldOf(el);
    const f = x && (x[1].answer || {})[el.dataset.field];
    return "Set " + (f ? fieldLabel(el.dataset.field, f).toLowerCase() : el.dataset.field) + " to " + valueLabel(JSON.parse(el.dataset.v)) + (el.classList.contains("pm") ? ". The ring and the dot: the Premove's value" : "");
  }],
  ["[data-opt]", (el) => "Fill the fields with this option; you can change them after (p: the next option)" + (el.classList.contains("pm") ? ". The ring and the dot: the Premove's option" : "")],
  ["[data-reset]", () => "Put every field, the option and the note back as the Premove has them (a)"],
  ["[data-safe]", () => "Fill in the policy's safe default; you still confirm it"],
  ["[data-confirm]", (el) => {
    const c = cardById((el.closest("[data-card]") || el.closest("[data-sticky]") || {}).dataset?.card || (el.closest("[data-sticky]") || {}).dataset?.sticky);
    const why = c ? readyFor(c) : "";
    return (why ? why + " " : "") + "Send your call (Ctrl+Enter). You can undo it for " + UNDO_S + ", before anything acts on it";
  }],
  ["[data-done]", () => "Mark the action done (d). You can undo it for " + UNDO_S],
  ["[data-failed]", () => "Say you could not do it; the note says why (f)"],
  ["[data-jump]", () => "Go to Your call on the packet"],
  ["[data-undo]", () => "Put this packet back in the queue, with your call filled in"],
  ["[data-toast-undo]", () => "Take back the last call (Ctrl+Z)"],
  ["[data-toast-close]", () => "Close this notice"],
  ["[data-remote-ok]", () => "Show the next packet in the queue"],
  ["[data-cur]", () => "Open this packet"],
  ["[data-keys-close]", () => "Close the list of keys (Esc)"],
  ["[data-chatlink] a, #chatlink a", () => "Open the office page with this app and " + chatAgent() + "'s chat, for the app itself"],
  [".flabel", (el) => {
    const row = el.closest("[data-frow]") || el.parentElement;
    const k = row && (row.dataset.frow || (row.querySelector("[data-text]") || {}).dataset?.text);
    const x = fieldOf(el);
    const f = x && k && (x[1].answer || {})[k];
    if (f && f.help) return f.help;
    return x && k === primaryOf(x[0]) ? "Your decision on this packet" : "The " + el.textContent.toLowerCase() + " your call gives";
  }],
  ["[data-text]", (el) => {
    const x = fieldOf(el);
    const f = x && (x[1].answer || {})[el.dataset.text];
    return (f && f.help) || "Optional: it goes with your call";
  }],
  [".premove > .zlabel .who", () => "Who made this Premove"],
  [".sbcall", () => "Your call as it stands now; Confirm sends it"],
  [".yourcall > .zlabel > span:first-child", (el) => (el.textContent === "Your part" ? "What only you can do: the steps, then Done or Could not do it" : "What you send: an option or the fields, a note, then Confirm")],
  [".kind", () => "The kind of packet"],
  [".standin-tag, .updtag, .latertag, .rec, .ofill", (el) => el.classList.contains("rec") ? "The option the packet creator picked" : el.classList.contains("ofill") ? "The fields this option fills" : el.classList.contains("latertag") ? "You moved it to the end of the queue, on this device" : el.classList.contains("updtag") ? "The Premove changed in the last minute" : "A stand-in made this Premove: the Predictor did not"],
  [".pcall", () => "The call the Premove predicts for you"],
  [".conf", () => "How sure the Premove is"],
  [".count", () => "The packets these filters show, of all the open packets"],
];
// Round 9: a styled tooltip at the page's text size, 400 ms after the mouse
// rests on a control. The title is held aside while it shows, so the
// browser's own small tooltip does not show too.
const tipEl = document.createElement("div");
tipEl.className = "tip";
tipEl.setAttribute("role", "tooltip");
tipEl.hidden = true;
document.body.appendChild(tipEl);
let tipFor = null;
let tipTimer = null;
// Round 10: a press hides the tip, and no tip shows again until the mouse
// moves 8 px from the press (a press can redraw the control under it).
let tipPress = null;
function hideTip() {
  clearTimeout(tipTimer);
  tipEl.hidden = true;
  if (tipFor && tipFor._tip !== undefined) {
    tipFor.setAttribute("title", tipFor._tip);
    delete tipFor._tip;
  }
  tipFor = null;
}
document.addEventListener("pointerover", (e) => {
  if (e.pointerType !== "mouse") return;
  // pointerover comes before pointermove: a jump away from the press ends the hold here too.
  if (tipPress && Math.hypot(e.clientX - tipPress[0], e.clientY - tipPress[1]) >= 8) tipPress = null;
  if (tipPress) return;
  const el = e.target.closest ? e.target.closest("[title]") || (tipFor && tipFor.contains(e.target) ? tipFor : null) : null;
  if (el === tipFor) return;
  hideTip();
  if (!el || el.closest("#lb")) return;
  tipFor = el;
  el._tip = el.getAttribute("title");
  el.removeAttribute("title");
  tipTimer = setTimeout(() => {
    if (tipFor !== el || !el.isConnected || !el._tip) return;
    tipEl.textContent = el._tip;
    tipEl.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    const h = tipEl.offsetHeight;
    const below = r.bottom + 8 + h < window.innerHeight;
    tipEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    tipEl.style.top = (below ? r.bottom + 8 : Math.max(8, r.top - h - 8)) + "px";
  }, 400);
}, true);
document.addEventListener("pointerout", (e) => {
  if (tipFor && (!e.relatedTarget || !tipFor.contains(e.relatedTarget))) hideTip();
}, true);
for (const ev of ["pointerdown", "keydown", "scroll"]) window.addEventListener(ev, hideTip, { capture: true, passive: true });
window.addEventListener("pointerdown", (e) => (tipPress = [e.clientX, e.clientY]), { capture: true, passive: true });
window.addEventListener("pointermove", (e) => {
  if (tipPress && Math.hypot(e.clientX - tipPress[0], e.clientY - tipPress[1]) >= 8) tipPress = null;
}, { capture: true, passive: true });
// On a touch screen a tap on a dotted word shows its definition here, with a
// link to its Help entry (round q1b, P9). A tap anywhere else closes it.
const popEl = document.createElement("div");
popEl.className = "termpop";
popEl.setAttribute("role", "dialog");
popEl.hidden = true;
document.body.appendChild(popEl);
function termPop(a) {
  const d = TERMS.find((x) => x[0] === a.dataset.term);
  if (!d) return;
  popEl.innerHTML = "<b>" + esc(d[1]) + "</b>: " + esc(d[2]) + ' <a href="#help-' + d[0] + '" data-goto="help-' + d[0] + '">More in Help</a>';
  popEl.hidden = false;
  const r = a.getBoundingClientRect();
  const w = popEl.offsetWidth;
  popEl.style.left = Math.max(8, Math.min(document.documentElement.clientWidth - w - 8, r.left + r.width / 2 - w / 2)) + window.scrollX + "px";
  popEl.style.top = r.bottom + 8 + window.scrollY + "px";
}
const closePop = () => (popEl.hidden = true);
window.addEventListener("pointerdown", (e) => !popEl.hidden && !popEl.contains(e.target) && !(e.target.closest && e.target.closest("a.term")) && closePop(), { capture: true, passive: true });
window.addEventListener("keydown", (e) => e.key === "Escape" && closePop(), true);
popEl.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (!g) return;
  e.preventDefault();
  e.stopPropagation();
  closePop();
  go(g.dataset.goto);
});

function applyTips(root) {
  if (!root.querySelectorAll) return;
  for (const [sel, fn] of TIPS) {
    const els = [...(root.matches && root.matches(sel) ? [root] : []), ...root.querySelectorAll(sel)];
    for (const el of els) {
      if ((el.hasAttribute("title") && !el.dataset.tip) || el._tip !== undefined) continue;
      const t = fn(el);
      if (t && el.title !== t) {
        el.title = t;
        el.dataset.tip = "1";
      }
    }
  }
}
// New nodes get their help as they are drawn.
new MutationObserver((list) => {
  for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) applyTips(n);
}).observe(document.body, { childList: true, subtree: true });

// ---- loading --------------------------------------------------------------

let polling = false;
async function poll(force) {
  if (polling && !force) return;
  polling = true;
  try {
    const res = await fetch("/api/view", { headers: etag ? { "If-None-Match": etag } : {} });
    if (res.status === 304) return;
    if (!res.ok) throw new Error("GET /api/view answered " + res.status);
    etag = res.headers.get("ETag");
    const was = cur && cardById(cur);
    const wasOpen = was && was.state === "open" && !was.held && !pending.has(was.id);
    V = loopOpen(await res.json());
    // V5: the current card moved on elsewhere (another device): say so before
    // the next card shows.
    const now = was && cardById(was.id);
    if (wasOpen && (!now || now.state !== "open" || now.held))
      remoteNotice = {
        id: was.id,
        text: now && now.decision ? "Decided on another device: " + callText(policyOf(now), now.decision.call, now) : now && now.held ? "Marked on another device: " + (now.held.ok ? "Done" : "Could not do it") : now && now.state === "withdrawn" ? "Withdrawn: " + withdrawnText(now) : "This packet left the queue",
        q: questionOf(was),
        mine: !isAction(was) && picks[was.id] ? callText(policyOf(was), picks[was.id].call, was) : "",
      };
    for (const [k] of TABS) stale[k] = true;
    redraw();
  } catch (err) {
    console.error(err);
  } finally {
    polling = false;
  }
}
// The tab's title says how many cards wait for Nil's call (the queue's own
// count, with no filter): "(3) Antifeed", or "Antifeed" at 0.
function drawTitle(n) {
  const t = n ? "(" + n + ") Antifeed" : "Antifeed";
  if (document.title !== t) document.title = t;
}
// A hidden tab does not redraw (a redraw there could mark a Premove as seen),
// so it reads the view only for the title, with its own ETag. It counts the
// same cards as queueLists: open, not held, no call in flight.
let titleEtag = null;
let titlePolling = false;
async function pollTitle() {
  if (titlePolling) return;
  titlePolling = true;
  try {
    const tag = titleEtag || etag;
    const res = await fetch("/api/view", { headers: tag ? { "If-None-Match": tag } : {} });
    if (res.status === 304 || !res.ok) return;
    titleEtag = res.headers.get("ETag");
    const v = await res.json();
    if (document.visibilityState !== "visible") drawTitle(v.cards.filter((c) => c.state === "open" && !c.held && !pending.has(c.id)).length);
  } catch (err) {
    console.error(err);
  } finally {
    titlePolling = false;
  }
}
async function loadStatus() {
  try {
    status = await api("GET", "/api/status");
    if (tab === "status" || tab === "sources") drawTab(tab);
  } catch (err) {
    console.error(err);
  }
}
// L79: a swipe in the viewer goes to the next or the previous image (not when zoomed to 100%, where a drag pans).
// Round 9: the browser must not take a sideways swipe as Back. The page
// takes the sideways move itself (touch-action and overscroll-behavior on
// the viewer, and preventDefault here); a Back that comes during a swipe
// anyway (a phone's edge gesture) keeps the viewer open (popstate below).
let lbTouch = null;
let lbSwipeAt = 0;
document.addEventListener("touchstart", (e) => {
  lbTouch = lb && !$("#lb").classList.contains("zoom") && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
document.addEventListener("touchmove", (e) => {
  if (!lb || !lbTouch || e.touches.length !== 1) return;
  const dx = e.touches[0].clientX - lbTouch.x;
  const dy = e.touches[0].clientY - lbTouch.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    lbSwipeAt = performance.now();
    if (e.cancelable) e.preventDefault();
  }
}, { passive: false });
document.addEventListener("touchend", (e) => {
  if (!lb || !lbTouch) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - lbTouch.x;
  const dy = t.clientY - lbTouch.y;
  lbTouch = null;
  if (Math.abs(dx) > 60 && Math.abs(dy) < 60) {
    lbSwipeAt = performance.now();
    if (lb.items.length < 2) return;
    lb.i = (lb.i + (dx < 0 ? 1 : -1) + lb.items.length) % lb.items.length;
    drawChrome();
  }
});
let ignorePop = false;
function closeLb() {
  lb = null;
  drawChrome();
  if (lbPushed) {
    lbPushed = false;
    ignorePop = true;
    history.back();
  }
}
// Back to this tab: read the view at once (another device may have acted).
window.addEventListener("focus", () => poll(true));
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && poll(true));
window.addEventListener("popstate", (e) => {
  if (ignorePop) return void (ignorePop = false);
  // A Back that a sideways swipe in the viewer made: the viewer stays, and its history step comes back.
  if (lb && (lbTouch || performance.now() - lbSwipeAt < 1000)) {
    history.pushState({ ...(history.state || {}), lb: true }, "", location.hash);
    lbPushed = true;
    return;
  }
  // Back with the image viewer open closes it.
  if (lb) {
    lb = null;
    lbPushed = false;
    drawChrome();
    return;
  }
  const st = e.state || {};
  if (st.lb) return void history.back();
  const h = newHash(location.hash.slice(1));
  // An old link (#terms-premove) shows the new name in the address.
  if (h !== location.hash.slice(1)) history.replaceState(history.state, "", "#" + h);
  const name = tabFromHash();
  if (name === "queue" && st.cur && cardById(st.cur) && name === tab) {
    setCur(st.cur);
    redraw();
    flash(st.cur, true);
    return;
  }
  if (st.cur && cardById(st.cur)) setCur(st.cur);
  showTab(name, h.includes("-") ? h : null);
});

// Round 10: the page's own history step names its tab, so a Back (from the viewer, say) lands on #queue, not on a bare /.
if (!location.hash) history.replaceState(history.state, "", location.pathname + location.search + "#" + tab);
for (const [k] of TABS) $("#tab-" + k).hidden = k !== tab;
applyTips(document.body);
placeDock();
heldToast();
redraw();
const h0 = newHash(location.hash.slice(1));
// An old link (#terms-premove) shows the new name in the address.
if (h0 !== location.hash.slice(1)) history.replaceState(history.state, "", "#" + h0);
if (h0.includes("-")) showTab(tab, h0);
loadStatus();
if (!V) poll(true);
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  poll();
  if (tab === "status" || tab === "sources") loadStatus();
}, POLL_MS);
// In a hidden tab, Chrome runs the page's timers once a minute at most; a
// worker's timer keeps the title at the poll's pace.
try {
  const w = new Worker(URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), " + POLL_MS + ")"], { type: "text/javascript" })));
  w.onmessage = () => document.visibilityState !== "visible" && pollTitle();
} catch (err) {
  setInterval(() => document.visibilityState !== "visible" && pollTitle(), POLL_MS);
}
