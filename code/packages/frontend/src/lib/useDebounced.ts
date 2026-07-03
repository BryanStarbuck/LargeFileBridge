// Debounce a fast-changing value (search/filter inputs) so downstream work — filtering a 5000-row
// dataset and re-rendering the table — runs once per pause instead of once per keystroke
// (performance.mdx P-05). The input stays fully controlled; only the *derived* value trails.
import { useEffect, useState } from "react";

export function useDebounced<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
