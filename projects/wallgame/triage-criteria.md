# How Nil triages Wall Game tasks

From the Wall Game board and the Wall Game room's memory (read 2026-10-26).
There are no past calls of his on Wall Game cards yet; once there are, they
count more than these lines.

A card is one open task on the Wall Game board with no assignee and no call
line of his. His call is one choice:

- go: Wall Game PM does it, in priority order. It takes a priority, P0 to P3.
  go allows the work up to a deploy, push, prod write or bot restart. Those
  still need his word in an ask, every time.
- design: he wants a design packet first. It takes a priority.
- hold: nobody touches it for now. It takes a priority.
- backlog: P4; no agent picks it. No priority.
- obsolete: close it; it is done already, no current goal needs it, or the
  ground moved under it. No priority. Obsolete is reversible, so his bar for
  it is low.

What the room's memory says matters to him:

- Production: Wall Game runs on the VPS since 2026-10-05. Fly is stopped and
  its database is an old rollback copy, so a task that assumes Fly or that
  database may be obsolete or need a rewrite.
- The bots: a bot that resigns or forfeits in live games hurts players, and
  a bot-client restart drops every game in flight.
- Videos: on 2026-10-26 he gave Wall Game PM the token budget for the best
  Wall Game videos, and told it to be self-directed. Video approvals and
  A/B choices are asks, not triage.
- Variants are pawn rules (Standard, Classic, Animal Cycle); Random Start and
  custom setups are starting positions under those rules.

Priority is P0 (now) to P3 (some day). A bug he found himself in a path that
new players use tends to rank above polish. Many P3 tasks are site and SEO
checklist items. The reason for a priority is often his current goals, which
the task does not say: say so in "against" when the priority depends on them.

The task's own text is the author's view, not his call. Predict his call from
the task and his past calls.
