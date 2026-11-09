#[cfg(feature = "engine")]
pub mod commit;
#[cfg(feature = "engine")]
pub mod engine;
pub mod meter;
pub mod owned;
pub mod selection;

#[cfg(feature = "engine")]
pub mod repair;

#[cfg(feature = "engine")]
pub mod relocation;

#[cfg(feature = "engine")]
pub mod orphans;

/// Lowercase hex of a digest, as `{:x}` printed it before sha2 0.11.
pub fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}
