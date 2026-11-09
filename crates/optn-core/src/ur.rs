//! BC-UR encoding of a PSBT for an air-gapped signer: the animated
//! `ur:crypto-psbt` QR that SeedCash scans.
//!
//! The QR is the only channel to the device, and the wallet used to draw it
//! two ways. Desktop showed animated 50-byte frames. Phones showed one static
//! QR of up to 2,400 characters, which is far denser than SeedCash's camera can
//! read, so a send that worked on desktop could not be signed from a phone.
//! Every surface now gets its frames from here, and [`PsbtUr`] refuses a
//! fragment longer than [`PSBT_UR_MAX_FRAGMENT_LEN`], so no caller can bring
//! the dense QR back.
//!
//! The UR message is the PSBT inside one CBOR byte string (BCR-2020-006), as
//! Keystone writes it and as SeedCash now requires. SeedCash `30c5ba6`
//! (`ur_decoder.py`, `decode_cbor_by_type`) decodes a `crypto-psbt` message as
//! exactly one byte string and drops anything else, so the raw PSBT an earlier
//! SeedCash read directly never completes a scan there. Its own encoder wraps
//! the signed PSBT it hands back the same way. Reading either shape back is
//! [`crate::psbt::psbt_from_ur_cbor`].
//!
//! The fountain code follows the Blockchain Commons reference encoder
//! (BCR-2020-005). `test-vectors/psbt-ur.json` pins its frames, pure and mixed,
//! from `@ngraveio/bc-ur` over Keystone's `CryptoPSBT` wrap, and the wallet's
//! tests decode these frames with SeedCash's own `ur2` decoder.

use sha2::{Digest, Sha256};

use crate::error::{CliError, Result};
use crate::psbt::PSBT_MAGIC;

/// The UR type SeedCash and Keystone both use for a PSBT.
pub const PSBT_UR_TYPE: &str = "crypto-psbt";

/// Bytes per frame unless the holder asks for denser frames. A SeedCash
/// camera reads this reliably. Paytaca's PSBT dialog also used 50.
pub const PSBT_UR_DEFAULT_FRAGMENT_LEN: usize = 50;

/// The densest frame the wallet will draw: the top of the desktop density
/// control. Anything longer is the dense static QR this module replaced.
pub const PSBT_UR_MAX_FRAGMENT_LEN: usize = 450;

/// The reference encoder's smallest fragment.
pub const UR_MIN_FRAGMENT_LEN: usize = 10;

/// All 256 bytewords, four letters each, in byte order.
const BYTEWORDS: &[u8; 1024] = b"ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabiasbluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecolacookcostcruxcurlcuspcyandarkdatadaysdelidicedietdoordowndrawdropdrumdulldutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfishfizzflapflewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglowgoodgraygrimgurugushgyrohalfhanghardhawkheathelphighhillholyhopehornhutsicedideaidleinchinkyintoirisironitemjadejazzjoinjoltjowljudojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamblavalazyleaflegsliarlimplionlistlogoloudloveluaulucklungmainmanymathmazememomenumeowmildmintmissmonknailnavyneednewsnextnoonnotenumbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolposepuffpumapurrquadquizraceramprealredorichroadrockroofrubyruinrunsrustsafesagascarsetssilkskewslotsoapsolosongstubsurfswantacotasktaxitenttiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuservastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebswhatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom";

/// CRC-32 (IEEE 802.3), the checksum bytewords and fountain parts carry.
///
/// Bitwise rather than table-driven: a frame is a few dozen bytes and the
/// message is checksummed once per frame, so a table would buy nothing.
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

/// Minimal bytewords: two letters per byte, with the CRC-32 appended.
pub fn bytewords_minimal(data: &[u8]) -> String {
    let checksum = crc32(data).to_be_bytes();
    data.iter()
        .chain(&checksum)
        .flat_map(|&byte| {
            let word = usize::from(byte) * 4;
            [char::from(BYTEWORDS[word]), char::from(BYTEWORDS[word + 3])]
        })
        .collect()
}

