mod apple;
mod history;
mod parity;

use std::{
    env, fs,
    path::{Path, PathBuf},
};

const FRAMEWORK_NAMES: &[&str] = &["leptos", "tauri", "dioxus", "capacitor"];
const APPLE_REFERENCE_DEPENDENCIES: &[&str] = &[
    "opalbase",
    "opalcrypto",
    "opalfusion",
    "opalhedge",
    "opaldiagnostics",
    "swiftfulcrum",
];

fn main() {
    let command = env::args().nth(1).unwrap_or_else(|| "architecture".into());
    match command.as_str() {
        "architecture" => architecture(),
        "parity" => {
            let production_ready = env::args().any(|arg| arg == "--production-ready");
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("xtask must live below workspace root")
                .to_path_buf();
            parity::run(&root, production_ready);
        }
        other => {
            eprintln!("unknown xtask '{other}'");
            std::process::exit(2);
        }
    }
}

fn architecture() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask must live below workspace root")
        .to_path_buf();

    let neutral_manifests = [
        root.join("crates/optn-core/Cargo.toml"),
        root.join("crates/optn-app/Cargo.toml"),
        root.join("crates/optn-platform/Cargo.toml"),
        root.join("crates/optn-platform-native/Cargo.toml"),
        root.join("crates/optn-platform-apple/Cargo.toml"),
        root.join("crates/optn-runtime/Cargo.toml"),
        root.join("crates/optn-transport/Cargo.toml"),
    ];

    let mut failures = Vec::new();
    history::check(&root, &mut failures);
    for manifest in neutral_manifests {
        let text = read(&manifest).to_lowercase();
        for framework in FRAMEWORK_NAMES {
            if text.contains(framework) {
                failures.push(format!(
                    "{} contains forbidden framework dependency '{framework}'",
                    manifest.display()
                ));
            }
        }
    }

    // Apple-native/reference packages are adapters only. They must never become
    // dependencies of the Rust wallet/application/runtime authority.
    for manifest in [
        root.join("crates/optn-core/Cargo.toml"),
        root.join("crates/optn-app/Cargo.toml"),
        root.join("crates/optn-runtime/Cargo.toml"),
    ] {
        let text = read(&manifest).to_lowercase();
        for dependency in APPLE_REFERENCE_DEPENDENCIES {
            if text.contains(dependency) {
                failures.push(format!(
                    "{} contains forbidden Apple reference dependency '{dependency}'",
                    manifest.display()
                ));
            }
        }
    }

    let apple_native_manifest = read(&root.join("apple/OPTNAppleProvider/Package.swift"));
    let apple_native_lower = apple_native_manifest.to_lowercase();
    for dependency in APPLE_REFERENCE_DEPENDENCIES {
        if apple_native_lower.contains(dependency) {
            failures.push(format!(
                "apple/OPTNAppleProvider must stay native-only; found '{dependency}'"
            ));
        }
    }

    let opal_reference_manifest = read(&root.join("apple/OPTNOpalReference/Package.swift"));
    for required in [
        "611a53f2047660e0dd221f75526ce11335be901a",
        "8c42eeb40d64776789e70694e4e5006d2afa400c",
        ".macOS(.v26)",
        ".iOS(.v26)",
    ] {
        if !opal_reference_manifest.contains(required) {
            failures.push(format!(
                "apple/OPTNOpalReference is missing required pinned/gated value '{required}'"
            ));
        }
    }
    for forbidden in ["OpalBase", "OpalCrypto", "OpalFusion", "OpalHedge"] {
        if opal_reference_manifest.contains(forbidden) {
            failures.push(format!(
                "apple/OPTNOpalReference must not link preview/secret-authority package '{forbidden}'"
            ));
        }
    }
    if opal_reference_manifest.contains("branch:") {
        failures
            .push("apple/OPTNOpalReference must not consume moving develop branches".to_string());
    }
    if !opal_reference_manifest.contains("OPAL_APPLE26_REFERENCE") {
        failures.push(
            "apple/OPTNOpalReference must isolate the Apple26 flavor behind OPAL_APPLE26_REFERENCE"
                .to_string(),
        );
    }

    // Opal packages must not appear in wallet/application/runtime authority,
    // including source — not only Cargo.toml.
    for crate_name in ["optn-core", "optn-app", "optn-runtime"] {
        let crate_dir = root.join("crates").join(crate_name);
        for path in walk_files(&crate_dir) {
            let is_rust_or_toml = path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext == "rs" || ext == "toml");
            if !is_rust_or_toml {
                continue;
            }
            let text = read(&path).to_lowercase();
            for dependency in APPLE_REFERENCE_DEPENDENCIES {
                if text.contains(dependency) {
                    failures.push(format!(
                        "{} contains forbidden Apple/Opal name '{dependency}'",
                        path.display()
                    ));
                }
            }
        }
    }

    let ui_manifest = read(&root.join("crates/optn-ui/Cargo.toml"));
    require_dependency("crates/optn-ui", &ui_manifest, "optn-app", &mut failures);
    require_dependency(
        "crates/optn-ui",
        &ui_manifest,
        "optn-transport",
        &mut failures,
    );
    forbid_dependencies(
        "crates/optn-ui",
        &ui_manifest,
        &[
            "optn-core",
            "optn-runtime",
            "optn-platform",
            "optn-platform-native",
        ],
        &mut failures,
    );

    let transport_manifest = read(&root.join("crates/optn-transport/Cargo.toml"));
    require_dependency(
        "crates/optn-transport",
        &transport_manifest,
        "optn-app",
        &mut failures,
    );
    forbid_dependencies(
        "crates/optn-transport",
        &transport_manifest,
        &[
            "optn-runtime",
            "optn-platform",
            "optn-platform-native",
            "optn-ui",
        ],
        &mut failures,
    );

    let runtime_manifest = read(&root.join("crates/optn-runtime/Cargo.toml"));
    require_dependency(
        "crates/optn-runtime",
        &runtime_manifest,
        "optn-app",
        &mut failures,
    );
    require_dependency(
        "crates/optn-runtime",
        &runtime_manifest,
        "optn-transport",
        &mut failures,
    );
    forbid_dependencies(
        "crates/optn-runtime",
        &runtime_manifest,
        &["optn-ui", "optn-platform-native"],
        &mut failures,
    );

    let native_manifest = read(&root.join("crates/optn-platform-native/Cargo.toml"));
    require_dependency(
        "crates/optn-platform-native",
        &native_manifest,
        "optn-platform",
        &mut failures,
    );
    forbid_dependencies(
        "crates/optn-platform-native",
        &native_manifest,
        &["optn-app", "optn-transport", "optn-runtime", "optn-ui"],
        &mut failures,
    );

    let app_manifest = read(&root.join("crates/optn-app/Cargo.toml"));
    forbid_dependencies(
        "crates/optn-app",
        &app_manifest,
        &[
            "optn-transport",
            "optn-runtime",
            "optn-platform-native",
            "optn-ui",
        ],
        &mut failures,
    );

    let apple_manifest = read(&root.join("crates/optn-platform-apple/Cargo.toml"));
    require_dependency(
        "crates/optn-platform-apple",
        &apple_manifest,
        "optn-platform",
        &mut failures,
    );
    forbid_dependencies(
        "crates/optn-platform-apple",
        &apple_manifest,
        &[
            "optn-core",
            "optn-app",
            "optn-runtime",
            "optn-transport",
            "optn-ui",
            "optn-platform-native",
        ],
        &mut failures,
    );

    apple::check(&root, &mut failures);

    // The Rust renderer may use HTML/CSS build assets, but application/source
    // logic under optn-ui must remain Rust. Reference-wallet TypeScript/Vue is
    // a behavior oracle, not a migration destination.
    let ui_root = root.join("crates/optn-ui");
    for entry in walk_files(&ui_root) {
        let extension = entry
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(extension.as_str(), "js" | "jsx" | "ts" | "tsx" | "vue") {
            failures.push(format!(
                "{} is handwritten web-framework source inside the Rust renderer",
                entry.display()
            ));
        }
    }

    if failures.is_empty() {
        println!("architecture boundary check: PASS");
        return;
    }

    for failure in failures {
        eprintln!("architecture boundary violation: {failure}");
    }
    std::process::exit(1);
}

