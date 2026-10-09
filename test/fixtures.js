// Builds two small repos with scripted history so each OWNH rule has a known
// expected owner. Author dates are fixed; see expectations in index.test.js.
//
//   alpha
//     t=1000 alice@old  a.js "function a() {" / "  return 1;" / "}"  + .mailmap (old -> new email)
//     t=2000 bob        b.js "function b() {" / "" / "    return 2;" / "    }"
//     t=3000 carol      formatter: b.js reindented to two spaces
//     t=4000 dave       a.js "return 1;" -> "return 42;"
//     t=5000 erin       revert of dave's change
//     t=6000 alice@old  a.js appends "const shared = true;"
//     t=7000 heidi      a.js appends "tie();"
//     t=9500 leo        logo.png (same bytes as beta's), data.txt marked binary by .gitattributes
//   beta
//     t=500  grace      shared.js "const shared = true;"
//     t=1500 frank      copy.js: a copy of a.js plus "" / "// beta only"
//     t=7000 ivan       shared.js appends "tie();"
//     t=8000 judy       win.js: a.js's first and last line plus a blank, with CRLF endings
//     t=9000 kate       logo.png (binary: contains NUL)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function commit(repo, [name, email], time, files) {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  // Git rejects tiny epoch values as dates; the offset keeps relative order.
  const date = `${BASE_TIME + time} +0000`;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: date,
  };
  // autocrlf off so win.js keeps its CRLF endings whatever the user's git config says.
  execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', 'add', '-A'], { env });
  execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `t=${time}`], { env });
}

export function init(dir, name) {
  const repo = join(dir, name);
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  return repo;
}

const ALICE_OLD = ['Alice', 'alice@old.example.com'];
const BOB = ['Bob', 'bob@example.com'];
const CAROL = ['Carol', 'carol@example.com'];
const DAVE = ['Dave', 'dave@example.com'];
const ERIN = ['Erin', 'erin@example.com'];
const FRANK = ['Frank', 'frank@example.com'];
const GRACE = ['Grace', 'grace@example.com'];
const HEIDI = ['Heidi', 'heidi@example.com'];
const IVAN = ['Ivan', 'ivan@example.com'];
const JUDY = ['Judy', 'judy@example.com'];
const KATE = ['Kate', 'kate@example.com'];
const LEO = ['Leo', 'leo@example.com'];

const BASE_TIME = 1_700_000_000;
const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x0a, 0xff]);
const A_JS = 'function a() {\n  return 1;\n}\n';

export function buildFixtures(dir) {
  const alpha = init(dir, 'alpha');
  commit(alpha, ALICE_OLD, 1000, {
    'a.js': A_JS,
    '.mailmap': 'Alice <alice@example.com> <alice@old.example.com>\n',
  });
  commit(alpha, BOB, 2000, { 'b.js': 'function b() {\n\n    return 2;\n    }\n' });
  commit(alpha, CAROL, 3000, { 'b.js': 'function b() {\n\n  return 2;\n}\n' });
  commit(alpha, DAVE, 4000, { 'a.js': 'function a() {\n  return 42;\n}\n' });
  commit(alpha, ERIN, 5000, { 'a.js': A_JS });
  commit(alpha, ALICE_OLD, 6000, { 'a.js': `${A_JS}const shared = true;\n` });
  commit(alpha, HEIDI, 7000, { 'a.js': `${A_JS}const shared = true;\ntie();\n` });
  commit(alpha, LEO, 9500, {
    'logo.png': LOGO,
    '.gitattributes': 'data.txt binary\n',
    'data.txt': 'hello\nworld\n',
  });

  const beta = init(dir, 'beta');
  commit(beta, GRACE, 500, { 'shared.js': 'const shared = true;\n' });
  commit(beta, FRANK, 1500, { 'copy.js': `${A_JS}\n// beta only\n` });
  commit(beta, IVAN, 7000, { 'shared.js': 'const shared = true;\ntie();\n' });
  commit(beta, JUDY, 8000, { 'win.js': 'function a() {\r\n\r\n}\r\n' });
  commit(beta, KATE, 9000, { 'logo.png': LOGO });

  return { alpha, beta };
}
