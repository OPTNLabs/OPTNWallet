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

    func testCoreNfcAdapterStaysOnIOS14AndNeverOwnsWalletState() {
        let provider = AppleCoreNfcTagIo()
        XCTAssertEqual(provider.descriptor.id, "apple-corenfc-tag-io")
        XCTAssertEqual(provider.descriptor.role, .nativeCapability)
        XCTAssertEqual(provider.descriptor.secretMaterialPolicy, .forbidden)
        XCTAssertEqual(provider.descriptor.deploymentFloor.iOSMajor, 14)
        XCTAssertFalse(provider.descriptor.ownsWalletState)
        XCTAssertTrue(provider.descriptor.capabilities.contains(.nfcTagIo))
        XCTAssertTrue(provider.descriptor.capabilities.contains(.nfcIso7816))
        XCTAssertThrowsError(try provider.read()) { error in
            XCTAssertEqual(error as? AppleNfcError, .unavailable)
        }
    }

    func testContactlessPresentmentIsNotTapToPayAndStaysUnavailableWithoutEntitlement() {
        let provider = AppleContactlessPresentment()
        XCTAssertEqual(provider.descriptor.id, "apple-nfc-se-presentment")
        XCTAssertFalse(provider.entitled)
        XCTAssertFalse(provider.descriptor.ownsWalletState)
        XCTAssertEqual(provider.descriptor.secretMaterialPolicy, .forbidden)
        XCTAssertThrowsError(try provider.present(credentialId: "chipnet-test")) { error in
            XCTAssertEqual(error as? AppleNfcError, .unavailable)
        }
        XCTAssertFalse(
            AppleDeploymentCompatibility.supports(
                provider: OPTNAppleDeployment.currentOpalFloor,
                on: provider.descriptor.deploymentFloor
            )
        )
    }
}

