//! Shared bounded and atomic native network-configuration storage.
use optn_core::network::Network;
use optn_runtime::network_config::{
    decode_envelope_json, encode_envelope_json, export_portable_json, import_portable_json,
    NetworkConfigEnvelope, NetworkConfigStore, PortableNetworkConfig, SHIPPED_CATALOG_VERSION,
};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
const MAX_BYTES: u64 = 128 * 1024;
static TEMP_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct NetworkConfigFile {
    path: PathBuf,
}

impl NetworkConfigFile {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Export only the selected network's user overlay. The runtime codec
    /// excludes wallet secrets and machine-local SOCKS provenance.
    pub fn export_portable(&self, network: Network) -> Result<String, String> {
        let envelope = self.load()?.unwrap_or_else(|| {
            NetworkConfigEnvelope::current(SHIPPED_CATALOG_VERSION, Default::default())
        });
        let portable = PortableNetworkConfig::from_envelope(network, &envelope);
        let json = export_portable_json(&portable)
            .map_err(|error| format!("encode portable network config: {error:?}"))?;
        if json.len() as u64 > MAX_BYTES {
            return Err("portable network configuration is too large".into());
        }
        Ok(json)
    }

    /// Validate a network-bound portable overlay before taking the atomic
    /// read-modify-write lock. Existing local SOCKS confirmations remain
    /// local; an imported file can never establish provenance for a port on a
    /// different machine.
    pub fn import_portable(
        &self,
        network: Network,
        json: &str,
    ) -> Result<NetworkConfigEnvelope, String> {
        if json.len() as u64 > MAX_BYTES {
            return Err("portable network configuration is too large".into());
        }
        let portable = import_portable_json(json, network)
            .map_err(|error| format!("decode portable network config: {error:?}"))?;
        self.update(|existing| {
            let local_trust = existing
                .as_ref()
                .map(|value| value.overlay.trusted_socks_ports.clone())
                .unwrap_or_default();
            let mut envelope = portable.clone().into_envelope();
            envelope.overlay.trusted_socks_ports = local_trust;
            Ok(envelope)
        })
    }

    /// Serialize read-modify-write across hosts using a stable sidecar lock.
    /// Contention is reported so an interactive command never waits forever.
    pub fn update(
        &self,
        edit: impl FnOnce(Option<NetworkConfigEnvelope>) -> Result<NetworkConfigEnvelope, String>,
    ) -> Result<NetworkConfigEnvelope, String> {
        let _lock = lock_file(&self.path)
            .map_err(|error| format!("network settings are busy or cannot be locked: {error}"))?;
        let updated = edit(self.load()?)?;
        let bytes = encode_envelope_json(&updated)
            .map_err(|error| format!("encode network config: {error:?}"))?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("network configuration file is too large".into());
        }
        // Apply the same trust-boundary validation on writes and reads.
        decode_envelope_json(&bytes)
            .map_err(|error| format!("invalid network configuration: {error:?}"))?;
        write_atomically(&self.path, bytes.as_bytes()).map_err(|error| error.to_string())?;
        Ok(updated)
    }
}

impl NetworkConfigStore for NetworkConfigFile {
    fn load(&self) -> Result<Option<NetworkConfigEnvelope>, String> {
        let Some(bytes) = read_bounded(&self.path, MAX_BYTES)? else {
            return Ok(None);
        };
        decode_envelope_json(
            std::str::from_utf8(&bytes)
                .map_err(|_| "network configuration is not UTF-8".to_string())?,
        )
        .map(Some)
        .map_err(|error| format!("invalid network configuration: {error:?}"))
    }

    fn store_atomic(&self, value: &NetworkConfigEnvelope) -> Result<(), String> {
        self.update(|_| Ok(value.clone())).map(|_| ())
    }
}

