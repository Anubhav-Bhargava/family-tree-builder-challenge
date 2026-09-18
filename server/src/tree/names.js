/** "  José  DE la Cruz " → "jose de la cruz". Used for lookup and the duplicate check. */
export function nameKey(name) {
  return name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * How two name keys match, or null.
 *   exact   "john smith" = "john smith"
 *   partial "john" is the first name of "john smith"
 *   fuzzy   a one-letter typo on names of 4+ letters: "jon" / "john" (not "sam" / "pam")
 */
export function nameMatch(a, b) {
  if (a === b) return "exact";
  const firstA = a.split(" ")[0];
  const firstB = b.split(" ")[0];
  if ((a === firstB && !a.includes(" ")) || (b === firstA && !b.includes(" "))) return "partial";
  if (isTypo(a, b) || isTypo(firstA, firstB)) return "fuzzy";
  return null;
}

/** True when a and b (4+ letters) differ by one insertion, deletion or substitution. */
function isTypo(a, b) {
  if (a === b || Math.max(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++; // skip the common prefix
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1); // substitution
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1); // insertion/deletion
}
