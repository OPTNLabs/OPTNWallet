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
        root.join("crates/optn-chain-native/Cargo.toml"),
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

    // A fourth crate, Dioxus, is still a plugin on the same seam: optn-app
    // and optn-transport only, plus Dioxus SSR. A windowing stack here would
    // break the no-display swap proof the same way eframe would for egui.
    let dioxus_ui_manifest = read(&root.join("crates/optn-ui-dioxus/Cargo.toml"));
    require_dependency(
        "crates/optn-ui-dioxus",
        &dioxus_ui_manifest,
        "optn-app",
        &mut failures,
    );
    require_dependency(
        "crates/optn-ui-dioxus",
        &dioxus_ui_manifest,
        "optn-transport",
        &mut failures,
    );
    require_dependency(
        "crates/optn-ui-dioxus",
        &dioxus_ui_manifest,
        "dioxus",
        &mut failures,
    );
    forbid_dependencies(
        "crates/optn-ui-dioxus",
        &dioxus_ui_manifest,
        &[
            "optn-core",
            "optn-runtime",
            "optn-platform",
            "optn-platform-native",
        ],
        &mut failures,
    );
    for framework in FRAMEWORK_NAMES {
        if *framework == "dioxus" {
            continue;
        }
        if manifest_body(&dioxus_ui_manifest)
            .to_lowercase()
            .contains(framework)
        {
            failures.push(format!(
                "crates/optn-ui-dioxus depends on '{framework}'; it renders on dioxus alone, and a \
                 second framework there would mean the toolkits are not interchangeable"
            ));
        }
    }
    forbid_dependencies(
        "crates/optn-ui-dioxus",
        &dioxus_ui_manifest,
        &["dioxus-desktop", "wry", "tao", "winit", "egui", "eframe"],
        &mut failures,
    );
    // dioxus-ssr is the no-display backend; a desktop/web renderer is not.

    // "The renderer is swappable" is a claim with a number in it: one line.
    // Renderer crates carry the same host block -- the same script through
    // the same `optn_transport::run`, asserting the same facts -- and the only
    // line that may differ between them is the `type Ui<T> = ...` alias naming
    // the renderer. Checked rather than stated, because a claim about a diff
    // stops being true the moment someone edits one side.
    let renderer_hosts = [
        (
            "crates/optn-ui-text",
            host_block(&read(&root.join("crates/optn-ui-text/src/lib.rs"))),
        ),
        (
            "crates/optn-ui-egui",
            host_block(&read(&root.join("crates/optn-ui-egui/src/lib.rs"))),
        ),
        (
            "crates/optn-ui-dioxus",
            host_block(&read(&root.join("crates/optn-ui-dioxus/src/lib.rs"))),
        ),
    ];
    for (index, (left_name, left_host)) in renderer_hosts.iter().enumerate() {
        for (right_name, right_host) in renderer_hosts.iter().skip(index + 1) {
            match (left_host, right_host) {
                (Some(left), Some(right)) => {
                    compare_host_blocks(left_name, left, right_name, right, &mut failures);
                }
                _ => failures.push(format!(
                    "{left_name} or {right_name} has no host block; the swap is only demonstrated \
                     while every renderer drives optn_transport::run through the same script"
                )),
            }
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

    let native_chain_manifest = read(&root.join("crates/optn-chain-native/Cargo.toml"));
    forbid_dependencies(
        "crates/optn-chain-native",
        &native_chain_manifest,
        &[
            "optn-app",
            "optn-platform",
            "optn-platform-native",
            "optn-platform-apple",
            "optn-transport",
            "optn-ui",
        ],
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

    cashcode_policy(&root, &mut failures);
    explorer_policy(&root, &mut failures);

    if failures.is_empty() {
        println!("architecture boundary check: PASS");
        return;
    }

    for failure in failures {
        eprintln!("architecture boundary violation: {failure}");
    }
    std::process::exit(1);
}

/// An encoder or a prefix family that can stamp a legacy `paycode:`.
///
/// `'legacy-paycode'` is the TypeScript spelling of the same idea. Single
/// quotes are kept deliberately: `rust_code_only` strips double-quoted
/// strings and every comment, so prose explaining why the family is gone
/// does not trip this, and a live TS union member does.
const LEGACY_PAYCODE_APIS: &[&str] = &["PrefixFamily", "encode_with_family", "'legacy-paycode'"];

/// PR #89's decision, enforced where a merge cannot quietly revert it.
///
/// OPTN accepts `cashcode:` / `cashcodetest:` and refuses `paycode:` /
/// `paycodetest:`. That is not a naming preference. A legacy PayCode carries
/// keys its owner derived under the legacy rules, so deriving a destination
/// from one with CashCode's compressed semantics pays an address the legacy
/// recipient never derived and cannot scan for.
///
/// This lives in xtask rather than in `optn-core`'s own tests because the way
/// it was actually lost was a merge that replaced `rpa.rs` wholesale -- tests
/// included. A test inside the file cannot guard the file. This check reads
/// the tree from outside it, so reverting the policy fails the architecture
/// job instead of waiting for someone to read a 400-line diff.
fn cashcode_policy(root: &Path, failures: &mut Vec<String>) {
    // The refusal itself, and the fact that `decode` reaches it. Refusing by
    // prefix has to happen *before* the checksum: a legacy string is
    // perfectly well formed, so a checksum will not reject it.
    let rpa_path = root.join("crates/optn-core/src/rpa.rs");
    let rpa = rust_code_only(&read(&rpa_path));
    for required in ["fn is_legacy_paycode", "if is_legacy_paycode(code)"] {
        if !rpa.contains(required) {
            failures.push(format!(
                "crates/optn-core/src/rpa.rs no longer contains '{required}'; PR #89 made \
                 Cash Code exclusive and decoding a legacy PayCode under compressed semantics \
                 pays an address its recipient cannot scan for"
            ));
        }
    }

    // No surface may offer a way to *produce* one either. An encoder able to
    // stamp the prefix is a way to manufacture the very strings `decode`
    // refuses, which turns the refusal into an inconvenience.
    let mut scanned = Vec::new();
    for directory in ["crates", "src"] {
        scanned.extend(walk_files(&root.join(directory)));
    }
    for path in scanned {
        let is_source = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| matches!(extension, "rs" | "ts" | "tsx"));
        if !is_source {
            continue;
        }
        let code = rust_code_only(&read(&path));
        for api in LEGACY_PAYCODE_APIS {
            if code.contains(api) {
                failures.push(format!(
                    "{} declares or uses legacy PayCode emit API '{api}'; OPTN emits \
                     cashcode: only, and an encoder for the legacy prefix defeats the \
                     refusal in optn-core's decode",
                    path.display()
                ));
            }
        }
    }
}

/// The hostnames of the public explorers OPTN can offer.
///
/// Any one of these outside the core module means a surface built a link for
/// itself, which is how the renderer used to hand a txid to a public site
/// while the wallet was set to use only the holder's own infrastructure.
/// Only hosts that are explorers and nothing else. `bch.ninja` is deliberately
/// absent: `chipnet.bch.ninja` is also an Electrum server this wallet dials,
/// so naming it would flag chain configuration that has nothing to do with
/// explorer links.
const PUBLIC_EXPLORER_HOSTS: &[&str] = &[
    "bchexplorer.cash",
    "explorer.imaginary.cash",
    "blockchair.com",
    "3xpl.com",
    "tokenexplorer.cash",
];

/// #75 row 15: one place decides whether an explorer link may be built.
///
/// The rule is not "explorers are dangerous" -- an explorer link is navigation
/// and nothing here touches consensus. It is that the decision is governed by
/// the connection policy, and a second copy of that decision is how a policy
/// ends up enforced on one surface and not another. That is not hypothetical:
/// `src/utils/servers/explorers.ts` held one, with no notion of the policy at
/// all.
fn explorer_policy(root: &Path, failures: &mut Vec<String>) {
    let core = root.join("crates/optn-core/src/explorer.rs");
    let code = rust_code_only(&read(&core));
    for required in ["ExplorerPolicy::UserOwnedOnly", "PublicExplorerRefused"] {
        if !code.contains(required) {
            failures.push(format!(
                "crates/optn-core/src/explorer.rs no longer contains '{required}'; without \
                 the fail-closed arm an own-infrastructure-only wallet hands transaction \
                 ids to a public website"
            ));
        }
    }

    let allowed = [
        Path::new("crates/optn-core/src/explorer.rs"),
        // Names them to assert this guard works.
        Path::new("xtask/src/main.rs"),
    ];
    let mut scanned = Vec::new();
    for directory in ["crates", "src", "src-tauri"] {
        scanned.extend(walk_files(&root.join(directory)));
    }
    scanned.extend(walk_files(&root.join("xtask")));
    for path in scanned {
        let is_source = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| matches!(extension, "rs" | "ts" | "tsx"));
        if !is_source {
            continue;
        }
        let relative = path.strip_prefix(root).unwrap_or(&path);
        if allowed.contains(&relative) {
            continue;
        }
        if relative.starts_with("crates/optn-runtime/src/explorer.rs") {
            continue;
        }
        // A test may name a host, to assert what the core produced or to print
        // a link for whoever is reading the run. Nothing a test builds reaches
        // a holder, so the rule that matters here does not apply to it.
        let is_test = relative.components().any(|component| {
            matches!(
                component.as_os_str().to_str(),
                Some("tests") | Some("__tests__")
            )
        }) || relative
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.contains(".test.") || name.contains(".live."));
        if is_test {
            continue;
        }
        // Deliberately NOT `rust_code_only`: it treats the `//` in `https://`
        // as the start of a line comment and eats the rest of the line, so a
        // hardcoded explorer URL -- the exact thing being looked for -- is
        // invisible to it. Whole comment lines are dropped instead, which is
        // enough to let prose name an explorer while code may not.
        let code = code_lines_only(&read(&path));
        for host in PUBLIC_EXPLORER_HOSTS {
            if code.contains(host) {
                failures.push(format!(
                    "{} names the public explorer '{host}'; explorer URLs are built in \
                     crates/optn-core/src/explorer.rs so the connection policy governs \
                     them on every surface",
                    relative.display()
                ));
            }
        }
    }
}

