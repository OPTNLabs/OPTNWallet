#![forbid(unsafe_code)]

//! Platform capability ports.
//!
//! Application/domain crates depend on these contracts rather than Tauri,
//! Capacitor, Dioxus, browser APIs, Swift, Kotlin, or any other shell.
//! Current adapters can use Tauri; future adapters can be swapped without
//! changing wallet/business logic.

use std::{future::Future, pin::Pin};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Capability {
    SecureStorage,
    Biometrics,
    QrScanner,
    Clipboard,
    Notifications,
    FileSystem,
    DeepLinks,
    HardwareWallet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    /// Standalone Rust implementation with no shell dependency.
    PureRust,
    /// Implementation supplied through the current application shell.
    Shell,
    /// Thin direct bridge to Android/iOS/desktop native APIs.
    NativeFfi,
    /// Browser/WASM host implementation.
    Web,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderDescriptor {
    pub id: &'static str,
    pub kind: ProviderKind,
    pub capabilities: &'static [Capability],
}

/// Metadata shared by all capability providers.
///
/// Business/application code depends on the capability traits below, not on
/// this metadata. Hosts use descriptors to select and diagnose providers.
pub trait CapabilityProvider {
    fn descriptor(&self) -> ProviderDescriptor;
}

pub type PlatformResult<T> = Result<T, PlatformError>;
pub type PlatformFuture<'a, T> = Pin<Box<dyn Future<Output = PlatformResult<T>> + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlatformError {
    Unavailable,
    PermissionDenied,
    Cancelled,
    InvalidData(String),
    Io(String),
    Other(String),
}

pub trait SecureStorage {
    fn get<'a>(&'a self, key: &'a str) -> PlatformFuture<'a, Option<Vec<u8>>>;
    fn set<'a>(&'a self, key: &'a str, value: &'a [u8]) -> PlatformFuture<'a, ()>;
    fn delete<'a>(&'a self, key: &'a str) -> PlatformFuture<'a, ()>;
}

pub trait Biometrics {
    fn authenticate<'a>(&'a self, reason: &'a str) -> PlatformFuture<'a, ()>;
}

pub trait QrScanner {
    fn scan<'a>(&'a self) -> PlatformFuture<'a, String>;
}

pub trait Clipboard {
    fn read_text<'a>(&'a self) -> PlatformFuture<'a, String>;
    fn write_text<'a>(&'a self, value: &'a str) -> PlatformFuture<'a, ()>;
}

pub trait Notifications {
    fn notify<'a>(&'a self, title: &'a str, body: &'a str) -> PlatformFuture<'a, ()>;
}

pub trait FileSystem {
    fn read<'a>(&'a self, path: &'a str) -> PlatformFuture<'a, Vec<u8>>;
    fn write<'a>(&'a self, path: &'a str, bytes: &'a [u8]) -> PlatformFuture<'a, ()>;
}

pub trait DeepLinks {
    fn initial_url<'a>(&'a self) -> PlatformFuture<'a, Option<String>>;
}

/// Raw APDU/HID exchange. Adapters own USB; application code should prefer
/// [`HardwareSession`] so it only sees typed device events.
pub trait HardwareWallet {
    fn exchange<'a>(&'a self, request: &'a [u8]) -> PlatformFuture<'a, Vec<u8>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HardwareVendor {
    Ledger,
    Trezor,
    OneKey,
    Mock,
}

/// Events the UI/application layer is allowed to observe. No HID/WebUSB.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HardwareEvent {
    DeviceDetected {
        vendor: HardwareVendor,
        label: String,
    },
    DeviceDisconnected {
        vendor: HardwareVendor,
    },
    SigningRequested {
        digest: [u8; 32],
    },
    SignatureReceived {
        signature: Vec<u8>,
    },
}

/// High-level session: connect, sign a digest, disconnect.
///
/// Physical Ledger/Trezor/OneKey adapters implement this on top of
/// [`HardwareWallet::exchange`]. Tests use an in-process mock.
pub trait HardwareSession {
    fn connect<'a>(&'a mut self) -> PlatformFuture<'a, HardwareEvent>;
    fn sign_digest<'a>(
        &'a mut self,
        digest: &'a [u8; 32],
    ) -> PlatformFuture<'a, Vec<HardwareEvent>>;
    fn disconnect<'a>(&'a mut self) -> PlatformFuture<'a, HardwareEvent>;
}

/// In-process signer for tests and adapters that do not have USB.
///
/// The mock "signature" is `digest || 0x01{32}` so callers can check the
/// digest was the payload that was signed, without a device.
#[derive(Debug, Default)]
pub struct MockHardwareWallet {
    /// `None` means no device in this session. Not a nullable pointer.
    session: Option<HardwareVendor>,
}

impl MockHardwareWallet {
    pub fn new() -> Self {
        Self { session: None }
    }

    pub fn attached_vendor(&self) -> Option<HardwareVendor> {
        self.session
    }

