import Foundation
#if canImport(CoreNFC)
import CoreNFC
#endif

public enum AppleNfcTechnology: String, Codable, Sendable {
    case ndef
    case iso7816
    case iso15693
    case mifare
    case felica
}

public struct AppleNfcMessage: Equatable, Sendable {
    public let technology: AppleNfcTechnology
    public let payload: Data

    public init(technology: AppleNfcTechnology, payload: Data) {
        self.technology = technology
        self.payload = payload
    }
}

public enum AppleNfcError: Error, Equatable, Sendable {
    case unavailable
    case permissionDenied
    case cancelled
    case invalidData(String)
}

/// Thin CoreNFC tag I/O. NDEF/TAPSIGNER protocol and wallet payloads stay in Rust.
/// This foothold never fakes a tag: without a live CoreNFC session it returns unavailable.
public struct AppleCoreNfcTagIo: ApplePlatformProvider, Sendable {
    public init() {}

    public var descriptor: AppleProviderDescriptor {
        .native(
            id: "apple-corenfc-tag-io",
            capabilities: [.nfcTagIo, .nfcIso7816],
            deploymentFloor: .init(iOSMajor: 14),
            secretMaterialPolicy: .forbidden
        )
    }

    public var readingAvailable: Bool {
        #if canImport(CoreNFC)
        if #available(iOS 13.0, *) {
            return NFCReaderSession.readingAvailable
        }
        #endif
        return false
    }

    public func read() throws -> AppleNfcMessage {
        guard readingAvailable else { throw AppleNfcError.unavailable }
        // Host must drive a CoreNFC session; do not synthesize tag bytes here.
        throw AppleNfcError.unavailable
    }

    public func write(_ message: AppleNfcMessage) throws {
        _ = message
        guard readingAvailable else { throw AppleNfcError.unavailable }
        throw AppleNfcError.unavailable
    }

    public func transceive(commandAPDU: Data) throws -> Data {
        _ = commandAPDU
        guard readingAvailable else { throw AppleNfcError.unavailable }
        throw AppleNfcError.unavailable
    }
}

/// Phone-as-credential presentment. This is Apple NFC & SE Platform
/// (entitlement/agreement), not Tap to Pay on iPhone / ProximityReader.
public struct AppleContactlessPresentment: ApplePlatformProvider, Sendable {
    public init() {}

    public var descriptor: AppleProviderDescriptor {
        .native(
            id: "apple-nfc-se-presentment",
            capabilities: [.contactlessPresentment],
            deploymentFloor: .init(iOSMajor: 14),
            secretMaterialPolicy: .forbidden
        )
    }

    /// Production presentment requires Apple NFC & SE Platform entitlement.
    public var entitled: Bool { false }

    public func present(credentialId: String) throws {
        _ = credentialId
        throw AppleNfcError.unavailable
    }
}
