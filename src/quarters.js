// Quarters are integers: year * 4 + (quarter - 1), in UTC.
export function QUARTER_SQL(col) {
  return `(CAST(strftime('%Y', ${col}, 'unixepoch') AS INTEGER) * 4 + (CAST(strftime('%m', ${col}, 'unixepoch') AS INTEGER) - 1) / 3)`;
}

// The same quarter number as QUARTER_SQL, for a unix time in seconds.
export function quarterOf(seconds) {
  const d = new Date(seconds * 1000);
  return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3);
}

export function quarterLabel(q) {
  return `${Math.floor(q / 4)} Q${(q % 4) + 1}`;
}