    pub fn mock_signature(digest: &[u8; 32]) -> Vec<u8> {
        let mut signature = Vec::with_capacity(64);
        signature.extend_from_slice(digest);
        signature.extend_from_slice(&[0x01; 32]);
        signature
    }
}

impl CapabilityProvider for MockHardwareWallet {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: "mock-hardware-wallet",
            kind: ProviderKind::PureRust,
            capabilities: &[Capability::HardwareWallet],
        }
    }
}

impl HardwareWallet for MockHardwareWallet {
    fn exchange<'a>(&'a self, request: &'a [u8]) -> PlatformFuture<'a, Vec<u8>> {
        let attached = self.session;
        let request = request.to_vec();
        Box::pin(async move {
            match attached {
                Some(_) => {
                    let mut response = request;
                    response.extend_from_slice(&[0x90, 0x00]);
                    Ok(response)
                }
                None => Err(PlatformError::Unavailable),
            }
        })
    }
}

impl HardwareSession for MockHardwareWallet {
    fn connect<'a>(&'a mut self) -> PlatformFuture<'a, HardwareEvent> {
        self.session = Some(HardwareVendor::Mock);
        Box::pin(std::future::ready(Ok(HardwareEvent::DeviceDetected {
            vendor: HardwareVendor::Mock,
            label: "OPTN mock signer".to_string(),
        })))
    }

    fn sign_digest<'a>(
        &'a mut self,
        digest: &'a [u8; 32],
    ) -> PlatformFuture<'a, Vec<HardwareEvent>> {
        let digest = *digest;
        let attached = self.session;
        Box::pin(async move {
            match attached {
                Some(_) => Ok(vec![
                    HardwareEvent::SigningRequested { digest },
                    HardwareEvent::SignatureReceived {
                        signature: MockHardwareWallet::mock_signature(&digest),
                    },
                ]),
                None => Err(PlatformError::Unavailable),
            }
        })
    }

    fn disconnect<'a>(&'a mut self) -> PlatformFuture<'a, HardwareEvent> {
        Box::pin(std::future::ready(match self.session.take() {
            Some(vendor) => Ok(HardwareEvent::DeviceDisconnected { vendor }),
            None => Err(PlatformError::Unavailable),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ExampleProvider;

    impl CapabilityProvider for ExampleProvider {
        fn descriptor(&self) -> ProviderDescriptor {
            ProviderDescriptor {
                id: "example",
                kind: ProviderKind::PureRust,
                capabilities: &[Capability::Clipboard],
            }
        }
    }

    #[test]
    fn provider_metadata_is_independent_from_capability_contracts() {
        let descriptor = ExampleProvider.descriptor();
        assert_eq!(descriptor.id, "example");
        assert_eq!(descriptor.kind, ProviderKind::PureRust);
        assert_eq!(descriptor.capabilities, &[Capability::Clipboard]);
    }

    fn ready<T>(fut: PlatformFuture<'_, T>) -> PlatformResult<T> {
        let mut fut = std::pin::pin!(fut);
        let waker = std::task::Waker::noop();
        let mut cx = std::task::Context::from_waker(waker);
        match fut.as_mut().poll(&mut cx) {
            std::task::Poll::Ready(value) => value,
            std::task::Poll::Pending => panic!("mock platform futures must be ready"),
        }
    }

    #[test]
    fn mock_hardware_session_completes_a_sign_round_trip() {
        let mut device = MockHardwareWallet::new();
        assert_eq!(
            device.descriptor().capabilities,
            &[Capability::HardwareWallet]
        );
        assert_eq!(
            ready(device.exchange(&[0x01])),
            Err(PlatformError::Unavailable)
        );
        match device.attached_vendor() {
            None => {}
            Some(vendor) => panic!("expected no session, found {vendor:?}"),
        }

        assert_eq!(
            ready(device.connect()),
            Ok(HardwareEvent::DeviceDetected {
                vendor: HardwareVendor::Mock,
                label: "OPTN mock signer".to_string(),
            })
        );

        let digest = [0xab; 32];
        let events = ready(device.sign_digest(&digest)).expect("connected mock must sign");
        assert_eq!(
            events,
            vec![
                HardwareEvent::SigningRequested { digest },
                HardwareEvent::SignatureReceived {
                    signature: MockHardwareWallet::mock_signature(&digest),
                },
            ]
        );

        let apdu = ready(device.exchange(&[0xe0, 0x40])).expect("connected mock exchanges");
        assert_eq!(apdu, vec![0xe0, 0x40, 0x90, 0x00]);

        assert_eq!(
            ready(device.disconnect()),
            Ok(HardwareEvent::DeviceDisconnected {
                vendor: HardwareVendor::Mock,
            })
        );
        assert_eq!(
            ready(device.sign_digest(&digest)),
            Err(PlatformError::Unavailable)
        );
        assert_eq!(device.attached_vendor(), None);
        assert_eq!(ready(device.disconnect()), Err(PlatformError::Unavailable));
    }
}
