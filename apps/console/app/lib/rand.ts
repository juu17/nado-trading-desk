// Fisher–Yates — an unbiased in-place shuffle of a copy. Shared by the cohort split (which wallet gets
// which role) and the per-round pairing (which maker faces which taker), so both stay uniform and there
// is one implementation to trust.
export function shuffle<T>(xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