/// Reverse [`bytewords_minimal`], checking the CRC-32. Case-insensitive,
/// because a QR in alphanumeric mode carries it uppercase.
pub fn bytewords_minimal_decode(text: &str) -> Result<Vec<u8>> {
    let (pairs, odd) = text.as_bytes().as_chunks::<2>();
    if !odd.is_empty() {
        return Err(bytewords_error("an odd number of letters"));
    }
    let (words, _) = BYTEWORDS.as_chunks::<4>();
    let mut decoded = pairs
        .iter()
        .map(|[first, last]| {
            let (first, last) = (first.to_ascii_lowercase(), last.to_ascii_lowercase());
            words
                .iter()
                .position(|word| word[0] == first && word[3] == last)
                .and_then(|index| u8::try_from(index).ok())
                .ok_or_else(|| bytewords_error("a pair of letters that is not a byteword"))
        })
        .collect::<Result<Vec<u8>>>()?;
    if decoded.len() < 5 {
        return Err(bytewords_error("no room for a body and its checksum"));
    }
    let checksum = decoded.split_off(decoded.len() - 4);
    if checksum != crc32(&decoded).to_be_bytes() {
        return Err(bytewords_error("a checksum that does not match"));
    }
    Ok(decoded)
}

fn bytewords_error(what: &str) -> CliError {
    CliError::Usage(format!("not minimal bytewords: {what}"))
}

/// Xoshiro256**, seeded the way the reference fountain code seeds it: from
/// SHA-256 of the seed bytes, read as four big-endian words.
struct Xoshiro256 {
    state: [u64; 4],
}

impl Xoshiro256 {
    fn from_seed(seed: &[u8]) -> Self {
        let digest = Sha256::digest(seed);
        let mut state = [0u64; 4];
        let (words, _) = digest.as_chunks::<8>();
        for (word, bytes) in state.iter_mut().zip(words) {
            *word = u64::from_be_bytes(*bytes);
        }
        Self { state }
    }

    fn next_u64(&mut self) -> u64 {
        let s = &mut self.state;
        let result = s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = s[1] << 17;
        s[2] ^= s[0];
        s[3] ^= s[1];
        s[1] ^= s[2];
        s[0] ^= s[3];
        s[2] ^= t;
        s[3] = s[3].rotate_left(45);
        result
    }

    /// In [0, 1): the word converted to a double, then divided by 2^64.
    fn next_double(&mut self) -> f64 {
        self.next_u64() as f64 / 18_446_744_073_709_551_616.0
    }

    /// In `low..=high`. A word within 2^10 of the maximum rounds to 1.0 above,
    /// which would land one past `high`; the reference then reads out of
    /// bounds, and this stays on `high` instead.
    fn next_int(&mut self, low: usize, high: usize) -> usize {
        let span = (high - low + 1) as f64;
        ((self.next_double() * span + low as f64) as usize).min(high)
    }
}

/// Walker's alias method over the given weights, built in the reference
/// order so it draws the same outcome from the same generator.
struct AliasSampler {
    probabilities: Vec<f64>,
    aliases: Vec<usize>,
}

impl AliasSampler {
    fn new(weights: &[f64]) -> Self {
        let count = weights.len();
        let total: f64 = weights.iter().sum();
        let mut scaled: Vec<f64> = weights
            .iter()
            .map(|weight| weight * count as f64 / total)
            .collect();
        let (mut small, mut large) = (Vec::new(), Vec::new());
        for index in (0..count).rev() {
            if scaled[index] < 1.0 {
                small.push(index);
            } else {
                large.push(index);
            }
        }
        let mut probabilities = vec![0.0; count];
        let mut aliases = vec![0; count];
        while let (Some(&less), Some(&more)) = (small.last(), large.last()) {
            small.pop();
            large.pop();
            probabilities[less] = scaled[less];
            aliases[less] = more;
            scaled[more] = (scaled[more] + scaled[less]) - 1.0;
            if scaled[more] < 1.0 {
                small.push(more);
            } else {
                large.push(more);
            }
        }
        // Whatever is left has probability one. Leftover small entries only
        // happen through rounding.
        for index in large.into_iter().chain(small) {
            probabilities[index] = 1.0;
        }
        Self {
            probabilities,
            aliases,
        }
    }

