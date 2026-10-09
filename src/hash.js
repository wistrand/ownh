import { createHash } from 'node:crypto';

// One algorithm for both kinds of "line", so text lines and binary files share a
// single hash space.
//
// Text lines are hashed exactly as stored: no trimming, no whitespace folding. A
// blank line is a line like any other, and "x\r" (from a CRLF file) is a different
// line from "x". Callers split on "\n" only; see lines() in git.js.
export function hashLine(line) {
  return createHash('sha256').update(line).digest('hex');
}

// A binary file is one line: the hash of its full content.
export function hashFile(content) {
  return createHash('sha256').update(content).digest('hex');
}
