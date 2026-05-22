# Consolidation — MCP Completions spec review (7 personas)

**Date:** 2026-05-22
**Reviewed:** `docs/2026-05-22-spec-mcp-completions.md` (+ proposal + Resources spec) against the live Worker.
**Reviewers:** security, performance, type-safety, ux, architecture, cloudflare-infra, cost (one file each).

## Overall verdict

**Do not build Completions as a standalone feature. Fold it into the #3 Prompts spec.** This is
the unanimous structural finding: MCP completion attaches only to prompt/resource-template
arguments, so completion is a *facet of a prompt argument*, not a feature in its own right. The
machinery (capability, `completion/complete` handler, completers) is sound and protocol-faithful,
but it has no surface, data, or value without #1 (data) and #3 (prompt arguments).

Per-persona ratings:

| Persona | Rating |
|---|---|
| Security | Low |
| Performance | Low |
| Type safety | **High** (under-typed vs the Resources bar) |
| UX | Medium |
| Architecture | Medium (but strongest structural opinion) |
| Cloudflare infra | Low risk / high upside |
| Cost | Low |

## Open questions — resolved

| Q | Decision | Basis |
|---|---|---|
| **Q1 — sequencing** | **Fold into #3 Prompts.** No separate spec/tier/version/registry. Don't advertise `completions: {}` until a live completer exists. This Completions spec becomes a **design reference** consumed by the #3 spec. | Unanimous; architecture strongest ("a facet of a prompt argument, not a feature") |
| **Q2 — `{item_code}` template completion** | **Leave uncompletable.** MCP `values` must be insertable as-is, so a code-typed arg could only return bare codes (unreadable) — display strings violate the insert-this invariant. Name→code stays in `search_items`. | Unanimous (type-safety, UX, architecture) |
| **Q3 — fuzzy quality** | **Prefix + substring + ASCII-fold.** Trigram/typo-tolerance deferrable (cost-neutral in-memory if ever added; the only cost trap is reaching for ES — forbidden). The English-typist gap is **resolved upstream** by the `name_en` decision (below); completers match on `name` **and** `name_en`. Add a value-free `zeroMatch` counter to detect residual gaps. | perf, ux, cost |
| **Q4 — protocol bump to 2025-06-18** | **Defer.** Ship context-free on `2024-11-05`. Bump server-wide (never per-completer) in a dedicated PR with client re-validation if dependent completions are ever wanted. | security, type-safety, architecture |
| **Q5 — rate-limit posture** | **Add the native CF Workers Rate Limiting binding scoped to `completion/complete`.** Critical correction: the spec leaned on the "shared 120/60s upstream limit," but that limit is **fictional for completion** — completion is in-memory and never reaches the upstream that enforces it, so it's currently *uncapped*. CF's Rate Limiting binding (GA 2025-09) is machine-local (~0 latency), scopes to the method without throttling tool calls, and returns an empty completion set (not an error) on trip. | security + cloudflare-infra decisive; perf/cost's "shared limit fine" rested on the false premise that the shared limit applies |

## The English-typist gap (UX-1) — resolved by a user decision, not an alias map

UX-1 (High): a Malay-only catalogue gives English typists ("watermelon", "chicken") an empty
autocomplete dropdown, while the README markets English queries. **Resolved 2026-05-22 by the
user decision to make `name_en` REQUIRED in `catalogue/items`** (reversing the MCP1-review's lean
4-field call), paired with a **recent-active item filter** (last ~12 weeks) that offsets the size
cost. Completers therefore match on `name` + `name_en` from the embedded catalogue — no
separate English→Malay alias map needed. See the revised Resources spec §2/§9 and the superseded
note in the MCP1 CONSOLIDATION.

## Mandatory changes to fold into the (now #3-embedded) design

