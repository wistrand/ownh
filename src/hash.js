import { createHash } from 'node:crypto';

// One algorithm for both kinds of "line", so text lines and binary files share a
// single hash space.
//
// Text lines are hashed exactly as stored: no trimming, no whitespace folding,
// no decoding. `line` is a byte string: the raw bytes read with Node's 'latin1'
// encoding, which maps byte n to char n. Hashing it with 'latin1' maps each char
// back to its byte, so the digest is over the original bytes, whatever their
// real encoding (nothing is interpreted as Latin-1). A line that is not valid
// UTF-8 therefore keeps its own bytes and hash. A
// blank line is a line like any other, and "x\r" (from a CRLF file) is a
// different line from "x". Callers split on "\n" only; see lines() in git.js.
export function hashLine(line) {
  return createHash('sha256').update(line, 'latin1').digest('hex');
}

// A binary file is one line: the hash of its full content.
export function hashFile(content) {
  return createHash('sha256').update(content).digest('hex');
}
