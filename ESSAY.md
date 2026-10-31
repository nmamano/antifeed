# The future of agents and loop engineering

Nil's essay, shared with Isomux PM on 2026-10-25 (verbatim).

---

I took some time to write down my most forward-thinking ideas.

Some people today are automating the SDLC (Software Development Life Cycle) and merging hundreds of PRs a day.

But, you know Goodhart's law: "when a measure becomes a target, it ceases to be a good measure"

The easy PRs to push through are not the valuable ones. And agents always find something to polish. Each feature PR generates 0.9 clean-up PRs. And each clean-up PR generates 0.5 more.

I propose a metric: eDPM

effective Decisions Per Minute

Where "effective decision" is defined as a choice that agents can't safely predict for you and which has some downstream effect (ultimately on the real world).

eDPM is the thing to optimize for.

Think of a classic event-driven architecture.

The EDA framework:

Events
Decisions
Actions

Events are the inputs, actions are the outputs

We can channel all events into a single Decision Node, and make all actions flow out of it.

Humans will sit at the Decision Node throughout their entire work time, making decisions that need them.

Every decision comes with a Premove (an agent that predicts and prefills your call) based on Precedent (your calls on prior similar situations).

Some reversible decisions are taken automatically by an agent.

---

- What about the actions?

People emphasize the actions (like merging a PR), but once the necessary decisions are made, actions are just process to automate. 90% of actions agents can already do; 9% are "meat proxy" actions you wish they could (2FA, sudo, payments, captcha, etc.). The remaining 1% are things you actually want to do, like writing something for someone whose time you respect enough to do it by hand.

---

- What about our beloved agents?

Today, people talk to agents a lot. But think about what you are really doing when you talk to agents. You are digging through walls of text to fish out only 2 things: decisions you need to make, and actions you need to take.

Agents (harnesses, meta-harnesses, isomux, agent orchestration, agent swarms, all that) are the how. They are low-level implementation details. The EDA framework is a layer of abstraction above. Agents bring decisions to you or take actions for you. They are mechanisms. Agent swarms may go away tomorrow; the implementation changes, but the framework stays.

We won't chat with agents anymore except where chatting with an agent is necessary to make a decision.

---

- What's new about all this?

EDA is textbook stuff, but my angle here is optimizing for eDPM. Some ideas:

1. Optimizing for Ease of Decision with flexible Decision Packets

Let me give you the PR example.

- Bad: you go to GitHub, look at the PR, decide, and give your agent a go ahead.
- Ok: your agents bring PRs to your own loop engineering app where you make all your decisions
- Good: your agents bring PRs to your loop app and predict your decision, you just press enter
- Very good: your agents build the PR in a worktree, and show you a decision packet with before/after screenshots and videos, as well as a list of things they think you should know, and an independent agent predicts your call

The idea of decision packet is central. Every decision brought to you must be optimized for ease of choice, and the decision packet format must be very flexible to let the agent optimize for that. It could contain

- a smart diff,
- screenshots,
- a working demo,
- a forecast,
- a chart,
- etc.

Every decision packet comes with an adversarial recommendation, confidence score, copy edit suggestions to match your voice, etc. Picture a mama bird chewing the food for her baby.

One pattern: the decision packet contains a few alternatives. If one is what you want, you choose it. Otherwise, you choose the closest one, and wait for the decision to come back with a few more options that are variations of that one. So you can iteratively get closer to what you want without having to type anything.

Of course none of this is hard-coded; you constantly vibe-refine every aspect of the system.

2. The black hole effect.

Basically you start maybe with a single workflow, like pushing PRs for one project.

But you don't want to manage a loop app for each project, so you add all your projects as inputs (Events) to your Decision Node. And then you realize, why am I making decisions outside this thing, if it has the best eDPM. So it progressively eats all event sources in your life. Your email. Your bills. Your online shopping. Your group chats. Your whole life falls into the Decision Node, like a black hole gobbling everything up.

3. The single Decision Node architecture.

Most people doing loop engineering have various human gates along the SDLC. Maybe there's triage at the top and sign-off at the end.

There's no point for you the human to be jumping between different queues. It's all decisions at the end of the day. Bring them all to a single queue, so that the system can scale to unlimited events and actions.

---

- What are the problems with this framework?

There are some quirks I'm still trying to work out:

1. Decision fatigue. We don't enjoy doing a single thing all day.
2. It's hard to stomach how reductive the human's role is. It's like Bryan Johnson eating whatever the Health Algorithm says. Agents feel empowering. eDPM makes you feel like a metric.

---

- What's the end game?

eDPM is still short-term thinking. The end game is turning the Decision Node into the Anti Feed. A feed is designed to scroll endlessly. We want the opposite.

Effort/thinking shifts towards:

- integrating more events (so all your decisions are routed to the Decision Node)
- predicting decisions better (RL on your past decisions)
- automating more actions (browser use, computer use)

Once everything is integrated into the Decision Node, all decisions are predicted correctly, and all actions are automated, labor ends for good.
