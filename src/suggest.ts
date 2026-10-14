/** Closest name, for "did you mean …" on a field the model invented. */

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const row = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const cur = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = cur;
    }
  }
  return row[n];
}

export function suggest(input: string, options: readonly string[], aliases: Record<string, string> = {}): string | undefined {
  const alias = aliases[input] ?? aliases[input.toLowerCase()];
  if (alias && options.includes(alias)) return alias;
  let best: string | undefined;
  let bestD = 3;
  const norm = input.toLowerCase();
  for (const opt of options) {
    if (opt === input) continue;
    const d = levenshtein(norm, opt.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = opt;
    }
  }
  return best;
}
