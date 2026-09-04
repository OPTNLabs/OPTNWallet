#![forbid(unsafe_code)]

//! Platform capability ports.
//!
//! Application/domain crates depend on these contracts rather than Tauri,
//! Capacitor, Dioxus, browser APIs, Swift, Kotlin, or any other shell.
//! Current adapters can use Tauri; future adapters can be swapped without
//! changing wallet/business logic.

use std::{future::Future, pin::Pin};

pub mod apple;

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

/// How a device can actually be talked to.
///
/// A Tauri WebView has no WebHID/WebUSB/WebBLE — USB is done natively in Rust
/// and the app protocol rides on top. A browser tab is the mirror image. So
/// "can I reach this device" is a property of the transport, not of the
/// device alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum HardwareTransport {
    /// Native USB/HID owned by the shell.
    NativeUsb,
    WebHid,
    WebUsb,
    /// Bluetooth Low Energy owned by the shell, as a phone app has.
    NativeBle,
    WebBle,
    /// Near-field, tap-to-sign. A phone thing; no desktop offers it.
    Nfc,
    /// Air-gapped animated QR (UR). No cable at all.
    Camera,
    /// Air-gapped by card: the device writes a file, the wallet reads it.
    ///
    /// Keystone's second air-gap channel, for anyone who would rather not hold
    /// a phone up to a screen. Air-gapped in the same sense the camera is --
    /// nothing is connected -- but it needs a card reader rather than a lens.
    MicroSd,
    /// Cross-origin vendor connect page.
    Iframe,
}

impl HardwareTransport {
    /// Whether this transport keeps the device disconnected.
    ///
    /// The two air-gap channels. A device reachable *only* by these is an
    /// air-gapped wallet and belongs in that section; one that merely offers
    /// them among others does not.
    pub const fn is_air_gapped(self) -> bool {
        matches!(self, Self::Camera | Self::MicroSd)
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::NativeUsb | Self::WebUsb => "USB",
            Self::WebHid => "USB (WebHID)",
            Self::NativeBle | Self::WebBle => "Bluetooth",
            Self::Nfc => "NFC",
            Self::Camera => "QR",
            Self::MicroSd => "microSD",
            Self::Iframe => "Vendor page",
        }
    }
}

/// What this runtime can actually offer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TransportSupport {
    pub native_usb: bool,
    pub web_hid: bool,
    pub web_usb: bool,
    pub native_ble: bool,
    pub web_ble: bool,
    pub nfc: bool,
    pub camera: bool,
    pub micro_sd: bool,
    pub iframe: bool,
}

impl TransportSupport {
    /// Nothing is reachable. The honest default for an unknown host.
    pub const NONE: Self = Self {
        native_usb: false,
        web_hid: false,
        web_usb: false,
        native_ble: false,
        web_ble: false,
        nfc: false,
        camera: false,
        micro_sd: false,
        iframe: false,
    };

    pub const fn provides(self, transport: HardwareTransport) -> bool {
        match transport {
            HardwareTransport::NativeUsb => self.native_usb,
            HardwareTransport::WebHid => self.web_hid,
            HardwareTransport::WebUsb => self.web_usb,
            HardwareTransport::NativeBle => self.native_ble,
            HardwareTransport::WebBle => self.web_ble,
            HardwareTransport::Nfc => self.nfc,
            HardwareTransport::MicroSd => self.micro_sd,
            HardwareTransport::Camera => self.camera,
            HardwareTransport::Iframe => self.iframe,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum HardwareVendor {
    Ledger,
    Trezor,
    OneKey,
    /// Air-gapped signer driven entirely by animated QR.
    Keystone,
    Mock,
}

impl HardwareVendor {
    /// Vendors onboarding offers, in the order they are listed.
    ///
    /// `Mock` is deliberately absent: it exists for tests and adapters without
    /// USB, and offering it in the product would let someone "connect" a
    /// signer that cannot hold a key.
    pub const OFFERED: &'static [Self] =
        &[Self::Ledger, Self::Trezor, Self::OneKey, Self::Keystone];

    /// The cabled devices. Keystone is excluded on purpose: it is air-gapped,
    /// and the React shell keeps it out of `HardwareDeviceKind` for the same
    /// reason — it is reached through the watch-only airgap panel, not a USB
    /// session.
    pub const USB_DEVICES: &'static [Self] = &[Self::Ledger, Self::Trezor, Self::OneKey];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Ledger => "Ledger",
            Self::Trezor => "Trezor",
            Self::OneKey => "OneKey",
            Self::Keystone => "Keystone",
            Self::Mock => "Mock signer",
        }
    }

    /// Stable identifier for wire encoding and test selectors.
    pub const fn id(self) -> &'static str {
        match self {
            Self::Ledger => "ledger",
            Self::Trezor => "trezor",
            Self::OneKey => "onekey",
            Self::Keystone => "keystone",
            Self::Mock => "mock",
        }
    }

