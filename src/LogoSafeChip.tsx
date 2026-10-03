// The 'Logo-safe licence' filter chip, mounted in the filter row through slots.tsx. The rule itself
// is one clause in store.ts passes(), using coverage.ts isLogoSafe.
import { useMemo } from "react";
import { isLogoSafe, LOGO_SAFE_LICENCES } from "./coverage";
import { useStore } from "./store";

export function LogoSafeChip() {
  const { filters, setFilters, all } = useStore();
  const count = useMemo(() => all.filter(isLogoSafe).length, [all]);
  return (
    <button
      className={`chip ${filters.logoSafe ? "on" : ""}`}
      title={`Only fonts licensed ${LOGO_SAFE_LICENCES.join(", ")}: free to use in a logo. Hides installed fonts and every other licence.`}
      onClick={() => setFilters((f) => ({ ...f, logoSafe: !f.logoSafe }))}
    >
      Logo-safe licence <span className="faint">{count}</span>
    </button>
  );
}
