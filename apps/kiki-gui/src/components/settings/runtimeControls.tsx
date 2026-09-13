import { INPUT } from '../ui';

/** Numeric text field shared by the engine-config cards split off the runtime leaf. */
export function NumberField({ label, value, onChange, placeholder }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="text-[11px] font-medium text-ink-soft">
      {label}
      <input
        className={`${INPUT} mt-1 font-mono`}
        inputMode="numeric"
        value={value}
        placeholder={placeholder}
        onChange={(event) => { onChange(event.target.value); }}
      />
    </label>
  );
}

/** One settings cluster: a quiet heading plus a one-line "what it affects". */
export function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t border-hairline pt-3 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-[12px] font-semibold text-ink">{title}</h3>
        {hint !== undefined ? <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}
