# Keystone hardware wallet: what's broken and what a real fix needs

## Status: disabled in the UI this pass

`HardwareWalletSettings.tsx` no longer lets a user select or "connect"
Keystone — it's shown greyed out with a "Coming soon" badge. Previously,
selecting it and clicking "Enable Keystone (QR mode)" just dispatched a fake
`connected: true` with **no actual device communication** (there's no
"connect" handshake for an air-gapped device, so this could never fail) —
telling the user their air-gapped signing was ready when nothing behind it
actually worked. That's disabled now rather than left reachable.

## Confirmed against the real installed SDK, not just read-and-assumed

`@keystonehq/bc-ur-registry-btc` (already a project dependency) exports the
actual classes this integration should be built on:

```
BtcSignRequest, BtcSignature, CryptoPSBT, URRegistryDecoder, ...
```

`KeystoneService.ts` uses **none of them**. It hand-rolls its own PSBT bytes
and fakes a UR string (`UR:${urType}/${btoa(psbtBase64)}`) instead of using
`CryptoPSBT` (the real UR-wrapped PSBT type) or `URRegistryDecoder` (the real
multi-part animated-QR decoder). The one import it does have from the
registry package (`RegistryTypes`, `CryptoHDKey`) is immediately discarded
(`void RegistryTypes; void CryptoHDKey; // imported for side effects / future use`)
— it's dead weight, not actually used to build anything.

Concretely broken, independent of which SDK classes are used:

1. **`buildBchPsbt` never serializes transaction outputs.**
   ```ts
   // Per-output maps (empty for now)
   // Count outputs from tx (simplified — skip for minimal PSBT)
   parts.push(0x00); // single output separator placeholder
   ```
   The entire reason to show a PSBT to an air-gapped signer is so the human
   can verify the destination addresses and amounts before approving. A PSBT
   with no output data gives the device (and the user) nothing to check.

2. **`extractTxFromPsbt` reads the wrong field.** It scans the PSBT's global
   map for key `0x00`, which is `PSBT_GLOBAL_UNSIGNED_TX` — the *unsigned*
   transaction. A signed/finalized transaction is reconstructed from each
   input's finalized scriptSig (`PSBT_IN_FINAL_SCRIPTSIG`), not re-read from
   the same unsigned-tx slot. As written, "parsing the signed result" would
   hand back the original unsigned transaction and call it done.

3. **The UR encoding isn't real BC-UR.** Real UR encoding for anything
   larger than a trivial payload needs CBOR encoding plus fountain-code
   chunking for the animated-QR frames (`@keystonehq/animated-qr` — also
   already a dependency — exists specifically for this). A bare
   `UR:TYPE/<base64>` string is not a format any real Keystone device or the
   real `URRegistryDecoder` would produce or accept.

4. **Not wired to anything.** There is no `signWithKeystone` anywhere in the
   codebase — `hardwareWalletSigning.ts` only dispatches to
   Trezor/Ledger/OneKey. No UI file calls `buildKeystoneQrPayload` or
   `parseKeystoneSignedQr` (confirmed via search). Even if all of the above
   were fixed, nothing currently invokes this code from a real send flow.

## What a real implementation needs

- Build the signing request with `CryptoPSBT` (or `BtcSignRequest` if that's
  the more appropriate type for this device family — needs checking against
  Keystone's own integration examples) from `@keystonehq/bc-ur-registry-btc`,
  not a hand-rolled byte array.
- Include full output data (addresses + amounts) in the PSBT so the device
  can actually show them for user review.
- Use `@keystonehq/animated-qr` to render the outbound animated QR and
  `URRegistryDecoder` to decode the multi-part QR the device shows back,
  instead of string-slicing a fake `UR:` prefix.
- Extract the finalized transaction by combining each input's finalized
  scriptSig into the original unsigned transaction, not by re-reading the
  unsigned-tx field.
- Wire a `signWithKeystone` into `hardwareWalletSigning.ts`'s dispatch and
  the actual send flow, with the same input-path handling
  (`buildBip44Path`/`BCH_STANDARD_BRANCH_INDEX`) already fixed for the other
  three wallets.
- Test against a real or emulated Keystone device before re-enabling in the
  UI — this is signing code for real funds; a passing `tsc`/`eslint` is not
  evidence it actually works with a physical device.

This is genuinely correctness-critical cryptographic/protocol code. Matching
the same discipline already applied to CashFusion and the browser extension
in this PR: implement it properly in its own dedicated, carefully-tested
session rather than rushing a fix in alongside everything else here.
