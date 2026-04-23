# AI Instruction: Cauldron Implementation Gap

Use this file for AI agents working on OPTNWallet Cauldron implementation tasks only.

## Scope
- Compare OPTNWallet's Cauldron implementation against the current reference behavior in `cashlab` and the Cauldron indexer.
- Focus on backend transaction construction, pool parsing, preflight validation, signing boundaries, and live pool refresh logic.
- Do not treat this as a human developer guide or product roadmap.

## Current state
- OPTNWallet already has:
  - pool bytecode helpers
  - pool discovery and rehydration
  - trade planning
  - pool deposit request construction
  - pool withdraw request construction
  - wallet signing integration
  - preflight chain reconciliation
  - live subscription support
- The remaining work is primarily about feature completeness and parity with the richer reference planner/router behavior.

## Known implementation gaps
- Multi-pool routing is less complete than the reference `cashlab` planner.
- Route splitting and chained transaction generation are intentionally out of scope for the current direct-flow Cauldron implementation.
- Quote freshness and pre-sign revalidation can be tightened further.
- LP management is functional, but not yet as rich as the reference analysis and routing layers.
- The wallet does not yet expose an internal executor/searcher-style backend mode.

## AI working rules
- Prefer small, testable backend changes.
- Keep transaction construction deterministic.
- Preserve signing boundaries: wallet signs user-controlled inputs; Cauldron logic remains in backend services.
- When editing, prefer service-layer changes over page-layer changes.
- Add or update tests whenever fixing transaction construction or validation logic.

## Next implementation focus
- Close the gaps in Cauldron planning/routing first.
- Then harden preflight and quote refresh behavior.
- Then add any execution or LP-management enhancements that depend on those foundations.