    /// Inverse of [`id`](Self::id). Unknown ids are rejected rather than
    /// defaulted, so a newer peer's device cannot arrive decoded as a Ledger.
    pub fn from_id(id: &str) -> Option<Self> {
        [
            Self::Ledger,
            Self::Trezor,
            Self::OneKey,
            Self::Keystone,
            Self::Mock,
        ]
        .into_iter()
        .find(|vendor| vendor.id() == id)
    }

    /// Transports this device can be driven over, in preference order.
    ///
    /// What the *device* is capable of, before any platform is considered.
    /// What a user is actually offered is the intersection with what the
    /// runtime provides — see [`connection_methods`].
    ///
    /// Checked against vendor documentation rather than assumed, because
    /// offering a connection a device does not have sends someone to buy a
    /// cable that was never going to work.
    pub const fn transports(self) -> &'static [HardwareTransport] {
        match self {
            // Nano X adds Bluetooth to the USB every model has.
            Self::Ledger => &[
                HardwareTransport::NativeUsb,
                HardwareTransport::WebHid,
                HardwareTransport::NativeBle,
                HardwareTransport::WebBle,
            ],
            Self::Trezor => &[
                HardwareTransport::NativeUsb,
                HardwareTransport::WebUsb,
                HardwareTransport::NativeBle,
                HardwareTransport::Iframe,
            ],
            // "Bluetooth, USB, NFC, or QR codes", per OneKey's own
            // documentation. Air-gap is a *mode* that disables the other
            // three, not the only thing the device can do -- which is why it
            // belongs among hardware wallets rather than in the air-gap
            // section, and why it can be reached on a phone that has only NFC.
            Self::OneKey => &[
                HardwareTransport::NativeUsb,
                HardwareTransport::WebUsb,
                HardwareTransport::NativeBle,
                HardwareTransport::Nfc,
                HardwareTransport::Camera,
            ],
            // Air-gapped and nothing else. Its USB-C charges the battery and
            // flashes firmware; no transaction ever crosses it. QR is the
            // usual channel and microSD is the alternative for anyone who
            // would rather not hold a phone up to a screen.
            Self::Keystone => &[HardwareTransport::Camera, HardwareTransport::MicroSd],
            // The mock needs no transport; it is in-process.
            Self::Mock => &[],
        }
    }

    /// Whether every way to reach this device keeps it disconnected.
    ///
    /// A fact about transports, and useful for what a screen says -- "this
    /// device never connects" is worth telling someone. It is deliberately
    /// *not* what decides which section a device appears in; see
    /// [`Self::holds_firmware`].
    pub fn is_air_gapped_only(self) -> bool {
        !self.transports().is_empty()
            && self
                .transports()
                .iter()
                .all(|transport| transport.is_air_gapped())
    }

    /// Whether this is a device with its own firmware.
    ///
    /// **This is what separates a hardware wallet from a watch-only wallet**,
    /// and it is the only thing that does. Not the transport: Keystone signs
    /// only over QR and microSD and is still a hardware wallet, because it
    /// runs firmware, has a screen, and holds a seed. A seed signer hands over
    /// an xPub and holds no firmware, so it is a watch-only wallet however it
    /// delivers the key -- QR, a file, a card, or typed.
    ///
    /// Drawing the line at air-gap instead put Keystone and a seed signer in
    /// one section on the grounds that neither uses a cable, which is a
    /// resemblance rather than a likeness. The card made that obvious: both
    /// can hand you an SD card, and only one of them is a computer.
    pub const fn holds_firmware(self) -> bool {
        match self {
            Self::Ledger | Self::Trezor | Self::OneKey | Self::Keystone => true,
            // In-process test double. It is not a device at all.
            Self::Mock => false,
        }
    }

    /// Whether multisig with this device is offered up front.
    ///
    /// Never. Every vendor supports it and every vendor does it differently --
    /// Keystone documents its own flow -- and a cosigner set entered wrongly
    /// produces an address nobody can spend from. It belongs behind an
    /// advanced control on each device rather than beside "connect", where it
    /// would be picked by someone who wanted an ordinary wallet.
    pub const fn multisig_is_default(self) -> bool {
        false
    }

    /// The ways this device can be reached on this runtime, in preference
    /// order.
    ///
    /// The intersection, and the list a picker shows. It is not a property of
    /// the device or of the platform alone: a Trezor offers USB and Bluetooth
    /// on Android and Bluetooth only on iOS, because that is where the two
    /// lists overlap.
    pub fn connection_methods(self, support: TransportSupport) -> Vec<HardwareTransport> {
        self.transports()
            .iter()
            .copied()
            .filter(|&transport| support.provides(transport))
            .collect()
    }

    /// Whether this runtime can reach the device at all.
    pub fn is_reachable_with(self, support: TransportSupport) -> bool {
        match self {
            Self::Mock => true,
            _ => self
                .transports()
                .iter()
                .any(|&transport| support.provides(transport)),
        }
    }

    /// Why the device cannot be reached here, or `None` when it can.
    ///
    /// Phrased for a user who will otherwise blame their cable.
    pub fn unreachable_reason(self, support: TransportSupport) -> Option<&'static str> {
        if self.is_reachable_with(support) {
            return None;
        }
        if self.transports().contains(&HardwareTransport::Camera) {
            return Some("No camera is available, so QR-based signing cannot be used here.");
        }
        Some(
            "This build cannot reach USB hardware wallets. Use the desktop app, \
             or a browser with WebHID. It is not your cable or your device.",
        )
    }
}

