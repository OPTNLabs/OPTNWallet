use std::{
    env, fs,
    path::{Path, PathBuf},
};

const FRAMEWORK_NAMES: &[&str] = &["leptos", "tauri", "dioxus", "capacitor"];

fn main() {
    let command = env::args().nth(1).unwrap_or_else(|| "architecture".into());
    match command.as_str() {
        "architecture" => architecture(),
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
        root.join("crates/optn-runtime/Cargo.toml"),
        root.join("crates/optn-transport/Cargo.toml"),
    ];

    let mut failures = Vec::new();
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

    let ui_manifest = read(&root.join("crates/optn-ui/Cargo.toml"));
    require_dependency(
        "crates/optn-ui",
        &ui_manifest,
        "optn-app",
        &mut failures,
    );
    require_dependency(
        "crates/optn-ui",
        &ui_manifest,
        "optn-transport",
        &mut failures,
    );
    forbid_dependencies(
        "crates/optn-ui",
        &ui_manifest,
        &["optn-core", "optn-runtime", "optn-platform", "optn-platform-native"],
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
        &["optn-runtime", "optn-platform", "optn-platform-native", "optn-ui"],
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
        &["optn-transport", "optn-runtime", "optn-platform-native", "optn-ui"],
        &mut failures,
    );

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
