use std::{env, fs, path::{Path, PathBuf}};

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

    let neutral = [
        root.join("crates/optn-core"),
        root.join("crates/optn-app"),
        root.join("crates/optn-platform"),
    ];

    let mut failures = Vec::new();
    for path in neutral {
        scan_framework_names(&path, &mut failures);
    }

    let ui_manifest = read(&root.join("crates/optn-ui/Cargo.toml"));
    if ui_manifest.contains("optn-core") {
        failures.push(
            "crates/optn-ui must depend on optn-app, not bypass it via optn-core".into(),
        );
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

fn scan_framework_names(root: &Path, failures: &mut Vec<String>) {
    visit(root, &mut |path| {
        let relevant = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| matches!(ext, "rs" | "toml"));
        if !relevant {
            return;
        }

        let text = read(path).to_lowercase();
        for framework in FRAMEWORK_NAMES {
            if text.contains(framework) {
                failures.push(format!(
                    "{} contains forbidden framework name '{framework}'",
                    path.display()
                ));
            }
        }
    });
}

fn visit(path: &Path, f: &mut impl FnMut(&Path)) {
    let Ok(metadata) = fs::metadata(path) else { return };
    if metadata.is_file() {
        f(path);
        return;
    }
    let Ok(entries) = fs::read_dir(path) else { return };
    for entry in entries.flatten() {
        visit(&entry.path(), f);
    }
}

fn read(path: &Path) -> String {
    fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()))
}
