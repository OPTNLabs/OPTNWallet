use serde::Deserialize;
use std::{collections::BTreeMap, fs, path::Path};

const PLATFORMS: &[&str] = &[
    "windows",
    "linux",
    "macos",
    "android",
    "ios",
    "web",
    "extension",
];

#[derive(Debug, Deserialize)]
struct Matrix {
    schema: u32,
    platforms: Vec<String>,
    feature: Vec<Feature>,
}

#[derive(Debug, Deserialize)]
struct Feature {
    id: String,
    name: String,
    policy: BTreeMap<String, String>,
    evidence: BTreeMap<String, String>,
    #[serde(default)]
    evidence_refs: BTreeMap<String, String>,
    #[serde(default)]
    na_reason: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Pending,
    Na,
    Fail,
}

impl Verdict {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Pending => "pending",
            Self::Na => "na",
            Self::Fail => "fail",
        }
    }
}

pub fn run(root: &Path, production_ready: bool) {
    let path = root.join("rustification/parity-matrix.toml");
    let parsed = parse_matrix(&path);
    let mut failures = Vec::new();

    if parsed.schema != 1 {
        failures.push(format!(
            "{}: unsupported schema {}",
            path.display(),
            parsed.schema
        ));
    }
    if parsed.platforms != PLATFORMS {
        failures.push(format!(
            "{}: platforms must be exactly {PLATFORMS:?}",
            path.display()
        ));
    }

    let mut fail_cells = 0usize;
    let mut pending_cells = 0usize;
    let mut watch_only_row = String::new();
    println!(
        "{:<22} {:>8} {:>8} {:>8} {:>8} {:>8} {:>8} {:>10}",
        "feature", "windows", "linux", "macos", "android", "ios", "web", "extension"
    );

    for feature in &parsed.feature {
        let mut row = format!("{:<22}", feature.id);
        for platform in PLATFORMS {
            match verdict(feature, platform) {
                Ok(verdict) => {
                    match verdict {
                        Verdict::Fail => fail_cells += 1,
                        Verdict::Pending => pending_cells += 1,
                        Verdict::Pass | Verdict::Na => {}
                    }
                    row.push_str(&format!("{:>8}", verdict.as_str()));
                }
                Err(error) => {
                    fail_cells += 1;
                    failures.push(error);
                    row.push_str(&format!("{:>8}", "fail"));
                }
            }
        }
        println!("{row}  {}", feature.name);
        if feature.id == "watch_only" {
            watch_only_row = row;
        }
        collect_ref_failures(root, feature, &mut failures);
    }

    collect_source_drift(root, &parsed, &mut failures);

    if !failures.is_empty() {
        for failure in &failures {
            eprintln!("parity matrix: {failure}");
        }
        eprintln!("parity matrix integrity: FAIL");
        std::process::exit(1);
    }

    println!("parity matrix integrity: PASS");
    if !watch_only_row.is_empty() {
        println!("watch_only status:{watch_only_row}");
        println!(
            "note: pending means a packaged E2E test is referenced, not that this commit's APK passed it"
        );
    }
    println!("failing production-ready cells: {fail_cells}");
    println!("pending production-ready cells: {pending_cells}");
    if production_ready && (fail_cells > 0 || pending_cells > 0) {
        eprintln!(
            "production-ready: FAIL ({fail_cells} fail, {pending_cells} pending). This gate is informational; required CI jobs may still pass."
        );
        std::process::exit(1);
    }
    if production_ready {
        println!("production-ready: PASS");
    }
}

