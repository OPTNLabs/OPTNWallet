import Foundation
import os

/// Native Apple diagnostics. This is os_log, not OpalDiagnostics.
/// Callers must not pass seed, mnemonic, or private-key material.
public struct AppleOsLogDiagnostics: ApplePlatformProvider, Sendable {
    private let logger: Logger

    public init(subsystem: String = "cash.optn.wallet", category: String = "platform") {
        self.logger = Logger(subsystem: subsystem, category: category)
    }

    public var descriptor: AppleProviderDescriptor {
        .native(
            id: "apple-oslog-diagnostics",
            capabilities: [.diagnostics],
            deploymentFloor: .init(iOSMajor: 14),
            secretMaterialPolicy: .forbidden
        )
    }

    public func record(event: String) {
        logger.info("\(event, privacy: .public)")
    }
}
