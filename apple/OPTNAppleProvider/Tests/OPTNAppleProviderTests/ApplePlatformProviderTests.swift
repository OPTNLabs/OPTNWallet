import XCTest
@testable import OPTNAppleProvider

final class ApplePlatformProviderTests: XCTestCase {
    func testReferenceProvidersCannotOwnWalletStateOrObserveSecrets() {
        let descriptor = AppleProviderDescriptor.reference(
            id: "58opals-reference",
            capabilities: [.fulcrumReference, .diagnostics],
            deploymentFloor: OPTNAppleDeployment.currentOpalFloor
        )

        XCTAssertEqual(descriptor.role, .referenceOracle)
        XCTAssertEqual(descriptor.secretMaterialPolicy, .forbidden)
        XCTAssertFalse(descriptor.ownsWalletState)
    }

    func testCurrentOpalFloorDoesNotPretendToSupportCurrentIOS14ProductFloor() {
        XCTAssertFalse(
            AppleDeploymentCompatibility.supports(
                provider: OPTNAppleDeployment.currentOpalFloor,
                on: OPTNAppleDeployment.currentProductFloor
            )
        )
    }

    func testNativeOpaqueStorageStillDoesNotOwnWalletState() {
        let descriptor = AppleProviderDescriptor.native(
            id: "apple-keychain",
            capabilities: [.secureStorage],
            secretMaterialPolicy: .opaqueStorageOnly
        )

        XCTAssertEqual(descriptor.role, .nativeCapability)
        XCTAssertEqual(descriptor.secretMaterialPolicy, .opaqueStorageOnly)
        XCTAssertFalse(descriptor.ownsWalletState)
    }
}
