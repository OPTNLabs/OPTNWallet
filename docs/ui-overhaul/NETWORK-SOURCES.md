# Network sources product contract

This is the agreed #71 presentation of #75 networking and #83 authority boundaries.
It does not replace `UserNetworkOverlay -> ConnectionPolicy -> SelectionPlan -> ChainService`.

## Visual baseline

The existing wallet UI remains the product visual baseline. The user explicitly
rejected the replacement Leptos shell shown during the September 19 navigation
checks. Those checks establish behavior only, not visual acceptance. Preserve the
old wallet's components and design when connecting shared Rust features, including
Flipstarter; do not treat a renderer migration as authorization to redesign it.
This applies to Leptos as well as the retained React adapter. The confirmed
reference is the main-release UI (`v1.7.4`, commit `bfc7a1497c5ff0a6bae04dd1c19dc60c21918256`),
not the replacement Leptos shell. New navigation belongs within that visual design.

## Terms

```text
Infrastructure scope
  contains logical sources
    contain endpoints / routes
      use protocols / services
        expose capabilities
          produce observations / evidence
```

Different hosts in one infrastructure group remain separate sources. Same-host
services may share one source. Ownership is not a protocol; adding P2P does not
imply that Fulcrum, RPC or ZMQ exists.

## Navigation

```text
Network overview
  My Infrastructure -> source details
  Public Sources    -> searchable directory -> source details
  My Custom Sources -> source details
  Routing           -> primary scope, chain access, preference, fallback
  Privacy & Transport
  Explorer
  Network backup
```

Screens may differ between desktop, mobile, React, Leptos and CLI. Their mutations
must reach the same Rust validation and persistence. Do not turn this into one
long form or introduce an independent Manual router. Automatic is a user-facing
preset; operation-aware routing remains active within every valid policy.

Source selection, transport/privacy and explorer policy are separate dimensions.
A UI must not offer a transport choice that the host cannot actually enforce.
ZMQ belongs under event sources, not alongside mutually competing sync modes.

## Source lifecycle

| Origin | Enable / disable / ban | User removal |
| --- | --- | --- |
| Maintained/bootstrap | Yes | No |
| User-added | Yes | Yes |
| User infrastructure | Yes | Yes |

Maintain the base catalog separately from the durable overlay. Reapply user bans,
preferences and boundaries after updates. Removing a user source cleans its
selection/preference references but never expands an empty pool to public routes.
An ownership change can permit direct connections for every service on a source;
adding another endpoint must not silently change or ignore that declaration.

## Evidence and privacy

Opening a directory reads existing state. It must not probe the listed public
sources. A future explicit test/detection action must be bounded, cancellable and
subject to current routing/transport restrictions; browsing never grants consent.

Keep these states distinct:

- Catalog entry known.
- Service configured.
- Capability unknown, advertised, verified or rejected.
- Registered provider observation.
- Route currently eligible under policy and health constraints.

An eligible wallet route is not proof that every advertised capability works.
A missing Tor proxy or credential is not proof that a remote capability is
unsupported. Catalog claims have source-level provenance; backend claims retain
endpoint/protocol identity. Do not combine them into a stronger claim.

Cards provide compact service/capability badges. Their explanation must be
available by keyboard and tap, not hover alone. Full endpoints, credentials,
discovery provenance, diagnostics and administration belong in source details.

## Implementation ceilings

The initial source setup supports name/host followed by explicit manual service
configuration; it must say so until a genuine discovery use case is connected.
Existing host transport policy requires Tor for public routes and permits direct
connections to explicitly owned infrastructure. This is not a claim that arbitrary
Direct/Tor/Proxy switching or authenticated remote catalog updates are complete.
Read `docs/pr63-requirement-ledger.md` for scoped execution evidence and remaining
migration work. An older APK does not acquire these UI changes from a source commit.
