import XCTest
@testable import OPTNOpalReference

final class OpalReferenceProviderTests: XCTestCase {
    func testProviderIsReferenceOnlyAndSecretFree() {
        let descriptor = OpalReferenceProvider().descriptor

        XCTAssertEqual(descriptor.role, .referenceOracle)
        XCTAssertEqual(descriptor.secretMaterialPolicy, .forbidden)
        XCTAssertFalse(descriptor.ownsWalletState)
        XCTAssertEqual(descriptor.deploymentFloor.macOSMajor, 26)
        XCTAssertEqual(descriptor.deploymentFloor.iOSMajor, 26)
    }

    func testPinnedDependenciesAreActuallyImported() {
        XCTAssertTrue(OpalReferenceProvider.swiftFulcrumClientTypeName.contains("Client"))
        XCTAssertTrue(OpalReferenceProvider.diagnosticsLoggerTypeName.contains("Logger"))
    }
}