/// Which wire a Ledger is on.
///
/// Ledger is the only vendor with a real choice here: a Nano X speaks
/// Bluetooth as well as USB, and the React wallet stores the preference per
/// wallet (`ledgerTransport`). Modelled as its own type rather than a bool so
/// a third option cannot arrive as "not USB".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LedgerLink {
    #[default]
    Usb,
    /// Nano X over Bluetooth.
    Bluetooth,
}

impl LedgerLink {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Usb => "USB",
            Self::Bluetooth => "Bluetooth",
        }
    }

    pub const fn transport(self) -> HardwareTransport {
        match self {
            Self::Usb => HardwareTransport::NativeUsb,
            Self::Bluetooth => HardwareTransport::WebBle,
        }
    }
}

/// A public account exported from a device at onboarding.
///
/// Public material only — an account xPub and the master fingerprint that
/// lets a later PSBT say which device owns an input. A hardware wallet never
/// yields a private key, so this is everything the wallet gets to keep.
///
/// The path is a plain string: this crate is a capability port and must not
/// depend on the domain crate that parses BIP44 paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HardwareAccount {
    pub vendor: HardwareVendor,
    pub account_path: String,
    pub account_xpub: String,
    /// Eight hex characters. Optional because not every device exports it.
    pub master_fingerprint: Option<String>,
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
    /// Export the public account at a BIP44 account path.
    ///
    /// This is the onboarding operation: the device is asked for one account's
    /// public key, and the wallet watches it. Requires a connected session so
    /// a caller cannot mistake a cached answer for a present device.
    fn export_account<'a>(
        &'a mut self,
        account_path: &'a str,
    ) -> PlatformFuture<'a, HardwareAccount>;
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
    /// What `export_account` answers with. Injected rather than hard-coded so
    /// a caller can supply a genuinely derived xPub without this crate taking
    /// a dependency on the derivation code.
    account_xpub: Option<String>,
}

