# Consolidation — MCP Resources spec review (7 personas)

**Date:** 2026-05-22
**Reviewed:** `docs/2026-05-22-spec-mcp-resources.md` (+ parent proposal) against the live Worker.
**Reviewers:** security-auditor, performance-engineer, type-safety-reviewer, ux-accessibility, architecture-reviewer, cloudflare-infra, cost-reviewer (one file each in this folder).

## Overall verdict

**Ship v1 — fixed resources only — with four mandatory changes folded in.** No reviewer found a Critical issue and none found a structural flaw (architecture rates the design Low risk). The blocking work is: (1) defer the item template, (2) make dispatch table-driven with an explicit allowlist→upstream-path map, (3) edge-cache reads, (4) mandate TypeScript interfaces. Everything else is copy/precedent polish.

Per-persona overall ratings:

| Persona | Rating |
|---|---|
| Security | Medium (→ Low if template deferred + allowlist/tests mandatory) |
| Performance | Medium |
| Type safety | Medium |
| UX / accessibility | Medium |
| Architecture | Low |
| Cloudflare infra | Approve w/ recommendations |
| Cost | Medium (→ Low with caching) |

## Open questions — resolved (cross-persona)

| Q | Decision | Vote |
|---|---|---|
| **Q1 — item template `{item_code}` in v1?** | **DEFER to v2.** `resources/templates/list` returns `[]` in v1. | Unanimous (Security: only injection surface; Perf+Cost: unbatched N+1, ~+$40–80/mo ES tier risk; Arch: only piece crossing noun/verb; UX: muddies tool/resource model) |
| **Q2 — items catalogue fields** | **LEAN.** Drop zh/ta/aliases. **Also drop `name_en`** → 4 fields: `item_code, name, unit, item_category`. Single all-required `CatalogueItem` type. | Lean: unanimous. `name_en` drop: see conflict resolution below |
| **Q3 — methodology source** | **EMBED** in the bundle as `src/methodology.ts` (mirror `changelog.ts`), date-stamped. Not proxy `/about`, not KV/R2/Assets. | Unanimous (Security, UX, Arch, CF, Cost) |
| **Q4 — `meta/latest-week` now?** | **SHIP NOW** as a resource; freeze the contract to 3 named fields (`latest_weekdate, premises_reporting, items_with_data`); proposal #4 (coverage) must **reuse the same upstream view**, not duplicate. | Unanimous |
| **Q5 — `name_en` vs multilingual in item card** | Moot in v1 (template deferred). When the card ships in v2 it may carry `name_en` (single item = cheap). Bulk catalogue stays Malay-only; English/zh/ta disambiguation is served on demand by the existing `search_items` tool. | Resolved via Q2 |

## The one real conflict — `name_en` in the bulk catalogue

> **⚠️ SUPERSEDED 2026-05-22 (user decision):** the "drop `name_en`" resolution below was
> **overridden** — `name_en` is now **required** in `catalogue/items`, paired with a
> recent-active item filter (last ~12 weeks) that offsets the size cost. Reason: the MCP2
> Completions review (UX-1) showed a Malay-only catalogue gives English typists an empty
> autocomplete dropdown, and English queries are a headline use case. See the revised Resources
> spec §2/§9. The analysis below is retained as the original review record.

- **UX** wanted `name` (Malay) + `name_en` for English-speaking agents.
- **Performance** + **Cost** + **Type-safety** pushed lean: 5-field (incl. `name_en`) ≈ **95 KB / ~25 K tokens** (busts the 80 KB budget); 4-field ≈ **63 KB / ~16 K tokens**. Full multilingual ≈ 176 KB / 3–4× the agent's context-token cost.

