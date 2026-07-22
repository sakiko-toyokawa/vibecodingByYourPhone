# Claude Code Remote Control vs Yep Anywhere

Anthropic just [announced Remote Control](https://x.com/noahzweben/status/2026371260805271615) — a new Claude Code feature that lets you continue terminal sessions from your phone. We're thrilled. This is exactly the workflow we've been building for, and having Anthropic validate it with a first-party feature is a good sign for the category.

If you like what Remote Control offers and want to take it further, [try Yep Anywhere](https://yepanywhere.com).

## What Remote Control does

Run `claude remote-control` or type `/rc` in an existing session. Claude Code opens an outbound connection to Anthropic's servers. Open the session URL or scan a QR code on your phone — in a browser or the Claude iOS/Android app — and you're connected.

You can also enable it globally via `/config` so every session is remotely accessible without opting in.

It's simple and well-designed. The session runs locally, your files stay on your machine, and the mobile interface lets you send messages and see responses.

## What Yep Anywhere adds

Remote Control is a remote chat window into a single CLI session. Yep Anywhere is a supervisor that manages multiple agent processes:

**Multi-session dashboard.** Remote Control supports one remote session per CLI instance. To monitor three projects, you need three terminals. Yep Anywhere shows all your sessions — across projects and providers — in a single dashboard. Star the ones you care about, archive the rest.

**Start new sessions from your phone.** Remote Control connects to sessions already running in a terminal. Yep Anywhere lets you create and launch new sessions on your dev machine from your phone.

**Server-owned processes.** Yep Anywhere's server manages agent processes — close your browser, close your laptop, the agents keep running. Reconnect whenever.

**Multiple providers.** Remote Control is Claude Code only. Yep Anywhere also supports Codex CLI in the same interface.

**Self-hosted and encrypted.** Remote Control routes through Anthropic's API servers. Yep Anywhere runs your own server with an optional relay — all messages are end-to-end encrypted with NaCl, so even the relay sees only ciphertext. Or skip the relay entirely and connect over Tailscale or LAN.

**Works with API keys too.** Remote Control requires a Pro or Max plan. Yep Anywhere works with Pro, Max, or API keys.

## Where Remote Control wins

**Zero setup.** If you already use Claude Code and have the Claude mobile app, it's one command. No server to install.

**Native app.** The Claude iOS/Android app is already on millions of phones.

**Anthropic-backed.** It'll keep improving and it'll always be compatible with the latest Claude Code features.

## Our take

We genuinely welcome this. The hardest part of building Yep Anywhere has been explaining why you'd want to supervise coding agents from your phone. Anthropic's own PM is now [making that case](https://x.com/noahzweben/status/2026371260805271615) — "take a walk, see the sun, walk your dog without losing your flow." That's our pitch, word for word.

Remote Control is a great starting point. If you try it and find yourself wanting multi-session oversight, push notifications, or always-on agent processes — that's what we built.

[Get started with Yep Anywhere](https://yepanywhere.com)
