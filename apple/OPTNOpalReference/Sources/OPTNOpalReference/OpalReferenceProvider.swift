#if !OPAL_APPLE26_REFERENCE
#error("OPTNOpalReference is the Apple 26 gated flavor and must be built with OPAL_APPLE26_REFERENCE")
#endif

import OPTNAppleProvider
import OpalDiagnostics
import SwiftFulcrum

/// Optional Apple-only reference provider. It deliberately exposes no wallet,
/// key, signing, transaction-authoring, or persistence authority.
public struct OpalReferenceProvider: ApplePlatformProvider, Sendable {
    public init() {}

    public var descriptor: AppleProviderDescriptor {
        .reference(
            id: "58opals-swiftfulcrum-v0.8.0",
            capabilities: [.fulcrumReference, .diagnostics],
            deploymentFloor: OPTNAppleDeployment.currentOpalFloor
        )
    }

    /// Compile-time linkage proof for CI without creating a second network or
    /// wallet state model inside OPTN.
    public static var swiftFulcrumClientTypeName: String {
        String(reflecting: SwiftFulcrum.Client.self)
    }

    public static var diagnosticsLoggerTypeName: String {
        String(reflecting: OpalDiagnostics.Logger.self)
    }
}
