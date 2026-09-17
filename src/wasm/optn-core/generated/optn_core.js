/* @ts-self-types="./optn_core.d.ts" */

/**
 * @param {Uint8Array} public_key
 * @returns {Uint8Array}
 */
export function connectP2pkhLock(public_key) {
    const ptr0 = passArray8ToWasm0(public_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.connectP2pkhLock(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * @param {Uint8Array} private_key
 * @returns {Uint8Array}
 */
export function connectPublicKey(private_key) {
    const ptr0 = passArray8ToWasm0(private_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.connectPublicKey(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * @param {string} context_json
 * @param {Uint8Array} private_key
 * @param {Uint8Array} covered
 * @param {number} mode
 * @returns {Uint8Array}
 */
export function connectSignInput(context_json, private_key, covered, mode) {
    const ptr0 = passStringToWasm0(context_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(private_key, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(covered, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.connectSignInput(ptr0, len0, ptr1, len1, ptr2, len2, mode);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v4;
}

/**
 * @param {string} context_json
 * @param {Uint8Array} private_key
 * @param {number} mode
 * @returns {Uint8Array}
 */
export function connectSignP2pkh(context_json, private_key, mode) {
    const ptr0 = passStringToWasm0(context_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(private_key, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.connectSignP2pkh(ptr0, len0, ptr1, len1, mode);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * @param {string} context_json
 * @param {Uint8Array} covered
 * @param {number} mode
 * @returns {Uint8Array}
 */
export function connectSigningSerialization(context_json, covered, mode) {
    const ptr0 = passStringToWasm0(context_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(covered, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.connectSigningSerialization(ptr0, len0, ptr1, len1, mode);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * Decode a Cash Code. Returns JSON, or throws with the reason the code was
 * rejected — including a legacy `paycode:`, which throws rather than
 * decoding. There is no `legacy` field on the result: nothing that decodes
 * here is legacy.
 * @param {string} code
 * @returns {string}
 */
export function decodeCashcode(code) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(code, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.decodeCashcode(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Derive scan/spend private and compressed public keys in the shared core.
 *
 * The packed result is `scan_priv(32) || scan_pub(33) || spend_priv(32) ||
 * spend_pub(33)`. A fixed byte layout avoids serializing private keys into
 * JavaScript strings, which are immutable and cannot be wiped by the caller.
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} scan_path
 * @param {string} spend_path
 * @returns {Uint8Array}
 */
export function deriveRpaKeys(mnemonic, passphrase, scan_path, spend_path) {
    const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(scan_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(spend_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.deriveRpaKeys(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Encode a scan/spend pair as a `cashcode:` string.
 *
 * There is no `legacy` argument. The legacy `paycode:` prefix is a different
 * implementation that OPTN does not support, and an encoder able to stamp it
 * would be a way to manufacture the very strings `decodeCashcode` refuses.
 * @param {Uint8Array} scan_pubkey
 * @param {Uint8Array} spend_pubkey
 * @param {string} network
 * @param {number} prefix_bits
 * @returns {string}
 */
export function encodeCashcode(scan_pubkey, spend_pubkey, network, prefix_bits) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passArray8ToWasm0(scan_pubkey, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(spend_pubkey, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.encodeCashcode(ptr0, len0, ptr1, len1, ptr2, len2, prefix_bits);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Compressed one-shot nonce point published for a credential slot.
 * @param {Uint8Array} nonce
 * @returns {Uint8Array}
 */
export function fusionBlindIssuerNoncePoint(nonce) {
    const ptr0 = passArray8ToWasm0(nonce, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fusionBlindIssuerNoncePoint(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Compressed public key for an issuer's non-zero canonical round secret.
 * @param {Uint8Array} secret
 * @returns {Uint8Array}
 */
export function fusionBlindIssuerPublicKey(secret) {
    const ptr0 = passArray8ToWasm0(secret, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fusionBlindIssuerPublicKey(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Sign one blinded challenge with caller-owned issuer secret and nonce.
 * @param {Uint8Array} secret
 * @param {Uint8Array} nonce
 * @param {Uint8Array} challenge
 * @returns {Uint8Array}
 */
export function fusionBlindIssuerSign(secret, nonce, challenge) {
    const ptr0 = passArray8ToWasm0(secret, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(nonce, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(challenge, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.fusionBlindIssuerSign(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v4;
}

/**
 * The 32-byte blinded challenge to send to the issuer. `a` and `b` must be
 * fresh uniform scalars from the caller's CSPRNG and must never be reused.
 *
 * There is no handle to keep: `fusionFinalizeBlindSignature` takes the same
 * five inputs again and rebuilds the request, so nothing on the JS side owns
 * Rust memory it would have to free.
 * @param {Uint8Array} round_pubkey
 * @param {Uint8Array} r_point
 * @param {Uint8Array} message
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {Uint8Array}
 */
export function fusionBlindRequest(round_pubkey, r_point, message, a, b) {
    const ptr0 = passArray8ToWasm0(round_pubkey, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(r_point, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(a, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(b, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ret = wasm.fusionBlindRequest(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v6 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v6;
}

/**
 * Complete a blinded signature. Takes the same inputs the request was built
 * from plus the issuer's 32-byte response, and returns the 64-byte signature.
 * Always verifies before returning, so a cheating issuer is an error here
 * rather than a rejected signature later in the round.
 * @param {Uint8Array} round_pubkey
 * @param {Uint8Array} r_point
 * @param {Uint8Array} message
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @param {Uint8Array} issuer_response
 * @returns {Uint8Array}
 */
export function fusionFinalizeBlindSignature(round_pubkey, r_point, message, a, b, issuer_response) {
    const ptr0 = passArray8ToWasm0(round_pubkey, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(r_point, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(a, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(b, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray8ToWasm0(issuer_response, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ret = wasm.fusionFinalizeBlindSignature(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v7 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v7;
}

/**
 * Check packed 65-byte uncompressed commitments against one signed amount and
 * the sum of their nonces. Malformed points fail closed.
 * @param {Uint8Array} packed_commitments
 * @param {bigint} excess_fee
 * @param {Uint8Array} total_nonce
 * @returns {boolean}
 */
export function fusionPedersenBalanceHolds(packed_commitments, excess_fee, total_nonce) {
    const ptr0 = passArray8ToWasm0(packed_commitments, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(total_nonce, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.fusionPedersenBalanceHolds(ptr0, len0, excess_fee, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * The 65-byte uncompressed Pedersen commitment `amount*H + nonce*G`.
 * @param {bigint} amount
 * @param {Uint8Array} nonce
 * @returns {Uint8Array}
 */
export function fusionPedersenCommit(amount, nonce) {
    const ptr0 = passArray8ToWasm0(nonce, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fusionPedersenCommit(amount, ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * The commitment for a signed amount: an input commits `+value-fee`, an output
 * `-value-fee`, a blank `0`.
 * @param {bigint} amount
 * @param {Uint8Array} nonce
 * @returns {Uint8Array}
 */
export function fusionPedersenCommitSigned(amount, nonce) {
    const ptr0 = passArray8ToWasm0(nonce, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fusionPedersenCommitSigned(amount, ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * The compressed nothing-up-my-sleeve generator H, for callers that check it.
 * @returns {Uint8Array}
 */
export function fusionPedersenH() {
    const ret = wasm.fusionPedersenH();
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * Whether bytes are one non-zero canonical secp256k1 scalar.
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function fusionScalarIsCanonical(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fusionScalarIsCanonical(ptr0, len0);
    return ret !== 0;
}

/**
 * Add packed 32-byte non-zero canonical scalars modulo the group order.
 * @param {Uint8Array} packed
 * @returns {Uint8Array}
 */
export function fusionScalarSum(packed) {
    const ptr0 = passArray8ToWasm0(packed, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fusionScalarSum(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Verify a 64-byte BCH Schnorr signature. False on any malformed input.
 * @param {Uint8Array} pubkey
 * @param {Uint8Array} signature
 * @param {Uint8Array} message
 * @returns {boolean}
 */
export function fusionVerifySchnorr(pubkey, signature, message) {
    const ptr0 = passArray8ToWasm0(pubkey, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(signature, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.fusionVerifySchnorr(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * How many nSequence values to try before reshaping the transaction.
 *
 * Exported so the wallet grinds as hard as the CLI does. Both previously
 * hardcoded 100_000, which at 16 bits exhausts about a fifth of the time.
 * @param {number} prefix_bits
 * @returns {number}
 */
export function grindBudget(prefix_bits) {
    const ret = wasm.grindBudget(prefix_bits);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
}

/**
 * Sign and grind an assembled RPA payment, in the shared core.
 *
 * The desktop sender used to run its own grind: its own signing, its own
 * serialization, its own SHA-256, and its own 100_000 ceiling, in parallel
 * with the CLI's. Two implementations of the same protocol step is precisely
 * the failure this crate exists to prevent, and the failure mode is quiet —
 * a sender that grinds differently produces a payment that is on chain,
 * valid, and invisible to the recipient scanning for it.
 *
 * The caller still assembles the transaction, because output ordering and
 * review are the wallet's concern. Everything from signing onwards is here.
 *
 * `raw_tx` is the assembled transaction with the stealth output already in
 * place. `prevout_values` and the concatenated `prevout_scripts` (split by
 * `prevout_script_lens`) describe the outputs being spent, in input order,
 * because a sighash needs the value and script of the coin it spends and
 * neither is present in the transaction itself. `privkeys` is 32 bytes per
 * input, in the same order.
 *
 * Returns `{"exhausted":true}` rather than throwing when the budget runs
 * out: that is a reshape signal, and the wallet should reselect coins.
 * @param {Uint8Array} raw_tx
 * @param {BigUint64Array} prevout_values
 * @param {Uint8Array} prevout_scripts
 * @param {Uint32Array} prevout_script_lens
 * @param {Uint8Array} privkeys
 * @param {Uint8Array} scan_pubkey
 * @param {number} prefix_bits
 * @returns {string}
 */
export function grindRpaTransaction(raw_tx, prevout_values, prevout_scripts, prevout_script_lens, privkeys, scan_pubkey, prefix_bits) {
    let deferred8_0;
    let deferred8_1;
    try {
        const ptr0 = passArray8ToWasm0(raw_tx, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray64ToWasm0(prevout_values, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(prevout_scripts, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(prevout_script_lens, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray8ToWasm0(privkeys, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray8ToWasm0(scan_pubkey, wasm.__wbindgen_malloc);
        const len5 = WASM_VECTOR_LEN;
        const ret = wasm.grindRpaTransaction(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, prefix_bits);
        var ptr7 = ret[0];
        var len7 = ret[1];
        if (ret[3]) {
            ptr7 = 0; len7 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred8_0 = ptr7;
        deferred8_1 = len7;
        return getStringFromWasm0(ptr7, len7);
    } finally {
        wasm.__wbindgen_free(deferred8_0, deferred8_1, 1);
    }
}

/**
 * The nSequence for grind attempt `offset`, kept BIP68-final.
 * @param {number} offset
 * @returns {number}
 */
export function grindSequence(offset) {
    const ret = wasm.grindSequence(offset);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
}

/**
 * The hex a sender grinds the input hash to match.
 * @param {Uint8Array} scan_pubkey
 * @param {number} prefix_bits
 * @returns {string}
 */
export function grindString(scan_pubkey, prefix_bits) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(scan_pubkey, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.grindString(ptr0, len0, prefix_bits);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @param {string} candidate
 * @returns {boolean}
 */
export function isLegacyPaycode(candidate) {
    const ptr0 = passStringToWasm0(candidate, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.isLegacyPaycode(ptr0, len0);
    return ret !== 0;
}

/**
 * The message to show for a legacy PayCode. Exported rather than duplicated
 * in TypeScript so the wallet and the CLI refuse it in the same words.
 * @returns {string}
 */
export function legacyPaycodeRejection() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.legacyPaycodeRejection();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * True if the string is a Cash Code this wallet can pay. A legacy
 * `paycode:` is not, and returns false — use `isLegacyPaycode` to tell the
 * user why their string was refused.
 * @param {string} candidate
 * @returns {boolean}
 */
export function looksLikeRpa(candidate) {
    const ptr0 = passStringToWasm0(candidate, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.looksLikeRpa(ptr0, len0);
    return ret !== 0;
}

/**
 * The one-time P2PKH a sender pays: CKD_pub of the spend key, hashed
 * compressed.
 * @param {Uint8Array} spend_pubkey
 * @param {Uint8Array} secret
 * @param {string} network
 * @param {number} index
 * @returns {string}
 */
export function paymentAddress(spend_pubkey, secret, network, index) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passArray8ToWasm0(spend_pubkey, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(secret, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.paymentAddress(ptr0, len0, ptr1, len1, ptr2, len2, index);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * `m/44'/<coin>'/<account>'/3/0` and `/3/1`, as a JSON object.
 * @param {number} coin_type
 * @param {number} account
 * @returns {string}
 */
export function rpaKeyPaths(coin_type, account) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.rpaKeyPaths(coin_type, account);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Payments to this wallet inside one raw transaction, as a JSON array.
 *
 * Takes `scanPrivkey` and `spendPubkey` only -- the spend private key is not
 * needed to find a payment, and requiring it here would destroy the split the
 * spec asks for (REQ-5) between detecting and spending.
 * @param {Uint8Array} raw_tx
 * @param {Uint8Array} scan_privkey
 * @param {Uint8Array} spend_pubkey
 * @param {string} network
 * @returns {string}
 */
export function scanTransaction(raw_tx, scan_privkey, spend_pubkey, network) {
    let deferred6_0;
    let deferred6_1;
    try {
        const ptr0 = passArray8ToWasm0(raw_tx, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(scan_privkey, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(spend_pubkey, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(network, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.scanTransaction(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
}

/**
 * Why this code must not be paid on-chain, or `undefined` if it may be.
 * @param {string} code
 * @returns {string | undefined}
 */
export function sendBlockReason(code) {
    const ptr0 = passStringToWasm0(code, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sendBlockReason(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    let v2;
    if (ret[0] !== 0) {
        v2 = getStringFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v2;
}

/**
 * ECDH plus the outpoint, per the reference implementation. `txid` is the
 * display (big-endian) form, as block explorers show it.
 * @param {Uint8Array} privkey
 * @param {Uint8Array} counterpart_pubkey
 * @param {string} txid
 * @param {number} vout
 * @returns {Uint8Array}
 */
export function sharedSecret(privkey, counterpart_pubkey, txid, vout) {
    const ptr0 = passArray8ToWasm0(privkey, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(counterpart_pubkey, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(txid, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.sharedSecret(ptr0, len0, ptr1, len1, ptr2, len2, vout);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v4;
}

/**
 * The private key that spends a payment at `index`.
 * @param {Uint8Array} spend_privkey
 * @param {Uint8Array} secret
 * @param {number} index
 * @returns {Uint8Array}
 */
export function spendingKey(spend_privkey, secret, index) {
    const ptr0 = passArray8ToWasm0(spend_privkey, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(secret, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.spendingKey(ptr0, len0, ptr1, len1, index);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_bb96b2010945f0bc: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_length_36bd29c6848c2144: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_new_with_length_3ffc1c56427c525c: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_set_b9b5b5cb7b495037: function(arg0, arg1, arg2) {
            arg0.set(getArrayU8FromWasm0(arg1, arg2));
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./optn_core_bg.js": import0,
    };
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedBigUint64ArrayMemory0 = null;
function getBigUint64ArrayMemory0() {
    if (cachedBigUint64ArrayMemory0 === null || cachedBigUint64ArrayMemory0.byteLength === 0) {
        cachedBigUint64ArrayMemory0 = new BigUint64Array(wasm.memory.buffer);
    }
    return cachedBigUint64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getBigUint64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedBigUint64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('optn_core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
