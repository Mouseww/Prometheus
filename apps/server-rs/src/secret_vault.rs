use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;

use crate::error::AppError;

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

#[derive(Clone)]
pub struct SecretVault {
    key: [u8; KEY_LEN],
}

impl SecretVault {
    pub fn new(key: &[u8]) -> Result<Self, AppError> {
        if key.len() != KEY_LEN {
            return Err(AppError::configuration(
                "SecretVault requires a 32-byte key",
            ));
        }
        let mut bytes = [0_u8; KEY_LEN];
        bytes.copy_from_slice(key);
        Ok(Self { key: bytes })
    }

    pub fn from_base64(encoded: &str) -> Result<Self, AppError> {
        let key = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|error| {
                AppError::configuration(format!("Invalid master key encoding: {error}"))
            })?;
        if key.len() != KEY_LEN {
            return Err(AppError::configuration(
                "PROMETHEUS_MASTER_KEY must decode to exactly 32 bytes",
            ));
        }
        Self::new(&key)
    }

    pub fn encrypt(&self, plaintext: &str) -> Result<String, AppError> {
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|error| AppError::configuration(error.to_string()))?;
        let mut iv = [0_u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut iv);
        let nonce = Nonce::from_slice(&iv);
        let ciphertext = cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|error| AppError::configuration(format!("Encrypt failed: {error}")))?;
        // aes-gcm crate appends tag to ciphertext; Node stores tag separately.
        if ciphertext.len() < 16 {
            return Err(AppError::configuration("Encrypt produced invalid ciphertext"));
        }
        let (body, tag) = ciphertext.split_at(ciphertext.len() - 16);
        Ok(format!(
            "v1:{}:{}:{}",
            URL_SAFE_NO_PAD.encode(iv),
            URL_SAFE_NO_PAD.encode(tag),
            URL_SAFE_NO_PAD.encode(body)
        ))
    }

    pub fn decrypt(&self, envelope: &str) -> Result<String, AppError> {
        let mut parts = envelope.split(':');
        let version = parts.next().unwrap_or_default();
        let iv_value = parts.next().unwrap_or_default();
        let tag_value = parts.next().unwrap_or_default();
        let ciphertext_value = parts.next().unwrap_or_default();
        if version != "v1" || iv_value.is_empty() || tag_value.is_empty() || ciphertext_value.is_empty()
        {
            return Err(AppError::configuration("Invalid secret envelope"));
        }
        let iv = URL_SAFE_NO_PAD
            .decode(iv_value)
            .map_err(|_| AppError::configuration("Invalid secret envelope"))?;
        let tag = URL_SAFE_NO_PAD
            .decode(tag_value)
            .map_err(|_| AppError::configuration("Invalid secret envelope"))?;
        let body = URL_SAFE_NO_PAD
            .decode(ciphertext_value)
            .map_err(|_| AppError::configuration("Invalid secret envelope"))?;
        if iv.len() != NONCE_LEN || tag.len() != 16 {
            return Err(AppError::configuration("Invalid secret envelope"));
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|error| AppError::configuration(error.to_string()))?;
        let mut combined = body;
        combined.extend_from_slice(&tag);
        let nonce = Nonce::from_slice(&iv);
        let plaintext = cipher
            .decrypt(nonce, combined.as_ref())
            .map_err(|_| AppError::configuration("Decrypt failed"))?;
        String::from_utf8(plaintext)
            .map_err(|_| AppError::configuration("Decrypt produced invalid UTF-8"))
    }
}

#[cfg(test)]
mod tests {
    use super::SecretVault;

    #[test]
    fn round_trip_matches_envelope_shape() {
        let vault = SecretVault::new(&[7_u8; 32]).expect("key");
        let envelope = vault.encrypt("sk-test").expect("encrypt");
        let parts: Vec<_> = envelope.split(':').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0], "v1");
        assert_eq!(vault.decrypt(&envelope).expect("decrypt"), "sk-test");
    }
}
