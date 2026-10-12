// Line entropy per owner, cached as a stats stage (see stagecache.js): how
// varied the lines an owner holds at HEAD are. The Shannon entropy, in bits,
// of the owner's lines over the distinct lines (hashes) they own: 0 when every
// line is a copy of one line, log2(lines) when no two are the same. Someone
// who owns thousands of blank lines and braces has low line entropy.
//
// Counted per hash (index-only on head_lines_hash), in 16 ranges by the first
// hex digit for progress, then summed per owner from
//   H = log2(N) - (sum of n log2 n) / N
// so no per-owner list of hashes is kept. Returns { [identityId]: { lines,
// distinct, bits } }; unowned lines are left out.
export function lineEntropy(db, log = () => {}) {
  const started = Date.now();
  const perHash = db.prepare(`
    SELECT c.identity_id AS id, x.n AS n
    FROM (SELECT hash, COUNT(*) AS n FROM head_lines WHERE hash >= ? AND (? IS NULL OR hash < ?) GROUP BY hash) x
    LEFT JOIN line_hashes l ON l.hash = x.hash
    LEFT JOIN commits c ON c.id = l.commit_id
  `);
  const acc = new Map(); // id -> { lines, distinct, nlogn }
  const digits = '0123456789abcdef';
  for (let d = 0; d < digits.length; d++) {
    const to = d + 1 < digits.length ? digits[d + 1] : null;
    for (const { id, n } of perHash.iterate(digits[d], to, to)) {
      if (id === null) continue;
      let a = acc.get(id);
      if (!a) acc.set(id, (a = { lines: 0, distinct: 0, nlogn: 0 }));
      a.lines += n;
      a.distinct += 1;
      a.nlogn += n * Math.log2(n);
    }
    log(`line entropy: ${d + 1}/${digits.length} hash ranges, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  const out = {};
  for (const [id, a] of acc) {
    // Rounding can leave a tiny negative for a single distinct line.
    out[id] = { lines: a.lines, distinct: a.distinct, bits: Math.max(0, Math.log2(a.lines) - a.nlogn / a.lines) };
  }
  return out;
}
