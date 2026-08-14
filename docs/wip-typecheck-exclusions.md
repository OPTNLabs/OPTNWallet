# WIP TypeScript exclusions

Strict TypeScript checking is the default for maintained wallet code. A WIP
surface may opt out only when the exemption is explicit in the source file and
listed here with a reason and an exit condition.

These exclusions are not release-critical wallet paths and must not contain
new key storage, signing, broadcast, authentication, or migration logic until
their typecheck exemption is removed.

| Surface                                                              | Reason                                                                    | Exit condition                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/pages/apps/MarketplaceAppHost.tsx`                              | Experimental app host is still changing shape.                            | Type the app host data and remove its `@ts-nocheck`.              |
| `src/pages/apps/airdrops/services/executeAirdropDistributionSend.ts` | Experimental airdrop flow is not part of the maintained wallet surface.   | Add strict output/result types and remove its `@ts-nocheck`.      |
| `src/pages/apps/cauldron/CauldronSwapApp.tsx`                        | Large WIP integration is being stabilized separately.                     | Type the quote/result state machine and remove its `@ts-nocheck`. |
| `src/pages/apps/fundme/CampaignDetail.tsx`                           | Experimental FundMe UI has legacy nullable CashScript data.               | Type UTXO/token narrowing and remove its `@ts-nocheck`.           |
| `src/pages/apps/fundme/cashstarterPledge.ts`                         | Experimental FundMe transaction flow has legacy initialization paths.     | Make commitment construction total and remove its `@ts-nocheck`.  |
| `src/pages/apps/fundme/fundmeTransactions.ts`                        | Experimental FundMe transaction flow uses legacy optional satoshi fields. | Add validated UTXO helpers and remove its `@ts-nocheck`.          |
| `src/pages/apps/mint-cashtokens-poc/MintCashTokensPoCApp.tsx`        | Proof-of-concept UI is not a maintained release path.                     | Type the build result boundary and remove its `@ts-nocheck`.      |
| `src/pages/apps/patient0/AuthGuardApp.tsx`                           | Experimental app has legacy CashScript artifact fallbacks.                | Type artifact candidates and remove its `@ts-nocheck`.            |
| `src/services/AddonsSDK.ts`                                          | Addon system is explicitly out of scope for this hardening pass.          | Revisit the addon architecture, then remove its `@ts-nocheck`.    |

Do not add an exclusion for a maintained wallet path to make CI pass. Fix the
type boundary or obtain an explicit WIP classification first.
