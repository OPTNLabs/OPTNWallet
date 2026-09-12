import Foundation
#if canImport(Security)
import Security
#endif

/// Thin Secure Enclave availability adapter.
///
/// This foothold never accepts seed, mnemonic, or private-key bytes and never
/// generates production keys. Hosts that later create Secure Enclave keys must
/// keep signing policy in Rust.
public struct AppleSecureEnclave: ApplePlatformProvider, Sendable {
    public init() {}

    public var descriptor: AppleProviderDescriptor {
        .native(
            id: "apple-secure-enclave",
            capabilities: [.secureEnclave],
            deploymentFloor: .init(iOSMajor: 14),
            secretMaterialPolicy: .forbidden
        )
    }

    /// Reports whether Secure Enclave access-control APIs are linked.
    /// Simulator and CI hosts may still report true for the API and false for
    /// actual key generation; this adapter does not generate keys.
    public var isAvailable: Bool {
        #if canImport(Security)
        return SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .privateKeyUsage,
            nil
        ) != nil
        #else
        return false
        #endif
    }
}
