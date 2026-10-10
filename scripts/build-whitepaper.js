#!/usr/bin/env node
// Builds docs/ownh-whitepaper.pdf from whitepaper/ownh-whitepaper.tex with
// pdflatex (run twice for references). Output is reproducible: the PDF dates
// come from SOURCE_DATE_EPOCH (default: EDITION, bump it with each edition) and the PDF ID
// is fixed. Needs a TeX installation with pdflatex.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const src = join(root, 'whitepaper', 'ownh-whitepaper.tex');
const out = join(root, 'docs', 'ownh-whitepaper.pdf');
const dir = mkdtempSync(join(tmpdir(), 'ownh-whitepaper-'));
const EDITION = '1790812800'; // 2026-10-01 UTC
const epoch = process.env.SOURCE_DATE_EPOCH ?? EDITION;
const env = { ...process.env, SOURCE_DATE_EPOCH: epoch, FORCE_SOURCE_DATE: '1' };
try {
  for (let pass = 0; pass < 2; pass++) {
    execFileSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', `-output-directory=${dir}`, src], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  }
  copyFileSync(join(dir, 'ownh-whitepaper.pdf'), out);
  console.log(`wrote ${out}`);
} catch (err) {
  // pdflatex prints the error to stdout; show the tail of its log.
  console.error(String(err.stdout ?? err.message).split('\n').slice(-25).join('\n'));
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