/// Shared by every durable native store in this crate, so atomic write,
/// bounded read and the sidecar lock have one implementation rather than one
/// per file kind.
pub fn lock_file(path: &Path) -> io::Result<File> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "data directory is unavailable")
    })?;
    fs::create_dir_all(parent)?;
    let lock = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))?;
    lock.try_lock().map_err(io::Error::other)?;
    Ok(lock)
}

pub fn read_bounded(path: &Path, max: u64) -> Result<Option<Vec<u8>>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > max {
        return Err("data file is too large".into());
    }
    Ok(Some(bytes))
}

pub fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let directory = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "data directory is unavailable")
    })?;
    fs::create_dir_all(directory)?;
    let temporary = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use optn_runtime::chain::{
        CapabilitySet, ChainSource, ConnectionPolicy, Endpoint, EndpointKind, SourceDisposition,
        SourceId, SourceOrigin,
    };
    use optn_runtime::network_config::{NetworkConfigStore, UserNetworkOverlay};

    fn test_path(label: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "optn-network-config-portable-{label}-{}-{}",
                std::process::id(),
                TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ))
            .join("network-chipnet.json")
    }

    fn sample_envelope() -> NetworkConfigEnvelope {
        let source_id = SourceId::new("host:home.example");
        let source = ChainSource {
            id: source_id.clone(),
            label: "Home node".into(),
            origin: SourceOrigin::UserInfrastructure {
                group: "home-rack".into(),
            },
            endpoints: vec![Endpoint {
                kind: EndpointKind::ElectrumTls,
                host: "home.example".into(),
                port: Some(50002),
            }],
            capabilities: CapabilitySet::default(),
            disposition: SourceDisposition::Enabled,
            priority: 3,
        };
        let mut overlay = UserNetworkOverlay {
            user_sources: vec![source],
            ..Default::default()
        };
        overlay
            .bootstrap_overrides
            .insert(SourceId::new("bootstrap:bad"), SourceDisposition::Banned);
        overlay.connection_policy = ConnectionPolicy::own_infrastructure();
        overlay.connection_policy.preferred = vec![source_id];
        overlay.trusted_socks_ports = vec![9050];
        NetworkConfigEnvelope::current("test", overlay)
    }

    #[test]
    fn portable_file_round_trip_preserves_policy_bans_order_and_local_trust_only() {
        let path = test_path("round-trip");
        let file = NetworkConfigFile::new(path.clone());
        file.store_atomic(&sample_envelope()).unwrap();

        let exported = file.export_portable(Network::Chipnet).unwrap();
        assert!(exported.contains("\"network\": \"chipnet\""));
        assert!(!exported.contains("trusted_socks_ports"));
        assert!(!exported.contains("private_key"));
        assert!(!exported.contains("mnemonic"));

        let imported = file.import_portable(Network::Chipnet, &exported).unwrap();
        assert_eq!(
            imported.overlay.trusted_socks_ports,
            vec![9050],
            "existing machine-local trust may remain, but import cannot add trust"
        );
        assert_eq!(
            imported.overlay.user_sources[0].origin,
            SourceOrigin::UserInfrastructure {
                group: "home-rack".into()
            }
        );
        assert_eq!(
            imported
                .overlay
                .bootstrap_overrides
                .get(&SourceId::new("bootstrap:bad")),
            Some(&SourceDisposition::Banned)
        );
        assert_eq!(
            imported.overlay.connection_policy.preferred,
            vec![SourceId::new("host:home.example")]
        );

        let before_failed_import = fs::read(&path).unwrap();
        assert!(file.import_portable(Network::Mainnet, &exported).is_err());
        assert_eq!(fs::read(&path).unwrap(), before_failed_import);

        let mut injected: serde_json::Value = serde_json::from_str(&exported).unwrap();
        injected["overlay"]["trusted_socks_ports"] = serde_json::json!([9150]);
        let injected = serde_json::to_string(&injected).unwrap();
        assert!(file.import_portable(Network::Chipnet, &injected).is_err());
        assert_eq!(fs::read(&path).unwrap(), before_failed_import);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
