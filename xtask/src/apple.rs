use std::{
    fs,
    path::{Path, PathBuf},
};

const FORBIDDEN_OPAL_ON_SHIPPING: &[&str] = &[
    "import OpalBase",
    "import OpalCrypto",
    "import OpalFusion",
    "import OpalHedge",
    "58opals",
    "import SwiftFulcrum",
    "import OpalDiagnostics",
];

const FORBIDDEN_OPTN_DOMAIN: &[&str] = &[
    "optn-core",
    "optn-app",
    "optn-runtime",
    "optn_core",
    "optn_app",
    "optn_runtime",
];

pub fn check(root: &Path, failures: &mut Vec<String>) {
    let shipping = root.join("apple/OPTNAppleProvider/Package.swift");
    let flavor = root.join("apple/OPTNOpalReference/Package.swift");
    let pbxproj = root.join("ios/App/App.xcodeproj/project.pbxproj");
    let podfile = root.join("ios/App/Podfile");
    let tauri_conf = root.join("src-tauri/tauri.conf.json");

    let shipping_manifest = read(&shipping);
    let flavor_manifest = uncommented(&read(&flavor));
    let pbx = read(&pbxproj);
    let pod = read(&podfile);
    let tauri = read(&tauri_conf);

    if !pbx.contains("IPHONEOS_DEPLOYMENT_TARGET = 14.0;") {
        failures.push(format!(
            "{} no longer declares IPHONEOS_DEPLOYMENT_TARGET = 14.0; do not silently raise OPTN iOS minimums for Opal",
            pbxproj.display()
        ));
    }
    if !pod.contains("platform :ios, '14.0'") {
        failures.push(format!(
            "{} no longer declares platform :ios, '14.0'; do not silently raise OPTN iOS minimums for Opal",
            podfile.display()
        ));
    }
    if tauri.contains("minimumSystemVersion") {
        failures.push(format!(
            "{} authored a macOS minimumSystemVersion; do not raise it to Opal's macOS 26",
            tauri_conf.display()
        ));
    }

    if !shipping_manifest.contains(".iOS(.v14)") {
        failures.push(
            "apple/OPTNAppleProvider/Package.swift must keep .iOS(.v14) to match OPTN iOS 14.0"
                .into(),
        );
    }
    if !(shipping_manifest.contains(".macOS(.v10_15)")
        || shipping_manifest.contains(".macOS(.v11)"))
    {
        failures.push("apple/OPTNAppleProvider/Package.swift must keep macOS 10.15 or 11, never Opal macOS 26".into());
    }
    if shipping_manifest.contains(".v26") {
        failures.push("shipping OPTNAppleProvider must not declare Opal's *OS 26 platforms".into());
    }
    for token in [
        "OpalBase",
        "OpalCrypto",
        "OpalFusion",
        "OpalHedge",
        "58opals",
        "SwiftFulcrum",
        "OpalDiagnostics",
    ] {
        if shipping_manifest.contains(token) {
            failures.push(format!(
                "shipping OPTNAppleProvider Package.swift depends on Opal token '{token}'"
            ));
        }
    }

    if !flavor_manifest.contains(".iOS(.v26)") || !flavor_manifest.contains(".macOS(.v26)") {
        failures.push("Opal flavor Package.swift must isolate to iOS 26 / macOS 26".into());
    }
    if flavor_manifest.contains("branch: \"develop\"") {
        failures.push("Opal flavor must not track moving develop; pin exact tags".into());
    }
    for token in ["OpalCrypto", "OpalFusion", "OpalBase", "OpalHedge"] {
        if flavor_manifest.contains(token) {
            failures.push(format!(
                "Opal flavor Package.swift must not depend on {token} (no production secrets, no second wallet, Fusion stays Rust)"
            ));
        }
    }
    let fulcrum_pinned = flavor_manifest.contains("exact: \"0.8.0\"")
        || flavor_manifest.contains("611a53f2047660e0dd221f75526ce11335be901a");
    if !fulcrum_pinned {
        failures.push(
            "Opal flavor must pin SwiftFulcrum v0.8.0 / 611a53f2047660e0dd221f75526ce11335be901a"
                .into(),
        );
    }
    let diagnostics_pinned =
        flavor_manifest.contains("exact: \"0.2.0\"") || flavor_manifest.contains("revision:");
    if !diagnostics_pinned {
        failures.push("Opal flavor must pin OpalDiagnostics to a reviewed tag/revision".into());
    }

    scan_swift(
        &root.join("apple/OPTNAppleProvider/Sources"),
        FORBIDDEN_OPAL_ON_SHIPPING,
        "shipping Swift",
        failures,
    );
    scan_swift(
        &root.join("apple/OPTNAppleProvider/Sources"),
        FORBIDDEN_OPTN_DOMAIN,
        "shipping Apple sources",
        failures,
    );
    scan_swift(
        &root.join("apple/OPTNOpalReference/Sources"),
        &[
            "import OpalBase",
            "import OpalCrypto",
            "import OpalFusion",
            "import OpalHedge",
            "optn-core",
            "optn-app",
            "optn-runtime",
            "optn_core",
            "optn_app",
            "optn_runtime",
            "ProximityReader",
        ],
        "Opal flavor sources",
        failures,
    );

    let apple_manifest = read(&root.join("crates/optn-platform-apple/Cargo.toml"));
    for forbidden in [
        "optn-core",
        "optn-app",
        "optn-runtime",
        "optn-ui",
        "leptos",
        "tauri",
        "dioxus",
        "capacitor",
    ] {
        if apple_manifest.contains(forbidden) {
            failures.push(format!(
                "crates/optn-platform-apple/Cargo.toml contains forbidden dependency '{forbidden}'"
            ));
        }
    }

    let core = read(&root.join("crates/optn-core/Cargo.toml"));
    let app = read(&root.join("crates/optn-app/Cargo.toml"));
    let runtime = read(&root.join("crates/optn-runtime/Cargo.toml"));
    for (name, manifest) in [
        ("optn-core", core.as_str()),
        ("optn-app", app.as_str()),
        ("optn-runtime", runtime.as_str()),
    ] {
        if manifest.contains("optn-platform-apple") {
            failures.push(format!("{name} must not depend on optn-platform-apple"));
        }
        if manifest.to_lowercase().contains("opal") {
            failures.push(format!("{name} must not depend on Opal"));
        }
    }
}

fn uncommented(text: &str) -> String {
    text.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn scan_swift(dir: &Path, forbidden: &[&str], label: &str, failures: &mut Vec<String>) {
    for file in walk_swift(dir) {
        let text = read(&file);
        for token in forbidden {
            if text.contains(token) {
                failures.push(format!(
                    "{label} {} contains forbidden token '{token}'",
                    file.display()
                ));
            }
        }
    }
}

fn walk_swift(root: &Path) -> Vec<PathBuf> {
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
                    .is_some_and(|name| matches!(name, ".build" | ".swiftpm" | "target"));
                if !skip {
                    pending.push(path);
                }
            } else if path.extension().and_then(|e| e.to_str()) == Some("swift")
                || path.file_name().and_then(|n| n.to_str()) == Some("Package.swift")
            {
                files.push(path);
            }
        }
    }
    files
}

fn read(path: &Path) -> String {
    fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()))
}
