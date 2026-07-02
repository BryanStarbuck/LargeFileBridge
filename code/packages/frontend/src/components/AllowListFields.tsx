// The two-section allow-list form (security.mdx §4.2/§4.3): "Allow anyone from these companies"
// (Google Workspace domains, @-prefixed rows) and "Individual Google accounts" (exact emails, plain
// rows). Reused by the first-run SecuritySetupPage and the admin Settings → Access editor (§10), so
// the two surfaces can never drift. Fully controlled — parent owns the value + validity.
import { Plus, Minus } from "lucide-react";

export interface AllowListValue {
  allowCompanies: boolean;
  domains: string[];
  allowIndividuals: boolean;
  emails: string[];
}

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Trim, drop blanks; domains also strip a leading @ and lowercase. */
export function cleanDomains(rows: string[]): string[] {
  return rows.map((d) => d.trim().replace(/^@+/, "").toLowerCase()).filter(Boolean);
}
export function cleanEmails(rows: string[]): string[] {
  return rows.map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/** At least one enabled section with ≥1 valid entry (security.mdx §4.4 / §8.2). */
export function isAllowListValid(v: AllowListValue): boolean {
  const okCompanies =
    v.allowCompanies && cleanDomains(v.domains).some((d) => DOMAIN_RE.test(d));
  const okIndividuals =
    v.allowIndividuals && cleanEmails(v.emails).some((e) => EMAIL_RE.test(e));
  return Boolean(okCompanies || okIndividuals);
}

function Rows({
  rows,
  prefix,
  placeholder,
  disabled,
  addLabel,
  onChange,
}: {
  rows: string[];
  prefix?: string;
  placeholder: string;
  disabled: boolean;
  addLabel: string;
  onChange: (rows: string[]) => void;
}) {
  const list = rows.length ? rows : [""];
  const set = (i: number, val: string) => {
    const next = [...list];
    next[i] = val;
    onChange(next);
  };
  const remove = (i: number) => {
    const next = list.filter((_, j) => j !== i);
    onChange(next.length ? next : [""]);
  };
  return (
    <div className={disabled ? "pointer-events-none opacity-40" : ""}>
      {list.map((row, i) => (
        <div key={i} className="mb-2 flex items-center gap-2">
          {prefix && <span className="select-none font-mono text-black/40">{prefix}</span>}
          <input
            value={row}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(e) => set(i, e.target.value)}
            className="w-72 rounded border border-[var(--lfb-border)] px-2 py-1.5 font-mono text-sm"
          />
          {list.length > 1 && (
            <button
              type="button"
              aria-label="Remove row"
              onClick={() => remove(i)}
              className="rounded p-1 text-black/40 hover:bg-black/5 hover:text-black"
            >
              <Minus className="h-4 w-4" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange([...list, ""])}
        className="mt-1 inline-flex items-center gap-1 text-sm text-[var(--lfb-primary)]"
      >
        <Plus className="h-4 w-4" /> {addLabel}
      </button>
    </div>
  );
}

export function AllowListFields({
  value,
  onChange,
}: {
  value: AllowListValue;
  onChange: (v: AllowListValue) => void;
}) {
  return (
    <div className="space-y-4">
      {/* Section 1 — companies */}
      <div className="rounded-lg border border-[var(--lfb-border)] p-4">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={value.allowCompanies}
            onChange={(e) => onChange({ ...value, allowCompanies: e.target.checked })}
            className="mt-1"
          />
          <span>
            <span className="font-semibold">Allow anyone from these companies</span>
            <span className="block text-sm text-black/60">
              Anyone with a Google account on this domain gets in.
            </span>
          </span>
        </label>
        <div className="mt-3 pl-6">
          <Rows
            rows={value.domains}
            prefix="@"
            placeholder="mycompany.com"
            disabled={!value.allowCompanies}
            addLabel="Add another company"
            onChange={(domains) => onChange({ ...value, domains })}
          />
        </div>
      </div>

      {/* Section 2 — individuals */}
      <div className="rounded-lg border border-[var(--lfb-border)] p-4">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={value.allowIndividuals}
            onChange={(e) => onChange({ ...value, allowIndividuals: e.target.checked })}
            className="mt-1"
          />
          <span>
            <span className="font-semibold">Individual Google accounts</span>
            <span className="block text-sm text-black/60">
              Only these exact accounts get in — nothing else.
            </span>
          </span>
        </label>
        <div className="mt-3 pl-6">
          <Rows
            rows={value.emails}
            placeholder="joesmith@gmail.com"
            disabled={!value.allowIndividuals}
            addLabel="Add another account"
            onChange={(emails) => onChange({ ...value, emails })}
          />
        </div>
      </div>
    </div>
  );
}