    fn sample(&self, rng: &mut Xoshiro256) -> usize {
        let count = self.probabilities.len();
        let column = ((rng.next_double() * count as f64) as usize).min(count - 1);
        if rng.next_double() < self.probabilities[column] {
            column
        } else {
            self.aliases[column]
        }
    }
}

/// Which fragments part `seq_num` XORs together.
///
/// Parts 1..=`seq_len` are the fragments themselves, in order, so one pass of
/// the animation carries the whole message. Later parts mix a pseudo-random
/// subset that the decoder can rebuild from the sequence number and the
/// checksum, so a frame the camera missed in one pass is made up for by any
/// later one rather than only by its own repeat.
fn choose_fragments(seq_num: u32, seq_len: usize, checksum: u32) -> Vec<usize> {
    let seq = seq_num as usize;
    if (1..=seq_len).contains(&seq) {
        return vec![seq - 1];
    }
    let mut seed = [0u8; 8];
    seed[..4].copy_from_slice(&seq_num.to_be_bytes());
    seed[4..].copy_from_slice(&checksum.to_be_bytes());
    let mut rng = Xoshiro256::from_seed(&seed);
    let weights: Vec<f64> = (1..=seq_len).map(|degree| 1.0 / degree as f64).collect();
    let degree = AliasSampler::new(&weights).sample(&mut rng) + 1;
    let mut remaining: Vec<usize> = (0..seq_len).collect();
    let mut chosen = Vec::with_capacity(degree);
    while chosen.len() < degree {
        let index = rng.next_int(0, remaining.len() - 1);
        chosen.push(remaining.remove(index));
    }
    chosen
}

/// The fragment length the reference picks: the fewest equal fragments that
/// each fit in `max_len`.
fn nominal_fragment_len(message_len: usize, max_len: usize) -> usize {
    let max_count = message_len.div_ceil(UR_MIN_FRAGMENT_LEN);
    (1..=max_count)
        .map(|count| message_len.div_ceil(count))
        .find(|&len| len <= max_len)
        .unwrap_or(UR_MIN_FRAGMENT_LEN)
}

