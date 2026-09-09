# PR63: CashFusion AES-CBC zero-IV CodeQL review, 2026-09-09

Reviewed CodeQL alerts **#129** and **#130**
(`rust/hard-coded-cryptographic-value`, critical) against source at
`b928242e`. Both report the same construction in
`src-tauri/src/fusion/encrypt.rs`:

| Alert | Location | Reported sink |
| --- | --- | --- |
| #129 | `encrypt()` | hard-coded value used as an initialization vector |
| #130 | `decrypt_with_symmkey()` | hard-coded value used as an initialization vector |

Both are `let iv = [0u8; 16];` feeding AES-256-CBC.

These alerts became visible only after `d6a5ec8c` added `paths-ignore:
vendor/**`. Excluding vendored GLib is what let CodeQL's Rust analysis surface
first-party code instead of drowning in generic gtk-rs converter graphs. The
alerts are new to the *report*, not new to the *code*.

No alert was dismissed, no scan configuration was changed, and no code was
rewritten to hide a finding.

## Why a fixed IV is not key/IV reuse here

CBC needs a unique `(key, IV)` pair per message. CashFusion satisfies that on
the key side, not the IV side.

`encrypt()` is the only encryption entry point in the crate. Every call
generates a fresh ephemeral scalar and derives the symmetric key from it:

```rust
let nonce_sec = random_nonce();
let nonce_pub = compressed(&(ProjectivePoint::GENERATOR * nonce_sec));
let key = ecdh_key(nonce_sec, &pubpoint);
```

`ecdh_key` is `sha256(compressed(nonce_sec * recipient_pubkey))`. A fresh
`nonce_sec` per message means a fresh `key` per message, so no `(key, IV)`
pair ever repeats even though the IV is constant. `nonce_pub` is prepended to
the blob (33 bytes) purely so the recipient can redo the ECDH.

The symmetric-key-taking function in this file, `decrypt_with_symmkey()`, is
**decrypt-only**. There is no encryption path that accepts a caller-supplied,
potentially reused key. Verified by call sites:

```
src-tauri/src/fusion/blame.rs:179   encrypt::encrypt(...)
src-tauri/src/fusion/blame.rs:682   encrypt::encrypt(...)     (test)
src-tauri/src/fusion/blame.rs:736   encrypt::encrypt(...)     (test)
src-tauri/src/fusion/blame.rs:502   encrypt::decrypt_with_symmkey(...)
src-tauri/src/fusion/blame.rs:603   encrypt::decrypt(...)     (test)
```

`decrypt_with_symmkey()` also verifies the 16-byte HMAC-SHA256 tag over the
ciphertext **before** decrypting, so the zero IV is never reached for a blob
that failed authentication.

## Why the IV cannot be changed

This is not an OPTN design choice. It is the CashFusion blame-phase wire
format, and OPTN's Rust code is a port of it. Upstream
`electroncash_plugins/fusion/encrypt.py` (Mark B. Lundeberg, 2020) states the
format in its module docstring:

```
Format of encrypted blob:

    <33 byte ephemeral secp256k1 compressed point><16N byte ciphertext><16 byte HMAC>

key is sha256(diffie hellman secp256k1 compressed point)
ciphertext is AES256 in CBC mode (iv=0) from the following plaintext string:

    <32-bit length of message, big endian><message><arbitrary padding to any multiple of 16 bytes>
```

and implements it as:

```python
nonce_sec = ecdsa.util.randrange(order)
nonce_pub = point_to_ser(nonce_sec*G, comp=True)
key = hashlib.sha256(point_to_ser(nonce_sec*pubpoint, comp=True)).digest()
...
iv = b'\0'*16
ciphertext = AES.new(key, AES.MODE_CBC, iv).encrypt(plaintext)
mac = hmacdigest(key, ciphertext, 'sha256')[:16]
return nonce_pub + ciphertext + mac
```

The OPTN Rust port is byte-identical in construction, including the
fresh-ephemeral-key-per-message property that makes the constant IV safe.
Choosing a random IV would produce blobs that no Electron Cash CashFusion peer
can decrypt, breaking the blame phase — the phase whose entire purpose is
letting honest players identify a cheater. A wire break there is a real
availability and correctness regression traded for no security gain, because
the key is already single-use.

## What is in scope for this construction

The review above establishes that the reported sink is not key/IV reuse. It
does not claim the blame phase is free of other issues; component-proof
disclosure semantics are reviewed separately and blame remains diagnosis only,
never a ban mechanism.

Two properties must not regress, and are the reason this file should not be
"fixed" casually:

1. `encrypt()` must keep deriving its key from a per-message ephemeral scalar.
   If a future change lets a caller supply a reused symmetric key to an
   *encrypt* path, the constant IV becomes a genuine flaw and CodeQL #129 stops
   being a false positive.
2. `decrypt_with_symmkey()` must keep verifying the MAC before decrypting.

## Assessment

Both alerts are false positives **for this codebase as written**: the reported
IV constant is fixed by an upstream interoperability contract and is safe
because the key is unique per message. The alert text is accurate about the
literal; the security conclusion it implies does not hold here.

References checked:

- `electroncash_plugins/fusion/encrypt.py` in the Electron Cash tree, module
  docstring and `encrypt`/`decrypt_with_symmkey` bodies.
- [CodeQL hard-coded cryptographic value](https://codeql.github.com/codeql-query-help/rust/rust-hard-coded-cryptographic-value/),
  whose stated concern is predictable key/IV material.
- `src-tauri/src/fusion/encrypt.rs` and its call sites in
  `src-tauri/src/fusion/blame.rs`.
