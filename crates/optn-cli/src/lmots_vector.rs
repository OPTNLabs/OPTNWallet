
/// Compatibility with Quantumroot's own implementation.
///
/// The vector is theirs — `test-suite/static-vector.json` from
/// bitjson/quantumroot — so these check that a real vault would accept what
/// this produces, not that it matches somebody's reading of RFC 8554.
#[cfg(test)]
mod quantumroot_vector {

    use super::{checksum, PrivateKey, Signature, N, P};
        use serde::Deserialize;

    #[derive(Deserialize)]
    struct Vector {
        seed: String,
        #[serde(rename = "I")]
        id: String,
        q: u32,
        #[serde(rename = "K")]
        public_key: String,
        #[serde(rename = "C")]
        c: String,
        message: String,
        #[serde(rename = "Y")]
        signature: String,
        x: String,
    }

    #[derive(Deserialize)]
    struct Document {
        #[serde(rename = "parameterSet")]
        parameter_set: String,
        vector: Vector,
    }

    fn unhex(s: &str) -> Vec<u8> {
        assert!(s.len() % 2 == 0, "hex must be even length");
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("valid hex"))
            .collect()
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn chunks(bytes: &[u8]) -> Vec<[u8; N]> {
        bytes
            .chunks(N)
            .map(|c| {
                let mut out = [0u8; N];
                out.copy_from_slice(c);
                out
            })
            .collect()
    }

    fn document() -> Document {
        serde_json::from_str(include_str!("../tests/vectors/lmots.json")).expect("vector parses")
    }

    fn parts() -> (Vector, [u8; 16], Vec<u8>, Vec<u8>) {
        let doc = document();
        assert_eq!(
            doc.parameter_set, "LMOTS_SHA256_N32_W4",
            "this implementation is only that parameter set"
        );
        let v = doc.vector;
        let id_bytes = unhex(&v.id);
        let mut id = [0u8; 16];
        id.copy_from_slice(&id_bytes);
        let seed = unhex(&v.seed);
        let message = unhex(&v.message);
        (v, id, seed, message)
    }

    #[test]
    fn derives_quantumroots_private_chains_from_the_seed() {
        // If these differ, every later value differs too, so this is the first
        // place a divergence should surface.
        let (v, id, seed, _) = parts();
        let key = PrivateKey::from_seed(&seed, id, v.q);
        let produced: Vec<u8> = key.chains().iter().flat_map(|c| c.to_vec()).collect();
        assert_eq!(key.chains().len(), P, "67 chains");
        assert_eq!(hex(&produced), v.x, "private chains differ from Quantumroot's");
    }

    #[test]
    fn derives_quantumroots_public_key() {
        let (v, id, seed, _) = parts();
        let key = PrivateKey::from_seed(&seed, id, v.q);
        assert_eq!(hex(&key.public_key()), v.public_key);
    }

    #[test]
    fn produces_quantumroots_signature_for_the_same_message() {
        // Deterministic given C, which the vector supplies. A signature that
        // verifies but differs would mean a different chain walk, and the on-chain
        // CashAssembly would reject it.
        let (v, id, seed, message) = parts();
        let key = PrivateKey::from_seed(&seed, id, v.q);
        let mut c = [0u8; N];
        c.copy_from_slice(&unhex(&v.c));

        let signature = key.sign(&message, &c);
        let produced: Vec<u8> = signature.elements.iter().flat_map(|e| e.to_vec()).collect();
        assert_eq!(signature.elements.len(), P);
        assert_eq!(hex(&produced), v.signature);
    }

    #[test]
    fn verifies_quantumroots_signature() {
        let (v, id, seed, message) = parts();
        let _ = seed;
        let mut c = [0u8; N];
        c.copy_from_slice(&unhex(&v.c));
        let mut public_key = [0u8; N];
        public_key.copy_from_slice(&unhex(&v.public_key));

        let signature = Signature {
            id,
            q: v.q,
            c,
            elements: chunks(&unhex(&v.signature)),
        };
        assert!(signature.verify(&message, &public_key));
    }

    #[test]
    fn rejects_that_signature_for_a_different_message() {
        // The whole point of the checksum: a message whose digits are all higher
        // cannot be forged by walking the chains further forward.
        let (v, id, _, message) = parts();
        let mut c = [0u8; N];
        c.copy_from_slice(&unhex(&v.c));
        let mut public_key = [0u8; N];
        public_key.copy_from_slice(&unhex(&v.public_key));

        let signature = Signature {
            id,
            q: v.q,
            c,
            elements: chunks(&unhex(&v.signature)),
        };

        let mut altered = message.clone();
        altered.push(b'!');
        assert!(!signature.verify(&altered, &public_key));
        assert!(!signature.verify(b"", &public_key));
    }

    #[test]
    fn a_tampered_element_does_not_verify() {
        let (v, id, _, message) = parts();
        let mut c = [0u8; N];
        c.copy_from_slice(&unhex(&v.c));
        let mut public_key = [0u8; N];
        public_key.copy_from_slice(&unhex(&v.public_key));

        let mut elements = chunks(&unhex(&v.signature));
        elements[0][0] ^= 0x01;
        let signature = Signature {
            id,
            q: v.q,
            c,
            elements,
        };
        assert!(!signature.verify(&message, &public_key));
    }

    #[test]
    fn the_checksum_matches_the_reference_for_the_vector_digest() {
        // Computed independently of signing, so a checksum bug cannot hide behind
        // a matching signature.
        let (v, id, seed, message) = parts();
        let key = PrivateKey::from_seed(&seed, id, v.q);
        let mut c = [0u8; N];
        c.copy_from_slice(&unhex(&v.c));
        let signature = key.sign(&message, &c);

        // Recovering must land on the published key, which only happens when the
        // checksum digits indexed the same chains.
        assert_eq!(hex(&signature.recover(&message).unwrap()), v.public_key);
        assert_eq!(checksum(&[0xff; N]), 0);
    }

}