fn require_dependency(scope: &str, manifest: &str, dependency: &str, failures: &mut Vec<String>) {
    if !manifest.contains(dependency) {
        failures.push(format!(
            "{scope} must depend on '{dependency}' to preserve the intended boundary"
        ));
    }
}

fn forbid_dependencies(
    scope: &str,
    manifest: &str,
    dependencies: &[&str],
    failures: &mut Vec<String>,
) {
    for dependency in dependencies {
        if manifest.contains(dependency) {
            failures.push(format!(
                "{scope} contains forbidden dependency '{dependency}'"
            ));
        }
    }
}

fn read(path: &Path) -> String {
    fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()))
}

fn walk_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let Ok(entries) = fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let skip = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        matches!(name, "dist" | "target" | "node_modules" | ".git")
                    });
                if !skip {
                    pending.push(path);
                }
            } else {
                files.push(path);
            }
        }
    }
    files
}

#[cfg(test)]
mod apple_firewall_tests {
    use super::*;

    fn workspace_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("xtask lives below workspace root")
            .to_path_buf()
    }

    #[test]
    fn optn_core_app_runtime_cargo_tomls_do_not_name_opal_packages() {
        let root = workspace_root();
        for crate_name in ["optn-core", "optn-app", "optn-runtime"] {
            let text =
                read(&root.join("crates").join(crate_name).join("Cargo.toml")).to_lowercase();
            for dependency in APPLE_REFERENCE_DEPENDENCIES {
                assert!(
                    !text.contains(dependency),
                    "{crate_name} Cargo.toml must not mention {dependency}"
                );
            }
        }
    }

    #[test]
    fn opal_reference_is_v26_gated_without_moving_branches_or_secret_packages() {
        let manifest = read(&workspace_root().join("apple/OPTNOpalReference/Package.swift"));
        assert!(manifest.contains(".iOS(.v26)"));
        assert!(manifest.contains(".macOS(.v26)"));
        assert!(manifest.contains("OPAL_APPLE26_REFERENCE"));
        assert!(
            !manifest.contains("branch:"),
            "Opal reference must not pin moving develop"
        );
        for forbidden in ["OpalBase", "OpalCrypto", "OpalFusion", "OpalHedge"] {
            assert!(
                !manifest.contains(forbidden),
                "Opal reference must not link {forbidden}"
            );
        }
    }

    #[test]
    fn native_apple_provider_does_not_depend_on_opal() {
        let manifest =
            read(&workspace_root().join("apple/OPTNAppleProvider/Package.swift")).to_lowercase();
        for dependency in APPLE_REFERENCE_DEPENDENCIES {
            assert!(
                !manifest.contains(dependency),
                "native Apple provider must not depend on {dependency}"
            );
        }
        assert!(manifest.contains(".ios(.v14)"));
    }
}