**Resolution: drop `name_en` from the bulk catalogue (4-field).** Rationale:
- Edge-caching (below) solves the ES/wire cost either way, so the residual cost of `name_en` is purely the **agent's standing-context tokens**, where smaller is strictly better for a resource meant to be loaded up front.
- UX's hard requirement (Malay `name` must be present — it's the source-data + end-user language) is met.
- English disambiguation already exists one tool-call away: `search_items` returns all translations on demand — the right place for targeted lookups, vs paying for 756 English strings in standing context.
- Keeps a clean all-required type (no `name_en?: string | null` nullability that type-safety flagged as drift-prone).
- **Revisit trigger:** if `resource`-tagged telemetry later shows English-locale agents repeatedly round-tripping to `search_items` after reading the catalogue, add `name_en` then (it's an additive, non-breaking change).

## Mandatory spec changes (fold into the revised spec)

Severity in brackets is the highest any reviewer assigned.

1. **[High] Table-driven dispatch + explicit allowlist→path map.** One `RESOURCES`
   const where each entry carries `{ uri, name, title, description, mimeType, upstreamPath, kind }`. A `Map<uri, upstreamPath>` (or the const) is the **sole** fetch authority — never derive the upstream path from the inbound URI. `callUpstream` currently hardcodes `path = /api/v2/mcp/${toolName}` (`src/index.ts:587`) and does **no `encodeURIComponent`**; resources need a path-override param. (Security SEC-1/SEC-2 + Architecture #2 converge here.)
2. **[High] Edge-cache `resources/read`.** Wrap resource fetches in `caches.default` with a **synthetic GET cache-key Request** (POST JSON-RPC can't be keyed directly), keyed on `weekdate`, `Cache-Control: max-age=21600` (6h). Widen the Worker entrypoint to `fetch(request, env, ctx)` for `ctx.waitUntil`. Free; kills ~99% of catalogue→ES traffic. (CF-1 + Perf + Cost C2.)
3. **[High] Mandate TypeScript interfaces.** `MCPResource`, `ResourceContents`, `ResourceReadParams`, `ResourceTemplate`, `CatalogueItem`, plus generic `callUpstream<T>` (currently returns `Promise<unknown>`, `src/index.ts:586`). Add a `resource` field to `CallMeta` + the telemetry point. Address `noUncheckedIndexedAccess: false` (`tsconfig.json:15`) by using `.find()` / `Map.get()` (already `T | undefined`) and forbidding bare `[]` indexing on capture groups. (Type-safety T1/T2/T3.)
4. **[High] Specify literal `resources/list` copy.** Exact `name`/`title`/`description`/`mimeType` per resource — each description must state "no prices," languages carried, and freshness semantics. (UX.)
5. **[High] Cross-link tools → resources.** Update `search_items`, `list_chains`, `compare_prices` tool descriptions to reference the new `manamurah://catalogue/*` resources, else the round-trip-killing goal fails (agents won't discover them). Update server card + root manifest to advertise resources. (UX.)
6. **[Medium] Compact serialization.** Resource `text` must be `JSON.stringify(data)` — NOT the pretty-printed `null, 2` form tools use (`src/index.ts:678`); ~40% size saving.
7. **[Medium] State a noun/verb principle** for tool/resource overlap (`catalogue/chains` vs `list_chains`; `meta/latest-week` vs future coverage tool): *a dataset may be both only when the Resource is the whole unparameterised reference set (noun) and the Tool is a parameterised query (verb).* (Architecture.)
8. **[Medium] Size CI gate** at < 80 KB on `catalogue/items` (passes comfortably at 4-field ~63 KB). (Perf §7, Cost.)
9. **[Medium] State the trust assumption** (ES→upstream→Worker→client; resource content becomes auto-loaded agent context = a poisoning surface; low risk on verbatim gov data, but documented). (Security SEC-3.)

## Adjacent recommendations (out of strict scope, cheap, do alongside)

- **[High, UX] Upgrade tool error messages** to be actionable (`Unknown tool: X`, `Tool execution failed` at `src/index.ts:666,688`) so they match the new resource-error quality. Touches tool code, not resources — flag for the same PR.
- **[High, Arch] CI name-parity drift check.** Worker exposes 14 tools; the Python ref repo registers 15 (`chain_mom_movers`); README/package.json say 14 — already drifted. Resources add a 3rd hand-maintained surface. Add a parity check (relates to proposal #7).

## Phased caching strategy (reconciles CF-infra + Cost)

- **Phase 1 (v1, ship now):** Cache API (`caches.default`) keyed on `weekdate`. Free, no ETL dependency, no new binding. Kills ~99% of redundant catalogue→ES load.
- **Phase 2 (target state, needs ETL change):** Catalogues in Workers KV, written by the ETL weekly (`cat:items|states|categories|chains`, `meta:latest-week`). Removes the SvelteKit+ES hop entirely and decouples freshness from the upstream 12h cache. One new KV binding.
- **Rejected:** D1 (whole-object reads = KV's job), R2 (payloads too small; note as future bulk-export home), Workers Static Assets (equivalent-but-worse than embed/KV here), Durable Objects (only if subscriptions are ever wanted — they're a non-goal). Vectorize/AI Gateway out of scope (future RAG tool-discovery only).

## Cost bottom line

Net incremental **metered** cost ≈ **$0** at Low/Mid volume, **< $6/mo** even at 20 M reads/mo (all inside the Workers Paid $5 base). The only material risk is **ES capacity creep** (provisioned RAM-hours, not per-query) from uncached reads + the template N+1 — both eliminated by deferring the template and adding Phase-1 edge caching. Keep WAE at 100% sampling (store the template id / resource name, never a concrete `item_code`).
