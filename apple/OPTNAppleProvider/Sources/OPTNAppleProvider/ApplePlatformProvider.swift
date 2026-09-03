import Foundation
#if canImport(Security)
import Security
#endif

public enum AppleProviderCapability: String, CaseIterable, Codable, Sendable {
    case secureStorage
    case biometrics
    case qrScanner
    case notifications
    case deepLinks
    case nfcTagIo
    case nfcIso7816
    case contactlessPresentment
    case diagnostics
    case fulcrumReference
}

public enum AppleProviderRole: String, Codable, Sendable {
    case nativeCapability
    case referenceOracle
}

public enum AppleSecretMaterialPolicy: String, Codable, Sendable {
    case forbidden
    case opaqueStorageOnly
}

public struct AppleDeploymentFloor: Equatable, Codable, Sendable {
    public let macOSMajor: Int?
    public let iOSMajor: Int?

    public init(macOSMajor: Int? = nil, iOSMajor: Int? = nil) {
        self.macOSMajor = macOSMajor
        self.iOSMajor = iOSMajor
    }
}

public struct AppleProviderDescriptor: Equatable, Sendable {
    public let id: String
    public let role: AppleProviderRole
    public let capabilities: Set<AppleProviderCapability>
    public let deploymentFloor: AppleDeploymentFloor
    public let secretMaterialPolicy: AppleSecretMaterialPolicy

    public var ownsWalletState: Bool { false }

    public static func native(
        id: String,
        capabilities: Set<AppleProviderCapability>,
        deploymentFloor: AppleDeploymentFloor = .init(),
        secretMaterialPolicy: AppleSecretMaterialPolicy = .forbidden
    ) -> Self {
        Self(
            id: id,
            role: .nativeCapability,
            capabilities: capabilities,
            deploymentFloor: deploymentFloor,
            secretMaterialPolicy: secretMaterialPolicy
        )
    }

    public static func reference(
        id: String,
        capabilities: Set<AppleProviderCapability>,
        deploymentFloor: AppleDeploymentFloor
    ) -> Self {
        Self(
            id: id,
            role: .referenceOracle,
            capabilities: capabilities,
            deploymentFloor: deploymentFloor,
            secretMaterialPolicy: .forbidden
        )
    }
}

public protocol ApplePlatformProvider: Sendable {
    var descriptor: AppleProviderDescriptor { get }
}

public enum OPTNAppleDeployment {
    /// The committed Capacitor target in ios/App is iOS 14.0.
    public static let currentProductFloor = AppleDeploymentFloor(iOSMajor: 14)
    /// Current 58 Opals public packages require macOS/iOS 26.
    public static let currentOpalFloor = AppleDeploymentFloor(macOSMajor: 26, iOSMajor: 26)
}

public enum AppleDeploymentCompatibility {
    public static func supports(
        provider: AppleDeploymentFloor,
        on host: AppleDeploymentFloor
    ) -> Bool {
        if let required = provider.macOSMajor {
            guard let available = host.macOSMajor, available >= required else { return false }
        }
        if let required = provider.iOSMajor {
            guard let available = host.iOSMajor, available >= required else { return false }
        }
        return true
    }
}

#if canImport(Security)
public struct AppleKeychainError: Error, Equatable, Sendable {
    public let status: Int32

    public init(status: Int32) {
        self.status = status
    }
}

/// Thin Apple Keychain provider. It stores opaque bytes only: mnemonic parsing,
/// key derivation, signing policy, and wallet state remain authoritative in Rust.
public struct AppleKeychainSecureStorage: ApplePlatformProvider, Sendable {
    public let service: String

    public init(service: String) {
        self.service = service
    }

    public var descriptor: AppleProviderDescriptor {
        .native(
            id: "apple-keychain",
            capabilities: [.secureStorage],
            secretMaterialPolicy: .opaqueStorageOnly
        )
    }

    public func set(_ value: Data, forKey key: String) throws {
        let query = baseQuery(forKey: key)
        SecItemDelete(query as CFDictionary)

        var attributes = query
        attributes[kSecValueData as String] = value
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw AppleKeychainError(status: status)
        }
    }

    public func get(forKey key: String) throws -> Data? {
        var query = baseQuery(forKey: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw AppleKeychainError(status: status)
        }
        return item as? Data
    }

    public func delete(forKey key: String) throws {
        let status = SecItemDelete(baseQuery(forKey: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw AppleKeychainError(status: status)
        }
    }

    private func baseQuery(forKey key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }
}
#endif
