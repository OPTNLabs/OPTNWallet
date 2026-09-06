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
        "audit" => audit(),
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

/// Advisories accepted for now, with a reason and an expiry.
///
/// A baseline is not a dismissal: failing on an advisory that is already on
/// `dev` only makes the job permanently red and teaches everyone to ignore it.
/// But a mute that outlives its reason is worse than no mute at all, because it
/// silently accepts the vulnerability's *return*, so each entry is dropped as
/// its fix lands.
///
/// It is empty because all four entries the release workflow carries have
/// landed, which was checked rather than assumed:
///
/// - RUSTSEC-2026-0194 / 0195 (quick-xml <0.41): every lock file now resolves
///   quick-xml 0.41.0.
/// - RUSTSEC-2026-0185 (quinn-proto 0.11.14): now 0.11.17 everywhere.
/// - RUSTSEC-2026-0235 (rkyv 0.7.46): rkyv appears in no lock file at all.
///
/// `cargo audit` with no ignores exits clean across all five lock files, so
/// `.github/workflows/security-analysis.yml` can drop its four `--ignore`
/// flags. Until it does, those four are muted there for no remaining reason.
const BASELINE_ADVISORIES: &[&str] = &[];

/// Audit every Rust lock file in the repository.
///
/// The workflow's audit step runs `cargo audit` in `src-tauri` alone, so the
/// desktop shell is checked and the crates the wallet's logic actually lives in
/// -- the workspace, the CLI, the protocol core -- are not. That is the same
/// shape of hole the release verification had: a job that reports success
/// while leaving most of the tree unexamined.
///
/// Lock files are **discovered** rather than listed, so a new crate is covered
/// the day it appears instead of the day someone remembers to add it. A missing
/// `cargo-audit` is a failure, never a skip, for the same reason.
fn audit() {
    let root = repo_root();
    let mut lock_files: Vec<PathBuf> = walk_files(&root)
        .into_iter()
        .filter(|path| path.file_name().is_some_and(|name| name == "Cargo.lock"))
        .collect();
    lock_files.sort();

    if lock_files.is_empty() {
        eprintln!("dependency audit: no Cargo.lock found, which cannot be right");
        std::process::exit(1);
    }

    let mut failures = Vec::new();
    for lock in &lock_files {
        let relative = lock.strip_prefix(&root).unwrap_or(lock);
        println!("dependency audit: {}", relative.display());
        let mut command = std::process::Command::new("cargo");
        command.arg("audit").arg("--file").arg(lock);
        for advisory in BASELINE_ADVISORIES {
            command.arg("--ignore").arg(advisory);
        }
        match command.status() {
            Ok(status) if status.success() => {}
            Ok(status) => failures.push(format!("{} ({status})", relative.display())),
            Err(error) => {
                eprintln!(
                    "dependency audit: could not run cargo-audit ({error}). Install it with \
                     `cargo install cargo-audit --locked`; a missing tool is a failed audit, not \
                     a skipped one."
                );
                std::process::exit(1);
            }
        }
    }

    if failures.is_empty() {
        println!(
            "dependency audit: PASS ({} lock files, {} baselined advisories)",
            lock_files.len(),
            BASELINE_ADVISORIES.len()
        );
    } else {
        for failure in &failures {
            eprintln!("dependency audit failed: {failure}");
        }
        std::process::exit(1);
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask must live below workspace root")
        .to_path_buf()
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
        let text = manifest_body(&read(&manifest)).to_lowercase();
        for framework in FRAMEWORK_NAMES {
            if text.contains(framework) {
                failures.push(format!(
                    "{} contains forbidden framework dependency '{framework}'",
                    manifest.display()
                ));
            }
        }
    }

    // Wallet truth stays in Rust. An Apple provider is reached through
    // optn-platform's contracts, so the packages behind it must not appear in
    // the crates that own domain, application or runtime state.
    for manifest in [
        root.join("crates/optn-core/Cargo.toml"),
        root.join("crates/optn-app/Cargo.toml"),
        root.join("crates/optn-runtime/Cargo.toml"),
    ] {
        // Comments stripped: naming a package while explaining why it is
        // absent is not depending on it.
        let text = manifest_body(&read(&manifest)).to_lowercase();
        for dependency in APPLE_REFERENCE_DEPENDENCIES {
            if text.contains(dependency) {
                failures.push(format!(
                    "{} depends on Apple provider package '{dependency}'; wallet truth stays \
                     in Rust and Apple adapters belong behind optn-platform",
                    manifest.display()
                ));
            }
        }
    }

    // A second renderer keeps the first one honest. If a screen's content
    // drifts into Leptos components, optn-ui-text cannot draw it and its tests
    // fail; if a UI framework leaks into optn-app or optn-transport, it stops
    // compiling. Both only work while it depends on those two and nothing
    // else, so that is checked rather than trusted.
    let text_ui_manifest = read(&root.join("crates/optn-ui-text/Cargo.toml"));
    require_dependency(
        "crates/optn-ui-text",
        &text_ui_manifest,
        "optn-app",
        &mut failures,
    );
    require_dependency(
        "crates/optn-ui-text",
        &text_ui_manifest,
        "optn-transport",
        &mut failures,
    );
    for framework in FRAMEWORK_NAMES {
        if manifest_body(&text_ui_manifest)
            .to_lowercase()
            .contains(framework)
        {
            failures.push(format!(
                "crates/optn-ui-text depends on '{framework}'; it exists to prove a renderer \
                 needs only optn-app and optn-transport, so a framework there defeats it"
            ));
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

    // A third renderer, on a real GUI toolkit, is the argument that the
    // renderer seam is a seam and not a Leptos-shaped hole. It only carries
    // that weight while egui is the *only* thing it adds: the moment it needs
    // optn-core, or a second UI framework, swapping toolkits stops being one
    // crate and becomes a migration again.
    let egui_ui_manifest = read(&root.join("crates/optn-ui-egui/Cargo.toml"));
    require_dependency(
        "crates/optn-ui-egui",
        &egui_ui_manifest,
        "optn-app",
        &mut failures,
    );
    require_dependency(
        "crates/optn-ui-egui",
        &egui_ui_manifest,
        "optn-transport",
        &mut failures,
    );
    forbid_dependencies(
        "crates/optn-ui-egui",
        &egui_ui_manifest,
        &[
            "optn-core",
            "optn-runtime",
            "optn-platform",
            "optn-platform-native",
        ],
        &mut failures,
    );
    for framework in FRAMEWORK_NAMES {
        if manifest_body(&egui_ui_manifest)
            .to_lowercase()
            .contains(framework)
        {
            failures.push(format!(
                "crates/optn-ui-egui depends on '{framework}'; it renders on egui alone, and a \
                 second framework there would mean the toolkits are not interchangeable"
            ));
        }
    }
    // eframe would drag in winit and a GPU backend, and the tests would stop
    // being runnable on a machine with no display.
    forbid_dependencies(
        "crates/optn-ui-egui",
        &egui_ui_manifest,
        &["eframe"],
        &mut failures,
    );

    // "The renderer is swappable" is a claim with a number in it: one line.
    // Both renderer crates carry the same host block -- the same script through
    // the same `optn_transport::run`, asserting the same facts -- and the only
    // line that may differ between them is the `type Ui<T> = ...` alias naming
    // the renderer. Checked rather than stated, because a claim about a diff
    // stops being true the moment someone edits one side.
    let text_host = host_block(&read(&root.join("crates/optn-ui-text/src/lib.rs")));
    let egui_host = host_block(&read(&root.join("crates/optn-ui-egui/src/lib.rs")));
    match (text_host, egui_host) {
        (Some(text), Some(egui)) => {
            let differences: Vec<(usize, &str, &str)> = text
                .iter()
                .zip(egui.iter())
                .enumerate()
                .filter(|(_, (a, b))| a != b)
                .map(|(index, (a, b))| (index, a.as_str(), b.as_str()))
                .collect();
            if text.len() != egui.len() {
                failures.push(format!(
                    "the two renderers' host blocks are {} and {} lines; swapping renderers must \
                     be one line, so they have to stay the same block",
                    text.len(),
                    egui.len()
                ));
            } else if differences.len() != 1 {
                failures.push(format!(
                    "the two renderers' host blocks differ on {} lines; only the `type Ui` alias \
                     may differ, or swapping renderers is not one line: {:?}",
                    differences.len(),
                    differences
                ));
            } else if !differences[0].1.trim_start().starts_with("type Ui<T> =") {
                failures.push(format!(
                    "the one line that differs between the renderers' host blocks is not the \
                     renderer alias: {:?}",
                    differences[0]
                ));
            }
        }
        _ => failures.push(
            "one of the renderer crates has no host block; the swap is only demonstrated while \
             both drive optn_transport::run through the same script"
                .into(),
        ),
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
            // Code only. Explaining in a comment why a package is absent is
            // not depending on it, and a test that names the implementation it
            // compares against is using the word as data. Both were failing
            // this before, which would have made the guard something to work
            // around rather than something to keep.
            let text = rust_code_only(&read(&path)).to_lowercase();
            for dependency in APPLE_REFERENCE_DEPENDENCIES {
                if text.contains(dependency) {
                    failures.push(format!(
                        "{} refers to Apple/Opal package '{dependency}' in code; wallet truth                          stays in Rust and Apple adapters belong behind optn-platform",
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

/// The shared host block a renderer crate carries, if it carries one.
///
/// Bounded by the `type Ui` alias that opens it and the end of the test that
/// uses it, so it is the block a reader would compare by hand.
fn host_block(source: &str) -> Option<Vec<String>> {
    const OPENS: &str = "/// The one line a host changes to swap renderers.";
    // Source files may be checked out with CRLF on Windows. The architecture
    // invariant is about Rust structure, not the checkout's line endings.
    let normalized = source.replace("\r\n", "\n");
    let start = normalized.find(OPENS)?;
    let head = &normalized[start..];
    let loop_at = head.find("for tab in")?;
    let end = head[loop_at..].find("\n    }\n")? + loop_at + "\n    }\n".len();
    Some(
        head[..end]
            .lines()
            .map(|line| line.trim_end().to_string())
            .collect(),
    )
}

/// A manifest with its comments removed.
///
/// These guards match on manifest text, and a comment that names a crate is
/// not a dependency on it: a note explaining that a crate deliberately does
/// *not* pull something in would otherwise read as pulling it in. Stripping
/// comments also stops a comment from satisfying `require_dependency`, which
/// is the more dangerous direction of the same mistake.
/// Rust source with comments and string literals removed.
///
/// A forbidden-name scan over raw source cannot tell a dependency from a
/// sentence about one. Naming a package in a doc comment that explains why it
/// is not used, or in a test label naming the implementation being compared
/// against, is not a dependency -- and failing the build for it teaches people
/// to reword prose instead of to keep the boundary. What a Rust file cannot do
/// without naming it in code is *use* the crate, so code is what is checked.
fn rust_code_only(source: &str) -> String {
    let bytes: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut index = 0;
    while index < bytes.len() {
        let current = bytes[index];
        let next = bytes.get(index + 1).copied();
        match (current, next) {
            ('/', Some('/')) => {
                while index < bytes.len() && bytes[index] != '\n' {
                    index += 1;
                }
            }
            ('/', Some('*')) => {
                // Rust block comments nest, so a depth counter is needed
                // rather than a search for the first `*/`.
                let mut depth = 1;
                index += 2;
                while index < bytes.len() && depth > 0 {
                    match (bytes[index], bytes.get(index + 1).copied()) {
                        ('/', Some('*')) => {
                            depth += 1;
                            index += 2;
                        }
                        ('*', Some('/')) => {
                            depth -= 1;
                            index += 2;
                        }
                        _ => index += 1,
                    }
                }
            }
            ('r', Some('"')) | ('r', Some('#')) => {
                // A raw string: r"..", r#".."#, r##".."##.
                let mut hashes = 0;
                let mut scan = index + 1;
                while bytes.get(scan) == Some(&'#') {
                    hashes += 1;
                    scan += 1;
                }
                if bytes.get(scan) != Some(&'"') {
                    out.push(current);
                    index += 1;
                    continue;
                }
                index = scan + 1;
                loop {
                    if index >= bytes.len() {
                        break;
                    }
                    if bytes[index] == '"'
                        && (0..hashes).all(|offset| bytes.get(index + 1 + offset) == Some(&'#'))
                    {
                        index += 1 + hashes;
                        break;
                    }
                    index += 1;
                }
            }
            ('"', _) => {
                index += 1;
                while index < bytes.len() && bytes[index] != '"' {
                    if bytes[index] == '\\' {
                        index += 1;
                    }
                    index += 1;
                }
                index += 1;
            }
            _ => {
                out.push(current);
                index += 1;
            }
        }
    }
    out
}

fn manifest_body(manifest: &str) -> String {
    manifest
        .lines()
        .map(|line| line.split_once('#').map_or(line, |(before, _)| before))
        .collect::<Vec<_>>()
        .join("\n")
}

fn require_dependency(scope: &str, manifest: &str, dependency: &str, failures: &mut Vec<String>) {
    if !manifest_body(manifest).contains(dependency) {
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
    let body = manifest_body(manifest);
    for dependency in dependencies {
        if body.contains(dependency) {
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

    #[test]
    fn host_block_is_independent_of_checkout_line_endings() {
        let source = "/// The one line a host changes to swap renderers.\n\
type Ui<T> = Example<T>;\n\
for tab in tabs {\n\
    }\n";
        assert_eq!(
            host_block(source),
            host_block(&source.replace('\n', "\r\n"))
        );
    }

    #[test]
    fn the_source_scan_reads_code_and_not_prose() {
        // A guard that fails on the word teaches people to reword the sentence.
        // A guard that fails on the import is one worth keeping, so this checks
        // both halves: prose passes, code does not.
        let prose = r##"
            //! SwiftFulcrum is an independent implementation, named here to
            //! explain why nothing in this crate reaches for it.
            /* opalbase /* nested */ is likewise only discussed */
            fn label() -> &'static str { "SwiftFulcrum" }
            fn raw() -> &'static str { r#"opalcrypto"# }
        "##;
        let stripped = rust_code_only(prose).to_lowercase();
        for dependency in APPLE_REFERENCE_DEPENDENCIES {
            assert!(
                !stripped.contains(dependency),
                "'{dependency}' survived stripping: {stripped}"
            );
        }

        // The thing the guard exists for. A crate cannot be used without being
        // named in code, so these must all still be caught.
        for code in [
            "use swiftfulcrum::Client;",
            "extern crate opalbase;",
            "let x = opalcrypto::sign(seed);",
            "fn f(p: opalfusion::Round) {}",
        ] {
            let stripped = rust_code_only(code).to_lowercase();
            assert!(
                APPLE_REFERENCE_DEPENDENCIES
                    .iter()
                    .any(|dependency| stripped.contains(dependency)),
                "a real dependency slipped through: {code}"
            );
        }

        // An escaped quote must not end the literal early and leave the rest of
        // the string looking like code.
        let escaped = r#"let s = "a \" swiftfulcrum"; let t = 1;"#;
        assert!(!rust_code_only(escaped)
            .to_lowercase()
            .contains("swiftfulcrum"));
        assert!(rust_code_only(escaped).contains("let t = 1;"));
    }

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
