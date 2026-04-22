interface Props {
  agents: string[];
  onAgentsChange: (agents: string[]) => void;
  onNext: () => void;
}

const AVAILABLE_AGENTS = [
  {
    id: "claude",
    name: "Claude Code",
    description: "Anthropic's AI coding agent",
  },
  {
    id: "codex",
    name: "Codex CLI",
    description: "OpenAI's coding agent",
  },
];

export function AgentSelectPage({ agents, onAgentsChange, onNext }: Props) {
  const toggle = (id: string) => {
    if (agents.includes(id)) {
      onAgentsChange(agents.filter((a) => a !== id));
    } else {
      onAgentsChange([...agents, id]);
    }
  };

  return (
    <div style={{ width: "100%", maxWidth: 400 }}>
      <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
        Choose your agents
      </h2>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: 14,
          marginBottom: 24,
        }}
      >
        Select which AI coding agents you want to use. You can change this
        later.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 32 }}>
        {AVAILABLE_AGENTS.map((agent) => (
          <label
            key={agent.id}
            className={`checkbox ${agents.includes(agent.id) ? "selected" : ""}`}
          >
            <input
              type="checkbox"
              checked={agents.includes(agent.id)}
              onChange={() => toggle(agent.id)}
            />
            <div>
              <div style={{ fontWeight: 500 }}>{agent.name}</div>
              <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                {agent.description}
              </div>
            </div>
          </label>
        ))}
      </div>

      <button
        className="btn-primary"
        onClick={onNext}
        disabled={agents.length === 0}
        style={{ width: "100%" }}
      >
        Continue
      </button>
    </div>
  );
}
