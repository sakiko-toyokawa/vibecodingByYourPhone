# Does Your AI Agent Have a Soul?

Peter Steinberger just [announced he's joining OpenAI](https://steipete.me/posts/2026/openclaw). OpenClaw — the project that turned a Mac Mini into a personal AI agent — will move to a foundation and stay open source. As someone building in the adjacent space, here's my perspective on where these tools overlap, diverge, and where this is all heading.

## What OpenClaw got right

**Soul.md.** A persistent identity across sessions — not just a system prompt. The agent writes daily journal entries, summarizes its own history, builds searchable memory over time. Less like using a tool, more like working with someone.

**The heartbeat system.** The agent sets its own timers, checks its own progress, adjusts priorities. One user had it decompile a video game incrementally over days, checking in on itself every 30 minutes. What's possible when you stop treating agents as request-response tools.

**Skills.** Web browser, messaging integrations, custom tools — the plugin architecture lets OpenClaw grow capabilities without the core project anticipating every use case.

## Where Yep Anywhere comes from

I built Yep Anywhere to solve a simpler problem: supervise my coding agents from my phone.

The core idea is server-owned processes. Claude runs on your dev machine. You aren't tied to your desk — walk away, come back, the agent is still working. Push notification when it needs approval, tap approve from your lock screen, it keeps going. Works best for tasks you don't need to manually verify on the desktop.

But it's grown beyond that. I run Yep Anywhere on all my machines — desktop, laptop, Pi. The encrypted relay means I can switch between hosts from a menu. It's like ssh without ssh. Kick off a task on my desktop from my phone while I'm on the couch, check on my Pi's build from the same app. When I go out I can continue to brainstorm, execute refactorings, manage multiple agents across multiple projects, deploy fixes, act on PRs, push releases.

For coding tasks, I mostly run in YOLO mode. Once I approve a plan or the task is well-scoped within a repo, I don't need to see every edit. For interesting debugging, I watch and steer. The point is having the *choice* — from my phone, at any moment.

I also use Yep Anywhere exclusively from my desktop, because the interface is more than enough. When I need to review code in depth, I bring up my IDE in another window. But most of the time I'm expanding a file to view the full diff context, never leaving the browser.

## Three layers of agent trust

There's a spectrum:

**Watched.** You see every tool call and approve each one. The default Claude Code terminal experience. Safe, but slow. For when your agent is helping you (god forbid) debug a production DB.

**Scoped.** You approve a plan, then let the agent run in YOLO mode within a repo. Everything goes through git — you can review diffs, revert anything. The firewall isn't capability restrictions, it's version control. This is how I use Yep Anywhere day-to-day.

**Free-roaming.** Soul.md, cron jobs, full system access, messaging integrations. The agent operates autonomously on dedicated hardware. You treat its outputs as untrusted by default — assume any binary it produces could be compromised, review before deploying. OpenClaw's sweet spot.

These aren't competing philosophies. They're different trust levels for different situations. *Watched* for a tricky race condition on your main machine, *scoped* for a well-defined feature, *free-roaming* on a Mac Mini chipping away at a refactor overnight.

## The long tail of tasks

Where OpenClaw really shines is the long tail — tasks too tedious for a human to do consistently but too nuanced for dumb automation.

Example: I'd love an agent that monitors r/claudeai and flags threads where mentioning Yep Anywhere would be genuinely helpful (not spam — actually relevant conversations). It would draft responses, I'd review and adjust from my phone, then post. I do this manually when time permits, but an agent with cron and a real browser could do it continuously.

The list is endless: monitor competitor releases, watch GitHub issues on adjacent projects, draft changelog entries from recent commits, keep a competitive analysis doc updated. Each one isn't worth building a dedicated tool for. But an agent with a schedule, a browser, and a drafts inbox handles all of them.

The pattern is simple: agent does background work, produces drafts, pushes a notification ("3 new opportunities to review"), you review on your phone. The supervised workflow applied to non-coding tasks — the agent does the heavy lifting, you're the editor.

## What we may experiment with

Some ideas from OpenClaw's playbook we're considering for Yep Anywhere:

**Global identity (soul.md).** A persistent file at `~/.yep/soul.md` injected into every session. The agent builds up context about you over time — preferences, conventions, deployment targets. Opt-in, reviewable, yours. Off by default to avoid cross-project contamination.

**Scheduled tasks.** Cron-like capabilities — schedule a prompt to run at a specific time. Not "agent runs unsupervised forever" but "run the test suite nightly and push-notify me if anything breaks."

**Skills.** Register tools globally or per-project — not a marketplace (that's where OpenClaw's security problems came from), but a simple config: "here's a shell command the agent can use." Personal skills, project skills, checked-in skills. Different scopes for different needs.

## The security question

The [HN thread](https://news.ycombinator.com/item?id=47028013) about Peter's announcement is dominated by security concerns.

Yep Anywhere's answer is layered: E2E encrypted relay (NaCl, XSalsa20-Poly1305), SRP authentication that never exposes your password to the relay server, minimal external dependencies, and human-in-the-loop approval when you want it. The relay server sees only opaque ciphertext. No skill marketplace to be poisoned.

## Not a competition

OpenClaw is pushing the frontier of what autonomous agents can do — the weird, dangerous, exciting edges. Yep Anywhere is making it practical and safe to supervise agents in your daily workflow.

The future is probably both: a free-roaming agent on dedicated hardware for open-ended tasks, supervised through a secure, mobile-first control plane. An agent that knows you, can act on a schedule, has real capabilities, runs across all your machines — and that you can always see, steer, and stop from your phone.

I'd love to eventually build a mode that lets the agent free-roam in YOLO, non-interactive. But I want to get there slowly — starting on a VM, carefully watching its outputs, and building trust incrementally.