impl MockHardwareWallet {
    pub fn new() -> Self {
        Self {
            session: None,
            account_xpub: None,
        }
    }

    /// Answer `export_account` with a caller-supplied account xPub.
    pub fn with_account_xpub(mut self, xpub: impl Into<String>) -> Self {
        self.account_xpub = Some(xpub.into());
        self
    }

    /// Fingerprint the mock reports. Fixed so a test can assert on it.
    pub const MOCK_FINGERPRINT: &'static str = "0f0f0f0f";

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

    fn export_account<'a>(
        &'a mut self,
        account_path: &'a str,
    ) -> PlatformFuture<'a, HardwareAccount> {
        let attached = self.session;
        let xpub = self.account_xpub.clone();
        let account_path = account_path.to_owned();
        Box::pin(async move {
            let Some(vendor) = attached else {
                return Err(PlatformError::Unavailable);
            };
            // No injected key means the caller wired the mock up without
            // deciding what it should answer; that is a setup bug, not an
            // empty account.
            let account_xpub = xpub.ok_or_else(|| {
                PlatformError::InvalidData("mock has no account xPub configured".into())
            })?;
            Ok(HardwareAccount {
                vendor,
                account_path,
                account_xpub,
                master_fingerprint: Some(Self::MOCK_FINGERPRINT.to_string()),
            })
        })
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

    #[test]
    fn exporting_an_account_requires_a_connected_device() {
        // A cached answer returned with no device attached would let
        // onboarding open a "hardware" wallet nothing is actually behind.
        let mut device = MockHardwareWallet::new().with_account_xpub("xpub-under-test");
        assert_eq!(
            ready(device.export_account("m/44'/145'/0'")),
            Err(PlatformError::Unavailable)
        );

        ready(device.connect()).expect("mock connects");
        let account =
            ready(device.export_account("m/44'/145'/0'")).expect("connected mock exports");
        assert_eq!(
            account,
            HardwareAccount {
                vendor: HardwareVendor::Mock,
                account_path: "m/44'/145'/0'".to_string(),
                account_xpub: "xpub-under-test".to_string(),
                master_fingerprint: Some(MockHardwareWallet::MOCK_FINGERPRINT.to_string()),
            }
        );

        // The path is echoed, not fixed: asking for a different account must
        // not silently return account zero.
        let second = ready(device.export_account("m/44'/145'/1'")).expect("second account");
        assert_eq!(second.account_path, "m/44'/145'/1'");

        ready(device.disconnect()).expect("mock disconnects");
        assert_eq!(
            ready(device.export_account("m/44'/145'/0'")),
            Err(PlatformError::Unavailable),
            "a disconnected device must stop answering"
        );
    }

    #[test]
    fn an_unconfigured_mock_reports_setup_error_not_an_empty_account() {
        let mut device = MockHardwareWallet::new();
        ready(device.connect()).expect("mock connects");
        match ready(device.export_account("m/44'/145'/0'")) {
            Err(PlatformError::InvalidData(message)) => {
                assert!(message.contains("xPub"), "unexpected message: {message}");
            }
            other => panic!("expected a setup error, got {other:?}"),
        }
    }

    #[test]
    fn only_real_vendors_are_offered_for_onboarding() {
        // Offering Mock in the product would let someone "connect" a signer
        // that holds no key.
        assert_eq!(
            HardwareVendor::OFFERED,
            &[
                HardwareVendor::Ledger,
                HardwareVendor::Trezor,
                HardwareVendor::OneKey,
                HardwareVendor::Keystone
            ]
        );
        assert!(!HardwareVendor::OFFERED.contains(&HardwareVendor::Mock));

        let ids: Vec<&str> = HardwareVendor::OFFERED.iter().map(|v| v.id()).collect();
        assert_eq!(ids, vec!["ledger", "trezor", "onekey", "keystone"]);
        for vendor in HardwareVendor::OFFERED {
            assert!(!vendor.label().is_empty());
        }

        // Keystone is offered, but it is not a cabled device: the React shell
        // keeps it out of HardwareDeviceKind and reaches it through the
        // watch-only airgap panel instead.
        assert!(!HardwareVendor::USB_DEVICES.contains(&HardwareVendor::Keystone));
        assert_eq!(
            HardwareVendor::USB_DEVICES,
            &[
                HardwareVendor::Ledger,
                HardwareVendor::Trezor,
                HardwareVendor::OneKey
            ]
        );
    }

    #[test]
    fn reachability_follows_the_transport_not_the_platform() {
        // A desktop shell owns USB but has no WebHID inside its WebView.
        let desktop = TransportSupport {
            native_usb: true,
            camera: true,
            iframe: true,
            ..TransportSupport::NONE
        };
        for vendor in HardwareVendor::OFFERED {
            assert!(
                vendor.is_reachable_with(desktop),
                "{vendor:?} should be reachable on desktop"
            );
            assert_eq!(vendor.unreachable_reason(desktop), None);
        }

        // A camera and nothing else. Keystone is air-gapped so it works, and
        // so does OneKey -- it can sign over QR as well as over a cable, which
        // is exactly why it is not in the air-gap section. Treating "hardware"
        // as one desktop-only switch would wrongly hide both.
        let camera_only = TransportSupport {
            camera: true,
            ..TransportSupport::NONE
        };
        assert!(HardwareVendor::Keystone.is_reachable_with(camera_only));
        assert!(
            HardwareVendor::OneKey.is_reachable_with(camera_only),
            "OneKey signs over QR too"
        );

        // The genuinely cable-or-radio-only devices do not, and say so.
        for vendor in [HardwareVendor::Ledger, HardwareVendor::Trezor] {
            assert!(!vendor.is_reachable_with(camera_only), "{vendor:?}");
            assert!(vendor
                .unreachable_reason(camera_only)
                .is_some_and(|reason| reason.contains("not your cable")));
        }

        // No camera: say so, instead of blaming the device.
        assert!(HardwareVendor::Keystone
            .unreachable_reason(TransportSupport::NONE)
            .is_some_and(|reason| reason.contains("camera")));

        // A browser with WebHID reaches a Ledger without any native USB.
        let browser = TransportSupport {
            web_hid: true,
            camera: true,
            iframe: true,
            ..TransportSupport::NONE
        };
        assert!(HardwareVendor::Ledger.is_reachable_with(browser));
        assert!(HardwareVendor::Trezor.is_reachable_with(browser));
    }

    #[test]
    fn a_vendor_id_round_trips_and_an_unknown_one_is_refused() {
        for vendor in [
            HardwareVendor::Ledger,
            HardwareVendor::Trezor,
            HardwareVendor::OneKey,
            HardwareVendor::Keystone,
            HardwareVendor::Mock,
        ] {
            assert_eq!(HardwareVendor::from_id(vendor.id()), Some(vendor));
        }
        // Defaulting an unknown id would decode a device this build does not
        // support as one it does.
        assert_eq!(
            HardwareVendor::from_id("keystone"),
            Some(HardwareVendor::Keystone)
        );
        assert_eq!(HardwareVendor::from_id("coldcard"), None);
        assert_eq!(HardwareVendor::from_id(""), None);
        assert_eq!(HardwareVendor::from_id("Ledger"), None);
    }
}
