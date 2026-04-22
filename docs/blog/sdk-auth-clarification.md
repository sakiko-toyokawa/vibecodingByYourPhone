# The Agent SDK Auth Scare (and Why You're Fine)

On February 19, 2026, Anthropic updated their [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) docs for Claude Code. Within hours, Hacker News had 160+ comments, X was on fire, and people were asking whether using the Agent SDK with a Max subscription was about to get them banned.

Here's what actually happened, what the docs actually say, and what it means for Yep Anywhere users.

## What the docs say

The updated page has two relevant sections, back to back:

**Usage policy:**
> "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code **and the Agent SDK**."

**Authentication and credential use:**
> "OAuth authentication (used with Free, Pro, and Max plans) is intended exclusively for Claude Code and Claude.ai. Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — **including the Agent SDK** — is not permitted."

Read those paragraphs in order. The first says your subscription covers the Agent SDK. The next says using your subscription's OAuth tokens with the Agent SDK is not permitted. The community's reaction was understandable.

## The clarification

Thariq, a product leader on Claude Code at Anthropic, [posted on X](https://x.com/trq212/status/2024212378402095389) within hours:

> "Apologies, this was a docs clean up we rolled out that's caused some confusion. Nothing is changing about how you can use the Agent SDK and MAX subscriptions!"

Multiple HN commenters noted that a tweet doesn't override written ToS. They're right — Anthropic should fix the docs. But the intent is clear: **individual use of the Agent SDK with your subscription is fine. The restriction targets third-party developers routing other people's subscription credentials through their services.**

## What this means for Yep Anywhere

Yep Anywhere falls squarely under individual use:

- **You run it on your own machine**, for yourself
- **You authenticate via your own Claude CLI** — we don't handle, intercept, or proxy OAuth tokens
- **We use the official Agent SDK** (`@anthropic-ai/claude-agent-sdk`) without modification
- **We don't spoof client identity** or manipulate headers
- **We're not a third-party service** routing your credentials — we're a local interface to your own Claude Code sessions

We covered this in detail in our [January compliance post](/tos-compliance.html) when the earlier wave of third-party tools got blocked. The core facts haven't changed.

## The bigger picture

The [HN thread](https://news.ycombinator.com/item?id=47069299) is worth reading. The community frustration isn't really about Yep Anywhere or any specific tool — it's about contradictory docs creating uncertainty for developers who want to build on Claude's platform.

The tools that got blocked (OpenCode, Crush, etc.) were spoofing client identity to freeload on subscription pricing. That's clearly different from an individual using the official SDK for personal tooling. But when the written terms don't distinguish between the two, everyone gets nervous.

We'll update this post if Anthropic clarifies their docs further. In the meantime: you're fine. Use the Agent SDK with your subscription. Build things. Anthropic wants you to — that's why the SDK exists.