/// Source with whole-line comments removed.
///
/// Coarse on purpose. `rust_code_only` strips string literals, which is right
/// for an API-name check and wrong for a URL check: the URL lives *in* the
/// string. This keeps strings and drops only lines that are entirely comment,
/// so a doc comment may discuss an explorer while a line of code may not name
/// one.
fn code_lines_only(source: &str) -> String {
    source
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            !(trimmed.starts_with("//")
                || trimmed.starts_with("/*")
                || trimmed.starts_with('*')
                || trimmed.starts_with("#"))
        })
        .collect::<Vec<_>>()
        .join(
            "
",
        )
}

fn compare_host_blocks(
    left_name: &str,
    left: &[String],
    right_name: &str,
    right: &[String],
    failures: &mut Vec<String>,
) {
    let differences: Vec<(usize, &str, &str)> = left
        .iter()
        .zip(right.iter())
        .enumerate()
        .filter(|(_, (a, b))| a != b)
        .map(|(index, (a, b))| (index, a.as_str(), b.as_str()))
        .collect();
    if left.len() != right.len() {
        failures.push(format!(
            "{left_name} and {right_name} host blocks are {} and {} lines; swapping renderers must \
             be one line, so they have to stay the same block",
            left.len(),
            right.len()
        ));
    } else if differences.len() != 1 {
        failures.push(format!(
            "{left_name} and {right_name} host blocks differ on {} lines; only the `type Ui` alias \
             may differ, or swapping renderers is not one line: {:?}",
            differences.len(),
            differences
        ));
    } else if !differences[0].1.trim_start().starts_with("type Ui<T> =") {
        failures.push(format!(
            "the one line that differs between {left_name} and {right_name} host blocks is not the \
             renderer alias: {:?}",
            differences[0]
        ));
    }
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
