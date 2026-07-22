# Google Is Banning Paying Subscribers for Using OpenClaw

Google just [permanently banned](https://discuss.ai.google.dev/t/account-restricted-without-warning-google-ai-ultra-oauth-via-openclaw/122778) hundreds of Google AI Pro ($20/mo) and Ultra ($249/mo) subscribers for using OpenClaw. No warning. No appeal path. While still charging them.

This is the same pattern we've been writing about since January. Here's what happened, why it matters, and why Yep Anywhere users aren't affected.

## What happened

OpenClaw added support for Google's Antigravity backend — the infrastructure powering Google's first-party AI products. Users authenticated OpenClaw with their Google account via OAuth, and the tool routed coding-agent requests through Antigravity's subsidized API.

Google detected this and applied zero-tolerance bans. A Google employee [confirmed on X](https://x.com/_mohansolo/status/2025766889205739899):

> "We've been seeing a massive increase in malicious usage of the Antigravity backend that has tremendously degraded the quality of service for our users. We needed to find a path to quickly shut off access to these users that are not using the product as intended."

The [Antigravity Terms of Service (Section 6)](https://antigravity.google/terms) explicitly prohibits "using the Service in connection with products not provided by us." OpenClaw's plugin was literally called `google-antigravity-auth`. The [Hacker News thread](https://news.ycombinator.com/item?id=47115805) has 478 comments and counting.

## The real problem: economics, not ethics

The technical argument for the ban is straightforward. Google aggressively caches prompts for its own first-party clients — prompt caching is how they make $20/mo subscriptions viable. Third-party tools break those cache hit rates. As one [HN commenter put it](https://news.ycombinator.com/item?id=47115805):

> "Third-party tools break those cache hit rates, potentially increasing serving costs 5-10x per request. That's a legitimate economic concern."

The buffet analogy from the thread is apt: you paid for all-you-can-eat, but you brought your own takeaway boxes. The restaurant has every right to kick you out. What they don't have the right to do is keep charging you after they've locked the doors.

## The enforcement is indefensible

Most of the internet agrees: the ban itself is within Google's rights, but the execution is a disaster.

- **Zero-tolerance permanent bans** on paying subscribers with no warning
- **No graduated response** — no email, no "stop doing this or else," just account gone
- **Still charging $249/month** on bricked accounts
- **False positives** — people who never used OpenClaw getting banned
- **Kafkaesque support** — departments bouncing users between each other with no escalation path

One commenter called it "the worst customer experience I've ever seen for a trillion-dollar company." Others noted that a simple "we noticed you're using a third-party tool — please stop or switch to API access" email would have been trivially easy and infinitely more humane.

## A pattern, not an incident

This isn't new. We've been tracking this exact pattern:

- **January 2026:** Anthropic [blocks third-party tools](https://news.ycombinator.com/item?id=46549823) that spoof Claude Code's client identity. We wrote about [how YA differs from those tools](/tos-compliance.html).
- **February 2026:** Anthropic [updates legal docs](/sdk-auth-clarification.html), causing confusion about Agent SDK usage. Clarified within hours — individual use is fine.
- **February 2026:** Google bans Antigravity/OpenClaw users. No clarification, no reversal, no functioning support.

The direction is clear: **every major AI provider will eventually crack down on tools that extract subsidized OAuth tokens to power unauthorized backends.** The only question is how they handle it. Anthropic communicated. Google nuked.

## Where Yep Anywhere stands

Yep Anywhere only uses official CLIs. We spawn `claude` (via the Agent SDK), `codex`, and `gemini` — the same binaries the providers ship and support. The CLI handles its own authentication, its own API calls, its own billing. We provide a UI on top.

This is fundamentally different from what got people banned. OpenClaw extracted OAuth tokens from consumer subscriptions and routed them through its own agent harness to hit subsidized backends. We never touch tokens. We never hit a provider API. We never impersonate a first-party client.

There's nothing for a provider to object to, because from their perspective, you're just using their CLI.

## A note on Gemini CLI

We have experimental support for launching Gemini CLI sessions via `--experimental-acp`, and we can read existing Gemini CLI session history from disk. But honestly, Gemini CLI is rough compared to Claude Code and Codex. The session storage lives in `~/.gemini/tmp/` with hashed paths — it feels like an internal format that wasn't designed for external consumption. Write operations through ACP are unreliable. [AionUI](https://github.com/iOfficeAI/AionUi), another multi-agent wrapper, tried to integrate Gemini CLI and ultimately gave up — they ended up calling the `@google/genai` API directly instead, bypassing the CLI entirely.

We hope Google invests more in Gemini CLI. A robust official CLI is the right answer to this whole mess — it's how you give developers programmatic access without them resorting to OAuth extraction from consumer products. Claude Code and Codex got this right. Gemini CLI isn't there yet.

Notably, Gemini CLI sessions (`~/.gemini/tmp/`) and Antigravity sessions (`~/.gemini/antigravity/`, Protocol Buffers) are completely separate systems. We interact with the former. We have zero interaction with the latter.

## The right approach for developer tools

If you're building tools on top of AI providers, there are really only two sustainable paths:

**Use official CLIs and SDKs.** The provider ships a tool. You use it. Authentication, billing, and rate limits are the provider's problem. Your tool works today and keeps working when policies change, because you were never exploiting anything. This is what Yep Anywhere does.

**Use the API with your own key.** Pay per-token at the published rate. More expensive than consumer subscriptions, but it's the sanctioned programmatic access path.

What doesn't work — what has now gotten users banned by both Anthropic and Google — is extracting OAuth tokens from subsidized consumer subscriptions and routing them through unauthorized third-party tools. The economics don't support it, the ToS prohibit it, and the providers are enforcing it.

There's a reason providers ship their own CLI harnesses. The harness controls prompt caching, telemetry, and context management — it's how they make flat-rate subscriptions economically viable. When a third-party tool bypasses the harness and hits the backend directly with extracted tokens, it breaks the caching assumptions the provider's pricing depends on. That's not a gray area. That's why the bans are happening.

## References

- [HN: Google restricting AI Pro/Ultra subscribers for using OpenClaw](https://news.ycombinator.com/item?id=47115805) (576 points, 478 comments)
- [Google AI Forum: Account restricted without warning](https://discuss.ai.google.dev/t/account-restricted-without-warning-google-ai-ultra-oauth-via-openclaw/122778)
- [Google AI Forum: Antigravity ToS Section 6 reminder](https://discuss.ai.google.dev/t/important-reminder-antigravity-terms-of-service-section-6-recent-gemini-access-suspensions/125193)
- [Antigravity Terms of Service](https://antigravity.google/terms)
- [Our Jan 2026 post: How we use the Claude SDK](/tos-compliance.html)
- [Our Feb 2026 post: The Agent SDK auth scare](/sdk-auth-clarification.html)
