# ipfs-pinner

`@railgun-reloaded/ipfs-pinner` is (will be) an availability daemon for
RAILGUN IPFS content. It scrapes IPFS hashes from on-chain sources
(mainnet governance voting, core contract verifying-key registrations),
merges them with a locally configured list, and keeps them all pinned on a
Kubo node with human-readable pin names (`ipfs pin ls --names`).

The MVP is a supervised demo prototype. A single Node.js process on a timer
that:

1. loops through a hard-coded list of pin sources — the mainnet voting
   contract, verifying-key contracts for supported chains, plus a checked-in
   artifacts JSON — and merges their CIDs into one desired pinset,
2. diffs the desired pinset against the Kubo node's actual pins,
3. pins the missing entries with a per-pin fetch timeout and deterministic
   names, and
4. loops on a timer; add-only, never unpins; failed pins retry next cycle.


## Repository layout

```text
bin/              runnable pinner daemon entrypoint (bin/pinner.ts)
src/              TypeScript package source
test/             Node test runner tests (pure logic only)
docs/             design, decisions, and plan
tickets/          implementation tickets (T0 epic + T1-T3)
CONTEXT.md        glossary of terms used in these docs
Dockerfile        multi-stage build for the daemon image
compose.yml        Kubo + daemon, for local end-to-end runs (see D12)
```

Not published to npm; package layout only mirrors the house style.

## Run

Locally against a Kubo you run yourself:

```bash
npm install
npm run build
KUBO_API_URL=http://127.0.0.1:5001 npm start
```

Or via Docker Compose (Kubo + the daemon, both containerized):

```bash
docker compose up -d --build
docker compose logs -f ipfs-pinner
docker compose exec ipfs ipfs pin ls --type=recursive --names
docker compose down
```

Kubo's data persists in `./data/ipfs` between runs. This packaging was
pulled forward from the post-MVP backlog (D7 originally deferred it) so
the daemon could be smoke-tested against a real Kubo node instead of a
mock; see `docs/decisions.md` D12.

## Configuration (flat env, single process)

- `KUBO_API_URL`: Kubo RPC API base URL (e.g. `http://127.0.0.1:5001`).
  Required.
- `PIN_FETCH_TIMEOUT_MS`: per-pin fetch timeout. Optional, defaults to
  `120000` (2 minutes).
- `RECONCILE_INTERVAL_MS`: daemon loop interval. Optional, defaults to
  `600000` (10 minutes).
- `RPC_URL_MAINNET`, `RPC_URL_SEPOLIA`: read-only RPC endpoints for
  `getLogs` / `eth_call`. Land with T2/T3; a source whose chain has no RPC
  URL configured is skipped with a warning.

Everything else is code, not config: the source list (contract addresses,
deployment blocks, chain IDs) is hard-coded, and the static
ceremony/artifacts list (`src/static-list.json`) is checked into the repo —
adding content to pin is a PR. No secrets required: read-only RPC access
plus a local Kubo admin API.

## Docs

- `docs/pitch.md` — shareable one-pager: stack, main flow, interactions.
- `docs/design.md` — architecture: sources, reconciler, naming, MVP
  boundaries, post-MVP hardening.
- `docs/decisions.md` — locked decisions (D1-D11), verified contract facts,
  open questions.
- `docs/plan.md` — MVP ticket cuts (T1-T3) and post-MVP backlog.
- `tickets/` — the cuts as actionable tickets: `t0-epic.md` (context, purpose,
  stakeholders) plus `t1`-`t3` implementation tickets.
- `CONTEXT.md` — glossary.
