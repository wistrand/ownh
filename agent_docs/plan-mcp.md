# Plan: `ownh mcp`

Status: not built. Promote the relevant parts into
[architecture.md](architecture.md) (Agent section) and delete this file once
built.

## Goal

Serve the `ownh agent` tools over MCP, so that MCP clients (Claude Code,
Claude Desktop, others) can query one database with their own model. No
`--ai` settings and no API key are needed on the OWNH side.

```bash
ownh mcp --db acme.db [--out dir] [--top n]
```

## Decision: real names (user decision)

Tool results carry real names, emails, repository names, paths, CODEOWNERS
handles, and line text.

Why: `ownh agent` keeps names local by pseudonymizing the question before it
is sent and unmapping the answer after. In MCP the client owns both the
question and the answer; OWNH sees only tool calls. With tokens, the model
would answer in `[O3]` and nobody could read it, and `find` would still need
real names as input. Rejected.

Consequences:

- Add a third exception to the never-send invariant in CLAUDE.md, next to
  `--ai` and `ownh agent`. It must say that `ownh mcp` returns names to
  whatever model the client uses, and that running it and connecting a client
  is the user's choice of provider.
- Never make this the default for `--ai` or `ownh agent`. They stay
  pseudonymized.
- Print the exposure plainly at startup, on stderr (stdout carries the
  protocol).

## Design

- **Transport.** JSON-RPC 2.0 over stdio, newline-delimited, hand-written, no
  dependencies. Handle `initialize`, `notifications/initialized`,
  `tools/list`, `tools/call`, and `ping`. Return the JSON-RPC errors for
  unknown methods and bad params. Never write anything but protocol messages
  to stdout; logs and progress go to stderr.
- **Module.** New `src/mcp.js`, plus an `mcp` command in `bin/ownh.js`.
- **Stats.** Load through `cachedStats` with the report directory's cache, as
  `ownh agent` does. A reported database then starts in seconds. Load before
  answering `initialize`, or answer it at once and load lazily on the first
  `tools/call`. Prefer the lazy load: clients time out on slow startup.
  Unverified: each client's timeout.
- **Tools.** Reuse `agentTools(stats, naming, db)` unchanged. It already takes
  the naming object `p`, so pass a plain naming with the same interface as
  `agentPseudonyms` instead of tokens:
  - `owner(o)` returns the display name (`name <email>` when two people share
    a name, as `display` in `agentPseudonyms` does)
  - `repo`, `path`, `line`, and `team` return the real value
  - `resolve` accepts a name, a `name <email>` string, an email, or a
    repository name, and returns the same `{ prefix, key, display }` shape
  - `unmap` is the identity function

  Open question: whether any handler compares token strings directly instead
  of going through `resolve`. Check every handler before relying on this.
- **Tool schemas.** Convert the OpenAI function definitions to MCP `tools`
  entries (`name`, `description`, `inputSchema`). Rewrite descriptions that
  mention tokens so they say names.
- **Results.** Return each handler's JSON as one `text` content item.
  Handler errors become results with `isError: true`, not protocol errors.
- **Instructions.** Send the useful parts of the `SYSTEM` prompt as
  `instructions` in the `initialize` result: what OWNH measures, the time
  tools, and the deadpan voice. Nothing enforces them; the client's model may
  ignore them.
- **Audit log.** Append each tool call and its result size to
  `report/<db>/mcp-requests.jsonl`. Never log only the name and drop the
  arguments; the log should show what was requested.
- **Read-only.** No tool writes to the database or runs git. No SQL from the
  model (same decision as `ownh agent`).

## Docs and copy

- CLAUDE.md: the invariant exception, a `src/mcp.js` layout row, the command.
- architecture.md: a subsection under Agent covering transport, naming, and
  the log.
- README.md: a short "Use from an AI assistant" section with a client config
  example (`command: ownh`, `args: ["mcp", "--db", "..."]`) and the names
  warning. Deadpan.
- Site: optional, one line in the AI strip. Decide after it works.

## Tests

- A protocol round trip on a fixture database: `initialize`, `tools/list`,
  then one `tools/call` each for `owners` and `find`. Check that stdout holds
  only JSON-RPC lines.
- Plain naming: `resolve` finds a person by name and by email, and two people
  with one name come back distinct.
- An unknown tool and bad arguments return `isError` results.

Use fictional names only.
