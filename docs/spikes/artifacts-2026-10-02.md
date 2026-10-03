# Spike — first contact with Cloudflare Artifacts

Date: 2026-10-02. Account: Workers Paid. Namespace: `gf-staging`.
Tools: wrangler 4.146.0 (`wrangler artifacts …`), git from macOS, a throwaway Worker (`spikes/artifacts/`) run
with `wrangler dev`. The Artifacts binding is always remote in `wrangler dev`: it touches real resources.
Everything created was deleted at the end (wrangler has no command to delete a namespace, so `gf-staging`
stays, empty).

**About the latencies in section 1**: they were measured from a laptop through `wrangler dev`'s remote proxy,
so they include the laptop → Cloudflare round trip. They are not the latencies of a deployed Worker; those are
in section 5.

---

## 1. Verified facts

| # | Question | Result | Evidence |
|---|---|---|---|
| F1 | How is a namespace created? | Implicitly, with its first repository (`repos create --namespace gf-staging`). | `namespaces list` before: empty; after: `gf-staging` |
| F2 | Remote format | `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`, as documented; in the `remote` field of `create`, `info()` and `fork()`. | `create`, `info` output |
| F3 | Token format | `art_v2_x_<hex>?expires=<unix>`. The docs say `art_v1_`: read `expires` without trusting the prefix. | `issue-token`, `createToken` |
| F4 | Tokens returned at creation | `create` and `fork()` return **a write token with a ~24 h TTL**, visible in `listTokens`. | `expires` − now ≈ 86,400 s |
| F5 | Repository names | Regex `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` (error 10101). Uniqueness is **case-insensitive** (`Gf-Upper` blocks `gf-upper`), but the name is stored as written. Names of 300 characters were accepted (no upper limit found). | `repos create` trials |
| F6 | REST error codes (wrangler) | 10200 repository not found, 10201 already exists, 10101 invalid name. | wrangler output |
| F7 | **Binding** error on a missing repository | `get()` throws a generic `Error` with message `"ArtifactsError: Repository not found: <name>."` and **no `code` field**: telling not-found apart means reading the message. | `/get?repo=nope-missing` |
| F8 | Token scopes | A `read` token gets **403** on push (`Insufficient permissions`); a `write` token pushes. | git push |
| F9 | Per-repository isolation | The fork's token **cannot read or write** main (403); main's token **cannot write** the fork (403). A token is valid for one repository. | crossed git push / ls-remote |
| F10 | TTL | A token with `ttl=60`, used 23 s after expiry → **403 "Invalid or expired token"**, for push and read. | git push / ls-remote |
| F11 | Revocation | `revokeToken(plaintext)` → a push with that token is refused **at once** (403 at second 0). `createToken` returns `{id, plaintext, scope, expiresAt}`; `listTokens` shows `id`, `scope`, `state`, `createdAt`, `expiresAt`. | binding + git push |
| F12 | **Branch protection** | **None.** With a write token on main a `git push --force` is accepted and rewrites history (commit B was removed from main). Creating and deleting branches is unrestricted too. | `+ 9b43cdf...098e4ff main -> main (forced update)` |
| F13 | Concurrent ref updates | The server compares and swaps: 6 rounds of 2 concurrent pushes from identical bases → **exactly one push wins every time**, the other gets `rejected main -> main (stale ref)`. Linear history, no lost commit. | race loop |
| F14 | A fork's history | A fork holds the parent's whole history at fork time. `readCommit` and `readTree` of the base commit work **reading from the fork**. | `/log`, `/commit`, `/tree` on the fork |
| F15 | Reading for a server-side diff | `log`, `readCommit` (with `treeHash`, `parents`), `readTree` (one level: `name`, `mode`, `hash`, `type`), `readBlob` (`size` and text) and `readFile` work. A diff between the base commit and the fork's head is rebuilt by comparing hashes; subdirectories need one `readTree` per level. | binding output |
| F16 | **Fast-forward from a fork** | Fork of the current main → the agent pushes to the fork → the platform fetches from the fork (fork token) and pushes the SHA to `refs/heads/main` (main's token, **no force**) → main == the fork's SHA. **Works.** (The merge queue no longer lands an agent's commit; the same relay now moves the read replicas.) | `801a69e..8b96445 -> main`; `log` confirms |
| F17 | Pushing on an old base | If main moved on, pushing the fork's SHA is **refused** (`fetch first`): the patch is stale and needs a rebase. | refused push |
| F18 | Fork independence | After deleting the parent, the fork **stays** readable and clonable: forks must be deleted explicitly. | `/delete` parent, then `ls-remote` fork |
| F19 | Metadata | `info().lastPushAt` stays `null` and `updatedAt` does not change, even after many pushes. Use `log({ref: 'main', limit: 1})` to know whether main moved. | `info` after the pushes |
| F20 | Latencies from the laptop (see the note above) | `fork()` **4.0–4.3 s** (2 measurements); `create` ~3 s (CLI); `delete` 2.6 s; `info`/`log`/`readCommit`/`readTree`/`readBlob`/`createToken`/`revokeToken` 0.4–0.9 s each; a git push ~0.5 s. | the Worker's `ms` field |

---

## 2. Design consequences (carried into docs/SPEC.md)

- **D1 — No fork on the claim path.** At ~4 s per fork (F20), one persistent fork per agent is created at
  join and reused for every task, with one branch per task (`task/<taskId>/<leaseEpoch>`). A claim is then a
  reservation in the Durable Object plus, at most, a token.
- **D2 — Tokens.** The automatic 24 h token is revoked right after every `fork()` (F4). Tokens are short and
  revoked after use (F11, immediate); objects store token ids, never the secrets.
- **D3 — main is unprotected (F12).** Agents never receive a write token on main, only a read token to
  rebase (F9). The platform never force-pushes during a merge; a write token on main lives only for one
  merge and is revoked afterwards.
- **D4 — Atomic ref updates (F13).** The platform's push to main is a compare-and-swap; a moved main makes the
  patch stale and its agent rebases (F17).
- **D5 — Server-side diff (F14, F15).** Trees are compared by hash and changed blobs read, from the fork: about
  one call per directory level plus one per changed file.
- **D6 — Names.** Derived names are lowercase (uniqueness ignores case, F5) and follow the regex; a truncated
  hash of the agent id bounds their length.
- **D7 — Errors.** The binding has no error code (F7): not-found is recognised on the message prefix, in one
  tested function; everything else is rethrown.
- **D8 — Cleanup.** Forks outlive their parent (F18): a job deletes closed branches and an admin command
  deletes a repository with its forks.
- **D9 — Local development.** `wrangler dev` with the Artifacts binding touches real resources: the `dev`
  environment mocks Artifacts; real runs go to `staging`, with its own namespace.

---

## 3. Reproduction

Spike Worker: `spikes/artifacts/` (`index.js`, `wrangler.jsonc`, namespace `gf-staging`), started with
`npx wrangler dev -c spikes/artifacts/wrangler.jsonc --port 8796`. Endpoints: `/get`, `/info`, `/fork`,
`/token`, `/tokens`, `/revoke` (token in the POST body), `/log`, `/commit`, `/tree`, `/blob`, `/file`,
`/delete`; each answer carries `ok`, `ms` and the value or the error.
Tokens: `npx wrangler artifacts repos issue-token <repo> --namespace gf-staging --scope read|write --ttl <s> --json`,
passed to git **through environment variables** (`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader
GIT_CONFIG_VALUE_0="Authorization: Bearer …"`), never in command arguments or URLs.

---

## 4. Later the same day

- **Events exist.** The 2026-10-01 changelog announced Artifacts event subscriptions (repository created,
  imported, forked, deleted, push, clone, fetch; a push carries `ref`, `before`, `after` and the commits),
  delivered through Queues event subscriptions. The main guard uses them (docs/SPEC.md §8b).
- **Merging without a container: verified.** Relaying a packfile over smart HTTP (upload-pack on the fork with
  `want`/`have` → receive-pack on main with CAS) works on real Artifacts: 6 objects, 6.3 KB,
  `ok refs/heads/main`; a wrong expected SHA gives `ng refs/heads/main stale ref` and main is unchanged.
  **Protocol quirk:** Artifacts' upload-pack appends a flush-pkt `0000` after the pack even without side-band
  (`git index-pack`: "pack has junk at the end"); the code strips it only when the pack's SHA-1 checksum
  confirms it. Reported to Cloudflare (docs/reports/cloudflare-feedback-2026-10-02.md).
- **Zombie forks (reproducible).** In bursts of concurrent forks, 15–33 % of the attempts failed: on a
  repository created seconds before, and in one later run (3 of 20) on a repository minutes old. The name
  then answers "repo already exists" to `fork()`/`create()` while `get()` answers "Repository not found" and
  `list` does not show it; after ~15 minutes the name can be created again. Mitigation in the code: wait with
  backoff, then an alternate name (`-r2`).
- **Latencies measured inside the deployed Worker** (8 E2E runs on earlier builds, before the merge queue):
  claim median 234 ms (67–440), diff + gates 376 ms (138–558), relay merge 778 ms (483–1,311); fork creation
  2–9 s seen by the client. Raw data: `benchmarks/results/2026-10-02/e2e-native-runs.json`.
