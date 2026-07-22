interface SettingsRowProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
}

export function SettingsRow({
  title,
  description,
  children,
}: SettingsRowProps) {
  return (
    <div className="flex flex-col gap-1 py-5 border-b border-[var(--border-subtle)]">
      <div className="flex items-center justify-between gap-4">
        <strong className="flex items-center leading-6">{title}</strong>
        <div className="shrink-0">{children}</div>
      </div>
      {description && <p>{description}</p>}
    </div>
  );
}
