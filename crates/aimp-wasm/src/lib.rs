//! 256-bit SimHash for git-flare, compiled to WebAssembly for Cloudflare Workers.
//!
//! The platform hashes the canonical text of a change (src/epistemic/changeset.ts) and compares hashes by
//! Hamming distance to flag near-duplicate patches (threshold calibrated in
//! benchmarks/results/2026-10-02/simhash-calibration.json). Nothing else lives here: review aggregation,
//! collusion detection and gates are TypeScript.

use wasm_bindgen::prelude::*;

/// A 256-bit SimHash as four 64-bit words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SimHash(pub [u64; 4]);

impl SimHash {
    pub const ZERO: Self = Self([0; 4]);

    pub fn hamming_distance(&self, other: &Self) -> u32 {
        self.0.iter().zip(other.0.iter()).map(|(a, b)| (a ^ b).count_ones()).sum()
    }

    pub fn to_hex(&self) -> String {
        format!("{:016x}{:016x}{:016x}{:016x}", self.0[0], self.0[1], self.0[2], self.0[3])
    }

    pub fn from_hex(hex: &str) -> Result<Self, String> {
        let s = hex.trim().trim_start_matches("0x");
        if s.len() != 64 {
            return Err(format!("Expected 64 hex characters (256 bits), got {}", s.len()));
        }
        let mut words = [0u64; 4];
        for (i, word) in words.iter_mut().enumerate() {
            let chunk = &s[i * 16..(i + 1) * 16];
            *word = u64::from_str_radix(chunk, 16).map_err(|e| format!("Invalid hex chunk {}: {}", chunk, e))?;
        }
        Ok(Self(words))
    }
}

fn accumulate(v: &mut [i32; 256], hash: &blake3::Hash, weight: i32) {
    let bytes = hash.as_bytes();
    for (bit_idx, item) in v.iter_mut().enumerate() {
        if (bytes[bit_idx / 8] >> (bit_idx % 8)) & 1 == 1 {
            *item += weight;
        } else {
            *item -= weight;
        }
    }
}

/// SimHash of `text`: blake3 of every character 3-gram (whitespace removed, weight 2; strided above 65,536
/// characters) and of every trimmed non-empty line (weight 1); bit i is set when its weighted vote is positive.
pub fn compute_simhash(text: &str) -> SimHash {
    if text.trim().is_empty() {
        return SimHash::ZERO;
    }
    let mut v = [0i32; 256];
    let chars: Vec<char> = text.chars().filter(|c| !c.is_whitespace()).collect();
    if chars.len() >= 3 {
        let stride = if chars.len() > 65536 { chars.len() / 32768 } else { 1 };
        let mut buf = [0u8; 12];
        for window in chars.windows(3).step_by(stride) {
            let mut offset = 0;
            for &c in window {
                offset += c.encode_utf8(&mut buf[offset..]).len();
            }
            accumulate(&mut v, &blake3::hash(&buf[..offset]), 2);
        }
    }
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            accumulate(&mut v, &blake3::hash(trimmed.as_bytes()), 1);
        }
    }
    let mut words = [0u64; 4];
    for (bit_idx, &val) in v.iter().enumerate() {
        if val > 0 {
            words[bit_idx / 64] |= 1u64 << (bit_idx % 64);
        }
    }
    SimHash(words)
}

/// 64-character hex SimHash of `text`.
#[wasm_bindgen]
pub fn simhash_text(text: &str) -> String {
    compute_simhash(text).to_hex()
}

/// Hamming distance (0..=256) between two hex SimHashes.
#[wasm_bindgen]
pub fn simhash_hamming_distance(hex_a: &str, hex_b: &str) -> Result<u32, JsValue> {
    let a = SimHash::from_hex(hex_a).map_err(|e| JsValue::from_str(&e))?;
    let b = SimHash::from_hex(hex_b).map_err(|e| JsValue::from_str(&e))?;
    Ok(a.hamming_distance(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_text_has_distance_zero_and_unrelated_text_is_far() {
        let a = compute_simhash("+src/a.ts\texport const add = (a, b) => a + b;");
        let b = compute_simhash("+src/a.ts\texport const add = (a, b) => a + b;");
        let c = compute_simhash("-docs/readme.md\tA completely unrelated paragraph about something else.");
        assert_eq!(a.hamming_distance(&b), 0);
        assert!(a.hamming_distance(&c) > 64, "unrelated texts should be far apart");
    }

    #[test]
    fn empty_and_whitespace_hash_to_zero() {
        assert_eq!(compute_simhash(""), SimHash::ZERO);
        assert_eq!(compute_simhash(" \n\t "), SimHash::ZERO);
    }

    #[test]
    fn hex_round_trip_and_validation() {
        let h = compute_simhash("some change");
        assert_eq!(SimHash::from_hex(&h.to_hex()).unwrap(), h);
        assert!(SimHash::from_hex("abc").is_err());
        assert!(SimHash::from_hex(&"z".repeat(64)).is_err());
    }

    #[test]
    fn long_input_uses_the_strided_path_deterministically() {
        let long = "x".repeat(70_000);
        assert_eq!(compute_simhash(&long), compute_simhash(&long));
    }
}
