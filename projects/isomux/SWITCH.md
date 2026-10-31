# Switch: isomux triage moves from the loop app to Antifeed

Antifeed Builder, 2026-10-25. Needs Nil's go (Isomux PM, 2026-10-25). Nil
ruled Q1 A: at the switch, Nil's Direct Helper turns off the part of the
curator wake that announces untagged P0-P3 tasks (step 2).

## What changes for whom

- Nil triages new untagged P0-P3 tasks in Antifeed, with a Premove on each
  card. Backlog, On hold, design packets, Sign-off and Push stay in the loop
  app.
- The Isomux Curator gets `/antifeed` commands (prepare a packet, apply a
  call, answer the predictor) in place of the loop app's wake for those tasks.
- The loop app stops announcing untagged P0-P3 tasks to the Curator.

## Dry run (2026-10-25, read only)

A scratch engine read the real board with a token that cannot send:
- The board reader saw 39 open P0-P3 tasks, all tagged, so it opened 0 cards.
- The second read added nothing.
- The loop app's API gave 426 applied triage calls, imported as precedent.

So the switch opens cards only for tasks filed or untagged after it.

## Steps (in this order)

1. **Drain.** In the loop app, Nil decides (or the Curator withdraws) every
   open Triage card for an untagged P0-P3 task, and the Curator writes every
   decided one to the board, so no task has a card in both apps. A decided
   item that is not applied yet still has an untagged task, and Antifeed's
   first read would open a second card for it. Check: both
   `curl -s 127.0.0.1:21025/api/items?state=open` and
   `curl -s 127.0.0.1:21025/api/items?state=decided` list no triage
   proposals for untagged P0-P3 tasks.
2. **Loop app, one change (Q1 A).** At the switch, Isomux Curator sends the
   exact change below to Nil's Direct Helper, who makes it and restarts the
   loop app. The change is in
   ~/nil/isomux-loop, src/server.ts, the curator wake: the "open tasks" part
   (`const found = unclassified(all, cardIds());`, line 271 on 2026-10-25)
   goes behind one constant in src/config.ts, for example
   `const found = ANNOUNCE_UNTAGGED ? unclassified(all, cardIds()) : [];`
   with `ANNOUNCE_UNTAGGED = false`. The Backlog part of the wake stays.
   To revert, set the constant back to true (rollback step 2).
3. **App owner.** `PATCH /api/apps/antifeed {"createdByAgentId": "<Isomux
   Curator's id>"}`, by Antifeed Builder (Isomux PM said yes, 2026-10-25). The app token
   reads the board, lists agents and messages with `targetAgentId` only while
   its owner agent is live. In isomux (source at 0198e308, read 2026-10-25),
   "live" means the agent exists in the office (a killed agent is gone); an
   idle session still counts. The Curator is the loop's long-lived agent, and
   Antifeed Builder can be retired after the build, so the owner is the
   Curator.
   `messageTargetAgentId` is Isomux Consult since slice 4b (DESIGN.md 13.1:
   the office chat beside the app is the consult's). The registry moves the
   target with the owner only when the target was the old owner
   (app-registry.ts, the PATCH), so it should stay. After the PATCH, check
   `GET /api/apps/antifeed`: if `messageTargetAgentId` is not Isomux
   Consult, PATCH it back.
   The move also turns off Nil's Inbox access for the app (isomux task
   4a1e58c9: a new owner turns the switch off). So Nil turns Inbox access
   on again after this step, and not before (Apps page, the app's ⋯ menu,
   "Let it answer my asks"). Until he does, the Status tab says "Nil has
   not turned on Inbox access for this app"; his pages still come in.
   The app then messages its own owner (the Curator) with `targetAgentId`.
   Checked in the source only (0198e308): `apps.sendMessage` accepts any
   `targetAgentId` while the owner is live, and `enqueueMessage` has no
   refusal for a message to the owner (the sender is the app). No live test
   was run. The live check is in step 6: the first
   `/isomux-curator Antifeed: ...` message reaches the Curator, and the
   Status tab's dispatch timer shows no `POST /api/app/message answered
   4xx`. If it does, PATCH the owner back to Antifeed Builder (a live agent
   that is not the Curator), and tell Isomux PM.
4. **Curator skill**, by Antifeed Builder (Isomux PM, 2026-10-25), after
   the drain and before step 5, not earlier: the Curator would act on it.
   curator-skill-draft.md is the whole new
   ~/.claude/skills/isomux-curator/SKILL.md, merged from the skill whose
   sha256 starts 6963b78f (read 2026-10-25). The skills folder is not in
   git, so:
   - Check `sha256sum ~/.claude/skills/isomux-curator/SKILL.md` still
     starts 6963b78f. If not, the skill changed since the merge: merge the
     change into the draft first.
   - Keep the old file: `mkdir -p /tmp/af-switch && cp -p
     ~/.claude/skills/isomux-curator/SKILL.md /tmp/af-switch/SKILL.md.old`.
   - `cp projects/isomux/curator-skill-draft.md
     ~/.claude/skills/isomux-curator/SKILL.md`.
5. **Antifeed live.** In ~/nil/antifeed/src/config.ts, set `TRIAGE = true`
   (and `DEMO = false`, if the Inbox, slice 7, is not live yet), commit, then
   `POST /api/apps/antifeed/restart`. At start, the app:
   - loads projects/isomux in the data dir's `live/` folder, beside the Inbox
     when it is live there (the demo log stays in its `DEMO_DIR` folder),
   - imports the loop app's applied triage calls as precedent, once,
   - reads the board: the first read logs every open P0-P3 task as seen and
     opens cards only for the untagged ones.
6. **Watch the first hour.** Look at the Status tab (commands in flight,
   failures, claude -p spend) and the Curator's first packets. The check:
   each new untagged task gets a card with a packet and a Premove, and each
   call reaches the board as a tag. The Curator's first
   `/isomux-curator Antifeed: ...` message starts a turn that reads and
   starts the listed commands, not a loop app wake (the Curator's chat
   shows the start calls to 127.0.0.1:21042).

## The Inbox (slice 7) and this switch

If the Inbox goes live before this switch, Nil turns its Inbox access on
then, and again after step 3 (the owner move turns it off). If the Inbox
goes live with or after this switch, step 3 comes first and Nil turns it on
once, after step 3.

## Rollback

1. Before the restart, look at the Status tab for triage commands in
   flight. With `TRIAGE = false` the isomux policies do not load, so a triage.apply
   that waits in its 3-minute burst is never sent, and Nil's call is lost
   with no sign. Wait until none is in flight, or list the tasks of those
   still in flight, so that Nil decides them again in the loop app. Then set
   `TRIAGE = false` in src/config.ts (the Inbox stays live) and restart
   antifeed. The live log stays in `live/` for later; nothing is deleted.
2. Isomux Curator asks Nil's Direct Helper to set the constant back to true
   and restart the loop app. The curator wake announces untagged tasks again.
3. Put the old skill back: `cp /tmp/af-switch/SKILL.md.old
   ~/.claude/skills/isomux-curator/SKILL.md`. If /tmp was cleared,
   projects/isomux/curator-skill-before-switch.md (not in this public copy) is the same file
   (6963b78f).

The calls Nil made in Antifeed are already on the board as tags, so the loop
app sees those tasks as triaged.