fn parse_matrix(path: &Path) -> Matrix {
    let text = fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    toml::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn verdict(feature: &Feature, platform: &str) -> Result<Verdict, String> {
    let policy = feature
        .policy
        .get(platform)
        .ok_or_else(|| format!("feature '{}' is missing policy for {platform}", feature.id))?;
    let evidence = feature.evidence.get(platform).ok_or_else(|| {
        format!(
            "feature '{}' is missing evidence for {platform}",
            feature.id
        )
    })?;
    match (policy.as_str(), evidence.as_str()) {
        ("pass", "e2e" | "device") => Ok(Verdict::Pass),
        ("pass", "e2e-declared") => Ok(Verdict::Pending),
        ("na", "hidden") => {
            if feature
                .na_reason
                .get(platform)
                .map(|reason| reason.trim().is_empty())
                .unwrap_or(true)
            {
                return Err(format!(
                    "feature '{}' marks {platform} na without na_reason",
                    feature.id
                ));
            }
            Ok(Verdict::Na)
        }
        ("pass" | "na", _) => Ok(Verdict::Fail),
        (other, _) => Err(format!(
            "feature '{}' {platform} policy '{other}' is not pass or na",
            feature.id
        )),
    }
}

fn collect_ref_failures(root: &Path, feature: &Feature, failures: &mut Vec<String>) {
    for platform in PLATFORMS {
        let evidence = feature.evidence.get(*platform).map(String::as_str);
        if evidence != Some("e2e") && evidence != Some("device") && evidence != Some("e2e-declared")
        {
            continue;
        }
        let Some(reference) = feature.evidence_refs.get(*platform) else {
            failures.push(format!(
                "feature '{}' {platform} claims {} evidence without evidence_refs",
                feature.id,
                evidence.unwrap_or("?")
            ));
            continue;
        };
        let (rel, token) = match reference.split_once("::") {
            Some((path, token)) => (path, Some(token)),
            None => (reference.as_str(), None),
        };
        let path = root.join(rel);
        if !path.is_file() {
            failures.push(format!(
                "feature '{}' {platform} evidence_refs path is missing: {rel}",
                feature.id
            ));
            continue;
        }
        if let Some(token) = token {
            let text = fs::read_to_string(&path).unwrap_or_default();
            if !text.contains(token) {
                failures.push(format!(
                    "feature '{}' {platform} evidence_refs token '{token}' not found in {rel}",
                    feature.id
                ));
            }
        }
    }
}

fn collect_source_drift(root: &Path, matrix: &Matrix, failures: &mut Vec<String>) {
    let Some(watch_only) = matrix
        .feature
        .iter()
        .find(|feature| feature.id == "watch_only")
    else {
        failures.push("matrix is missing watch_only".into());
        return;
    };
    let app = fs::read_to_string(root.join("crates/optn-app/src/lib.rs")).unwrap_or_default();
    if !app.contains("Self::Desktop | Self::Android | Self::Ios") {
        failures.push(
            "optn-app offers_watch_only no longer matches desktop/android/ios pass, web/extension na"
                .into(),
        );
    }

    for platform in ["windows", "linux", "macos"] {
        if watch_only.policy.get(platform).map(String::as_str) != Some("pass") {
            failures.push(format!("watch_only {platform} policy must be pass"));
        }
    }
    for platform in ["android", "ios"] {
        if watch_only.policy.get(platform).map(String::as_str) != Some("pass") {
            failures.push(format!("watch_only {platform} policy must be pass"));
        }
    }
    for platform in ["web", "extension"] {
        if watch_only.policy.get(platform).map(String::as_str) != Some("na") {
            failures.push(format!(
                "watch_only {platform} policy must stay na until the capability flags are flipped together"
            ));
        }
    }

    let capabilities =
        fs::read_to_string(root.join("src/platform/capabilities.ts")).unwrap_or_default();
    for (surface, expected) in [
        ("desktop", true),
        ("android", true),
        ("ios", true),
        ("web", false),
        ("extension", false),
    ] {
        if !capability_enabled(&capabilities, "watchOnlyWallet", surface, expected) {
            failures.push(format!(
                "src/platform/capabilities.ts watchOnlyWallet.{surface} drifted from the parity matrix"
            ));
        }
    }

    let Some(hardware) = matrix
        .feature
        .iter()
        .find(|feature| feature.id == "hardware_wallet")
    else {
        failures.push("matrix is missing hardware_wallet".into());
        return;
    };
    for platform in ["android", "ios", "web", "extension"] {
        if hardware.policy.get(platform).map(String::as_str) != Some("na") {
            failures.push(format!(
                "hardware_wallet {platform} must stay na (desktop USB only)"
            ));
        }
    }
}

fn capability_enabled(source: &str, capability: &str, surface: &str, expected: bool) -> bool {
    let Some(start) = source.find(capability) else {
        return false;
    };
    let window = source.get(start..start.saturating_add(800)).unwrap_or("");
    let needle = format!("{surface}: {expected}");
    window.contains(&needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feature(policy: &str, evidence: &str, na_reason: Option<&str>) -> Feature {
        let mut item = Feature {
            id: "watch_only".into(),
            name: "Watch-only".into(),
            policy: BTreeMap::from([("android".into(), policy.into())]),
            evidence: BTreeMap::from([("android".into(), evidence.into())]),
            evidence_refs: BTreeMap::new(),
            na_reason: BTreeMap::new(),
        };
        if let Some(reason) = na_reason {
            item.na_reason.insert("android".into(), reason.into());
        }
        item
    }

    #[test]
    fn pass_requires_packaged_e2e_or_device_evidence() {
        assert_eq!(
            verdict(&feature("pass", "e2e", None), "android"),
            Ok(Verdict::Pass)
        );
        assert_eq!(
            verdict(&feature("pass", "device", None), "android"),
            Ok(Verdict::Pass)
        );
        assert_eq!(
            verdict(&feature("pass", "e2e-declared", None), "android"),
            Ok(Verdict::Pending)
        );
        assert_eq!(
            verdict(&feature("pass", "unit", None), "android"),
            Ok(Verdict::Fail)
        );
        assert_eq!(
            verdict(&feature("pass", "none", None), "android"),
            Ok(Verdict::Fail)
        );
        assert_eq!(
            verdict(&feature("pass", "hidden", None), "android"),
            Ok(Verdict::Fail)
        );
    }

    #[test]
    fn declared_e2e_is_not_a_proven_pass() {
        // A referenced instrumented test is not proof that this commit's APK passed.
        assert_ne!(
            verdict(&feature("pass", "e2e-declared", None), "android"),
            Ok(Verdict::Pass)
        );
    }

    #[test]
    fn na_must_be_hidden_and_explained() {
        assert_eq!(
            verdict(
                &feature("na", "hidden", Some("desktop USB only")),
                "android"
            ),
            Ok(Verdict::Na)
        );
        assert!(verdict(&feature("na", "hidden", None), "android").is_err());
        assert_eq!(
            verdict(&feature("na", "unit", Some("no")), "android"),
            Ok(Verdict::Fail)
        );
    }

    #[test]
    fn accidental_absence_is_fail_not_na() {
        assert_eq!(
            verdict(&feature("pass", "none", None), "android"),
            Ok(Verdict::Fail)
        );
    }
}