1. **[Arch High] Fold into #3.** No standalone spec/tier/version/`COMPLETERS` registry. Completers
   **hang off each prompt-argument definition** (avoids a fresh drift surface duplicating prompt
   arg names — the same drift class as the tool/Python-ref issue MCP1 flagged). Gate the advertised
   `completions: {}` capability on a non-empty live completer.
2. **[Type High] Add a "Required TypeScript" section** matching the Resources bar: a `ref`
   discriminated union (`PromptReference | ResourceReference`) with an exhaustive `switch` (+ `never`
   default), `Completer` with **optional** `ctx?: CompletionContext` (it's protocol-gated, absent on
   2024-11-05 — the current `Record<string,string>` signature "lies about an input that never
   arrives"), result-envelope types, and a runtime `isCompleteParams` type-guard (no blind cast of a
   discriminated union).
3. **[Sec + CF High] Native CF Rate Limiting binding** scoped to `completion/complete` (one
   `[[ratelimits]]` block, keyed on `Mcp-Session-Id`→IP, empty set on trip). The shared upstream
   limit does **not** cover completion.
4. **[CF + Perf High] Embed the catalogue** (a bundled names const, ~75–90 KB with `name_en` +
   filter — trivial vs the bundle limit) rather than reusing the Resources Cache/KV phases, so every
   keystroke including the **first on a cold isolate** is zero-network. Module-global memo for the
   parsed/folded form. This makes the "no ES call" property structurally true.
   - *Refresh tradeoff:* an embedded catalogue is only as fresh as the last deploy. Acceptable —
     item **names** don't change weekly, and the recent-active **membership** tolerates a few days'
     lag. If weekly freshness of membership matters, regenerate the const on the existing CF Workers
     Builds cadence. (Flag for the #3 spec.)
5. **[Cost + Perf + CF High] Fix the telemetry contradiction.** §5.3's "100% sampling is fine (low
   volume)" is inverted — completion is the highest-volume method. **Sample completion at 10%**
   (`Math.random() < 0.10` around the completion-path `recordMcp`), keep 100% elsewhere. At 100% a
   viral spike is ~$135/mo of pure WAE; 10% → ~$13.50. Promote the "no ES call fires during
   completion" test to a **CI gate**.
6. **[Sec Medium] Broaden input validation:** clamp/validate `argument.name`, `ref.name`, `ref.uri`,
   and a global body-size cap — not just `argument.value`. The Worker does no in-process validation
   today, so the handler owns it. Make "completers surface only public catalogue data" a **normative
   invariant + CI test** (it's true today but silently breaks the first time a prompt arg points at
   non-public data).
7. **[UX Medium] Completers return canonical-cased verbatim values** (e.g. `Pulau Pinang`,
   `W.P. Kuala Lumpur`) — matching is fold-insensitive, output is exactly what the downstream arg
   needs (states are case-sensitive, `src/index.ts` STATES_HINT). Empty-result-returns-`{values:[]}`
   (not an error) confirmed good. Add a value-free `zeroMatch` telemetry counter.

## Corrections to the reviews (trust-but-verify)

- **Architecture finding "card says 15 tools while `TOOLS.length`=14" is a FALSE POSITIVE.** Verified:
  `TOOLS` has 15 name entries and both descriptions say "15" (consistent, post-`chain_mom_movers`).
  No bug. (The reviewer likely read a stale state.)
- **Stale line anchors are real:** the Completions spec's code anchors (632/929/701/867) predate the
  `chain_mom_movers` edit and are off by ~+34 lines / wrong (current: capabilities `:667`+`:964`,
  dispatch `:736`, cards `:909`/`:952`, `PROTOCOL_VERSION` `:75`). Fix in the revision.

## Net effect on the roadmap

`#1 Resources (data, incl. required name_en + recent-active filter) → #3 Prompts (surface) with
built-in argument completers (this spec's machinery) + native CF rate-limit + 10%-sampled
telemetry`. #2 ceases to be a standalone tier. Version: folds into the #3 release (not its own).
