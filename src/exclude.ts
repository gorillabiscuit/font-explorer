/**
 * Families left out of the catalog everywhere (web and installed): Noto is Google's coverage
 * superfamily for other writing systems, Playwrite is a set of school handwriting models.
 * Neither is useful for a Latin wordmark, and together they were ~250 entries of clutter.
 */
const EXCLUDED = /^(Noto|Playwrite)\b/i;

export function isExcludedFamily(family: string): boolean {
  return EXCLUDED.test(family.trim());
}
