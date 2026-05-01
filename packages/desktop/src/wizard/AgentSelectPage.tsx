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
  {
    id: "gemini",
    name: "Gemini CLI",
    description: "Google's AI coding agent",
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
    <div className="w-full max-w-[400px]">
      <h2 className="mb-2 text-[22px] font-semibold">Choose your agents</h2>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">
        Select which AI coding agents you want to use. You can change this
        later.
      </p>

      <div className="mb-8 flex flex-col gap-3">
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
              <div className="font-medium">{agent.name}</div>
              <div className="text-[13px] text-[var(--text-secondary)]">
                {agent.description}
              </div>
            </div>
          </label>
        ))}
      </div>

      <button
        className="btn-primary w-full"
        onClick={onNext}
        disabled={agents.length === 0}
      >
        Continue
      </button>
    </div>
  );
}
