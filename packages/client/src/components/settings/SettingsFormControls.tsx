import { FilterDropdown, type FilterOption } from "../FilterDropdown";

const inputBaseClasses =
  "rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-[var(--text-primary)] [font-size:var(--font-size-sm)] outline-none transition-colors duration-150 placeholder:text-[var(--text-dimmed)] hover:border-[var(--border-color)] focus:border-[var(--focus-border)] disabled:cursor-not-allowed disabled:opacity-60";

interface SettingsTextInputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  className?: string;
}

export function SettingsTextInput({
  className = "",
  ...props
}: SettingsTextInputProps) {
  return (
    <input className={`${inputBaseClasses} ${className}`.trim()} {...props} />
  );
}

interface SettingsTextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  className?: string;
}

export function SettingsTextarea({
  className = "",
  ...props
}: SettingsTextareaProps) {
  return (
    <textarea
      className={`${inputBaseClasses} resize-y ${className}`.trim()}
      {...props}
    />
  );
}

interface SettingsSelectProps<T extends string> {
  label: string;
  options: FilterOption<T>[];
  selected: T[];
  onChange: (selected: T[]) => void;
  placeholder?: string;
  className?: string;
  align?: "left" | "right";
}

export function SettingsSelect<T extends string>({
  label,
  options,
  selected,
  onChange,
  placeholder,
  className = "",
  align = "right",
}: SettingsSelectProps<T>) {
  return (
    <div className={`min-w-[160px] max-w-full shrink-0 ${className}`.trim()}>
      <FilterDropdown
        label={label}
        options={options}
        selected={selected}
        onChange={onChange}
        multiSelect={false}
        align={align}
        placeholder={placeholder}
      />
    </div>
  );
}

interface SettingsSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function SettingsSwitch({
  checked,
  onChange,
  disabled = false,
  className = "",
  ariaLabel,
}: SettingsSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => {
        if (!disabled) {
          onChange(!checked);
        }
      }}
      className={`relative inline-block h-6 w-11 shrink-0 rounded-full border transition-all duration-200 ${
        checked
          ? "border-[var(--accent-color,#3b82f6)] bg-[var(--accent-color,#3b82f6)]"
          : "border-[var(--border-color)] bg-[var(--bg-hover)]"
      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${className}`.trim()}
    >
      <span
        className={`absolute bottom-[2px] left-[2px] h-[18px] w-[18px] rounded-full transition-all duration-200 ${
          checked
            ? "translate-x-5 bg-white"
            : "translate-x-0 bg-[var(--text-muted)]"
        }`}
      />
    </button>
  );
}