/// CBOR head: major type in the top three bits, shortest argument encoding.
fn cbor_head(out: &mut Vec<u8>, major: u8, value: u64) {
    let major = major << 5;
    match value {
        0..=23 => out.push(major | value as u8),
        24..=0xff => out.extend([major | 24, value as u8]),
        0x100..=0xffff => {
            out.push(major | 25);
            out.extend((value as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(major | 26);
            out.extend((value as u32).to_be_bytes());
        }
        _ => {
            out.push(major | 27);
            out.extend(value.to_be_bytes());
        }
    }
}

/// The `crypto-psbt` UR message: `psbt` as one CBOR byte string.
pub fn crypto_psbt_cbor(psbt: &[u8]) -> Vec<u8> {
    let mut cbor = Vec::with_capacity(psbt.len() + 9);
    cbor_head(&mut cbor, 2, psbt.len() as u64);
    cbor.extend_from_slice(psbt);
    cbor
}

/// A PSBT split for an animated `ur:crypto-psbt` QR.
#[derive(Debug, Clone)]
pub struct PsbtUr {
    /// The UR message: the PSBT wrapped by [`crypto_psbt_cbor`].
    message: Vec<u8>,
    fragment_len: usize,
    frame_count: u32,
    checksum: u32,
}

impl PsbtUr {
    /// Wrap `psbt` and split it into frames of at most `max_fragment_len`
    /// bytes.
    ///
    /// Refuses anything that is not a PSBT, and any fragment length outside
    /// [`UR_MIN_FRAGMENT_LEN`]..=[`PSBT_UR_MAX_FRAGMENT_LEN`].
    pub fn new(psbt: &[u8], max_fragment_len: usize) -> Result<Self> {
        if !psbt.starts_with(PSBT_MAGIC) {
            return Err(CliError::Usage(
                "only a PSBT can be shown to the signer, and this does not start with the PSBT magic"
                    .into(),
            ));
        }
        if !(UR_MIN_FRAGMENT_LEN..=PSBT_UR_MAX_FRAGMENT_LEN).contains(&max_fragment_len) {
            return Err(CliError::Usage(format!(
                "UR fragment length must be {UR_MIN_FRAGMENT_LEN} to {PSBT_UR_MAX_FRAGMENT_LEN} bytes, got {max_fragment_len}"
            )));
        }
        let message = crypto_psbt_cbor(psbt);
        let fragment_len = nominal_fragment_len(message.len(), max_fragment_len);
        let frame_count = u32::try_from(message.len().div_ceil(fragment_len))
            .map_err(|_| CliError::Usage("the PSBT is too large to animate".into()))?;
        Ok(Self {
            checksum: crc32(&message),
            message,
            fragment_len,
            frame_count,
        })
    }

    /// Frames in one pass of the animation. One means a single static QR,
    /// which only happens when the whole wrapped PSBT fits in one fragment.
    pub fn frame_count(&self) -> u32 {
        self.frame_count
    }

    /// Frame `seq_num`, counting from 1, uppercase for QR alphanumeric mode.
    ///
    /// The animation never runs out: after `frame_count` come mixed frames,
    /// each of which can stand in for any one the camera missed.
    pub fn frame(&self, seq_num: u32) -> Result<String> {
        if seq_num == 0 {
            return Err(CliError::Usage("UR frames are numbered from 1".into()));
        }
        let ur = if self.frame_count == 1 {
            format!("ur:{PSBT_UR_TYPE}/{}", bytewords_minimal(&self.message))
        } else {
            format!(
                "ur:{PSBT_UR_TYPE}/{seq_num}-{}/{}",
                self.frame_count,
                bytewords_minimal(&self.part_cbor(seq_num))
            )
        };
        Ok(ur.to_ascii_uppercase())
    }

    /// `[seqNum, seqLen, messageLen, checksum, fragment]` as CBOR.
    fn part_cbor(&self, seq_num: u32) -> Vec<u8> {
        let mut fragment = vec![0u8; self.fragment_len];
        for index in choose_fragments(seq_num, self.frame_count as usize, self.checksum) {
            let start = index * self.fragment_len;
            let end = (start + self.fragment_len).min(self.message.len());
            // The last fragment is zero-padded, which XOR leaves implicit.
            for (mixed, byte) in fragment.iter_mut().zip(&self.message[start..end]) {
                *mixed ^= byte;
            }
        }
        let mut cbor = Vec::with_capacity(self.fragment_len + 24);
        cbor_head(&mut cbor, 4, 5);
        cbor_head(&mut cbor, 0, u64::from(seq_num));
        cbor_head(&mut cbor, 0, u64::from(self.frame_count));
        cbor_head(&mut cbor, 0, self.message.len() as u64);
        cbor_head(&mut cbor, 0, u64::from(self.checksum));
        cbor_head(&mut cbor, 2, self.fragment_len as u64);
        cbor.extend(fragment);
        cbor
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vector {
        description: String,
        psbt_hex: String,
        max_fragment_length: usize,
        frame_count: u32,
        frames: Vec<String>,
    }

    #[derive(serde::Deserialize)]
    struct Vectors {
        vectors: Vec<Vector>,
    }

    fn vectors() -> Vec<Vector> {
        serde_json::from_str::<Vectors>(include_str!("../../../test-vectors/psbt-ur.json"))
            .expect("test-vectors/psbt-ur.json parses")
            .vectors
    }

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("vector hex"))
            .collect()
    }

    fn psbt_of(len: usize) -> Vec<u8> {
        let mut bytes: Vec<u8> = (0..len).map(|at| (at * 13 + 1) as u8).collect();
        bytes[..PSBT_MAGIC.len()].copy_from_slice(PSBT_MAGIC);
        bytes
    }

    #[test]
    fn every_frame_matches_the_independent_encoder_pure_and_mixed() {
        let vectors = vectors();
        assert!(!vectors.is_empty());
        for vector in vectors {
            let ur = PsbtUr::new(&hex(&vector.psbt_hex), vector.max_fragment_length)
                .unwrap_or_else(|error| panic!("{}: {error}", vector.description));
            assert_eq!(
                ur.frame_count(),
                vector.frame_count,
                "{}",
                vector.description
            );
            assert!(
                vector.frames.len() as u32 > vector.frame_count,
                "{} must reach the mixed frames",
                vector.description
            );
            for (at, expected) in vector.frames.iter().enumerate() {
                let seq_num = u32::try_from(at + 1).expect("small vector");
                assert_eq!(
                    &ur.frame(seq_num).expect("frame"),
                    expected,
                    "{} frame {seq_num}",
                    vector.description
                );
            }
        }
    }

    #[test]
    fn crc32_and_bytewords_match_the_published_examples() {
        // BCR-2020-012 and the reference test suite.
        assert_eq!(crc32(b"Hello, world!"), 0xebe6_c6e6);
        assert_eq!(crc32(b"Wolf"), 0x598c_84dc);
        let input = [0x00, 0x01, 0x02, 0x80, 0xff];
        assert_eq!(bytewords_minimal(&input), "aeadaolazmjendeoti");
        assert_eq!(
            bytewords_minimal_decode("AEADAOLAZMJENDEOTI").expect("decodes"),
            input
        );
    }

    #[test]
    fn bytewords_refuse_damage_instead_of_guessing() {
        assert!(
            bytewords_minimal_decode("aeadaolazmjendeotj").is_err(),
            "checksum"
        );
        assert!(
            bytewords_minimal_decode("aeadaolazmjendeot").is_err(),
            "odd length"
        );
        assert!(
            bytewords_minimal_decode("qqadaolazmjendeoti").is_err(),
            "not a word"
        );
        assert!(bytewords_minimal_decode("jendeoti").is_err(), "no body");
    }

    #[test]
    fn a_phone_sized_psbt_animates_instead_of_becoming_one_dense_qr() {
        // 1,200 bytes was one static QR of about 2,400 characters on phones.
        // Wrapped, it is a 1,203-byte message: 25 fragments of 49 bytes.
        let ur = PsbtUr::new(&psbt_of(1_200), PSBT_UR_DEFAULT_FRAGMENT_LEN).expect("encodes");
        assert_eq!(ur.frame_count(), 25);
        for seq_num in 1..=60 {
            let frame = ur.frame(seq_num).expect("frame");
            assert!(frame.starts_with(&format!("UR:CRYPTO-PSBT/{seq_num}-25/")));
            assert!(
                frame.len() < 160,
                "frame {seq_num} is {} characters",
                frame.len()
            );
        }
    }

    #[test]
    fn a_psbt_that_fits_one_fragment_is_a_single_part_ur() {
        let psbt = psbt_of(40);
        let ur = PsbtUr::new(&psbt, PSBT_UR_DEFAULT_FRAGMENT_LEN).expect("encodes");
        assert_eq!(ur.frame_count(), 1);
        let frame = ur.frame(1).expect("frame");
        assert_eq!(frame, ur.frame(7).expect("frame"), "a single part repeats");
        let body = frame
            .strip_prefix("UR:CRYPTO-PSBT/")
            .expect("single-part prefix");
        let message = bytewords_minimal_decode(body).expect("decodes");
        assert_eq!(message, crypto_psbt_cbor(&psbt));
        assert_eq!(
            crate::psbt::psbt_from_ur_cbor(&message).expect("unwraps"),
            psbt.as_slice()
        );
    }

    #[test]
    fn the_message_is_the_psbt_in_one_cbor_byte_string() {
        let psbt = psbt_of(120);
        let ur = PsbtUr::new(&psbt, PSBT_UR_DEFAULT_FRAGMENT_LEN).expect("encodes");
        let mut message = Vec::new();
        for seq_num in 1..=ur.frame_count() {
            let frame = ur.frame(seq_num).expect("frame");
            let body = frame.rsplit('/').next().expect("body");
            let part = bytewords_minimal_decode(body).expect("part bytewords");
            // The fragment is the byte string at the end of the part.
            message.extend(&part[part.len() - ur.fragment_len..]);
        }
        message.truncate(psbt.len() + 2);
        // SeedCash drops a message that is not exactly one byte string, which
        // is what the raw PSBT, starting with the text header 0x70, was.
        assert_eq!(&message[..2], &[0x58, 120]);
        assert_eq!(&message[2..], psbt.as_slice());
        assert_eq!(
            crate::psbt::psbt_from_ur_cbor(&message).expect("unwraps"),
            psbt.as_slice()
        );
    }

    #[test]
    fn the_byte_string_head_uses_the_shortest_length() {
        for (len, head) in [
            (5, vec![0x45]),
            (23, vec![0x57]),
            (24, vec![0x58, 24]),
            (255, vec![0x58, 0xff]),
            (256, vec![0x59, 0x01, 0x00]),
            (65_535, vec![0x59, 0xff, 0xff]),
            (65_536, vec![0x5a, 0x00, 0x01, 0x00, 0x00]),
        ] {
            let cbor = crypto_psbt_cbor(&psbt_of(len));
            assert_eq!(&cbor[..head.len()], head.as_slice(), "{len} bytes");
            assert_eq!(cbor.len(), head.len() + len);
            assert_eq!(
                crate::psbt::psbt_from_ur_cbor(&cbor)
                    .expect("unwraps")
                    .len(),
                len
            );
        }
    }

    #[test]
    fn only_a_psbt_at_a_scannable_density_is_accepted() {
        assert!(PsbtUr::new(b"", PSBT_UR_DEFAULT_FRAGMENT_LEN).is_err());
        assert!(
            PsbtUr::new(&[0x59, 0x01, 0x90, 0x70, 0x73], 50).is_err(),
            "a CBOR wrap"
        );
        let psbt = psbt_of(300);
        assert!(PsbtUr::new(&psbt, UR_MIN_FRAGMENT_LEN - 1).is_err());
        assert!(
            PsbtUr::new(&psbt, PSBT_UR_MAX_FRAGMENT_LEN + 1).is_err(),
            "the dense QR"
        );
        assert!(PsbtUr::new(&psbt, 2_400).is_err(), "the old static size");
        assert!(PsbtUr::new(&psbt, PSBT_UR_MAX_FRAGMENT_LEN).is_ok());
        let ur = PsbtUr::new(&psbt, PSBT_UR_DEFAULT_FRAGMENT_LEN).expect("encodes");
        assert!(ur.frame(0).is_err(), "frames count from 1");
    }

    #[test]
    fn mixed_frames_choose_distinct_fragments_within_range() {
        for seq_len in [2, 3, 7, 24, 48] {
            for seq_num in (seq_len as u32 + 1)..(seq_len as u32 + 200) {
                let chosen = choose_fragments(seq_num, seq_len, 0x1234_5678);
                assert!(!chosen.is_empty() && chosen.len() <= seq_len);
                assert!(chosen.iter().all(|&index| index < seq_len));
                let mut distinct = chosen.clone();
                distinct.sort_unstable();
                distinct.dedup();
                assert_eq!(distinct.len(), chosen.len(), "seq {seq_num} of {seq_len}");
            }
        }
    }
}
