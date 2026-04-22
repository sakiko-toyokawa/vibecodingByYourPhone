# Related Ecosystem

Projects that aren't direct competitors but operate in adjacent or complementary spaces — agent orchestration, inter-agent communication, workflow automation, and multi-agent coordination infrastructure.

Where [competitive](../competitive/) tracks tools solving the same problem (agent supervision), this section tracks tools solving **different subsystems** that compose with or inform our work.

## Agent Coordination & Messaging

| Project | Stars | Language | What It Does |
|---------|-------|----------|-------------|
| [Subtrate](subtrate.md) | 7 | Go + React | Mail system + persistent identity + code review for Claude Code agents |
| [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | ~500 | Python | MCP-based inbox/outbox with file leases, Git+SQLite backed |
| [Agent Message Queue](https://github.com/avivsinai/agent-message-queue) | New | — | File-based Maildir-style agent-to-agent messaging, zero infrastructure |
| [ufoo](https://github.com/Icyoung/ufoo) | New | — | Event bus protocol — agents send tasks to each other and reply with results |

## Multi-Agent Orchestration (CLI-Agent-Native)

Tools that spawn and manage multiple CLI coding agents (Claude Code, Codex, Gemini CLI) on local hardware using subscription plans.

| Project | Stars | What It Does |
|---------|-------|-------------|
| [Composio Agent Orchestrator](https://github.com/ComposioHQ/agent-orchestrator) | ~1k+ | Plans tasks, spawns agents in worktrees, handles CI/merge/review |
| [agtx](https://github.com/fynnfluegge/agtx) | New | Terminal kanban — orchestrator delegates to parallel agents in tmux |
| [ccswarm](https://github.com/nwiizo/ccswarm) | New | Template-based task delegation with Claude Code CLI + worktree isolation |
| [AgentYard CLI](https://github.com/joshuaswarren/agentyard-cli) | New | Workflow orchestration with isolated git worktrees + tmux sessions |
| [Claude Octopus](https://github.com/nyldn/claude-octopus) | ~500+ | Parallel workstreams, routes to Claude/Codex/Gemini |

## Visual Workflow / DAG Platforms

General-purpose workflow platforms with AI agent capabilities. None natively support CLI agents (subscription-plan-based), but could be extended.

| Project | Stars | What It Does |
|---------|-------|-------------|
| [n8n](https://github.com/n8n-io/n8n) | ~130k | Visual DAG builder + scheduling + 400 integrations + native AI nodes |
| [Dify](https://github.com/langgenius/dify) | ~111k | Visual workflow canvas, multi-model, MCP support |
| [Langflow](https://github.com/langflow-ai/langflow) | ~60k+ | Visual LangChain flow builder |

## Agent Frameworks (Code-First)

| Project | Stars | What It Does |
|---------|-------|-------------|
| [LangGraph](https://github.com/langchain-ai/langgraph) | ~15k+ | Directed graph with explicit per-node state, LangSmith tracing |
| [CrewAI](https://github.com/crewAIInc/crewAI) | ~30k+ | Role-based agent crews + visual builder |
| [AutoGen](https://github.com/microsoft/autogen) | ~40k+ | Multi-agent conversation patterns |

## Funded Players

| Company | Funding | What It Does |
|---------|---------|-------------|
| [Emdash](https://github.com/generalaction/emdash) | YC W26 | Desktop app, parallel agents, any provider, local or SSH (also in [competitive](../competitive/emdash.md)) |
| Composio | Funded | Agent orchestrator + integrations platform |

## Curated Lists

- [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators) — Comprehensive list of orchestration tools
- [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) — Skills, hooks, orchestrators, plugins for Claude Code

## Last Updated

2026-03-17
