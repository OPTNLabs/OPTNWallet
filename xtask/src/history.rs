use serde::Deserialize;
use std::{collections::HashSet, path::Path};

#[derive(Debug, Deserialize)]
struct HistoryLedger {
    schema: u32,
    source_repository: String,
    snapshot_date: String,
    closed_pr_count: usize,
    pr: Vec<HistoryEntry>,
}

#[derive(Debug, Deserialize)]
struct HistoryEntry {
    number: u32,
    title: String,
    outcome: String,
    relevance: String,
    summary: String,
}

pub fn check(root: &Path, failures: &mut Vec<String>) {
    let path = root.join("rustification/closed-pr-history.toml");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) => {
            failures.push(format!("failed to read {}: {error}", path.display()));
            return;
        }
    };

    let ledger: HistoryLedger = match toml::from_str(&raw) {
        Ok(ledger) => ledger,
        Err(error) => {
            failures.push(format!(
                "{} is not valid closed-PR history TOML: {error}",
                path.display()
            ));
            return;
        }
    };

    if ledger.schema != 1 {
        failures.push(format!(
            "{} schema must be 1, got {}",
            path.display(),
            ledger.schema
        ));
    }
    if ledger.source_repository != "OPTNLabs/OPTNWallet" {
        failures.push(format!(
            "{} must describe OPTNLabs/OPTNWallet",
            path.display()
        ));
    }
    if ledger.snapshot_date.trim().is_empty() {
        failures.push(format!("{} snapshot_date is empty", path.display()));
    }
    if ledger.closed_pr_count != ledger.pr.len() {
        failures.push(format!(
            "{} declares {} closed PRs but contains {} entries",
            path.display(),
            ledger.closed_pr_count,
            ledger.pr.len()
        ));
    }

    let mut seen = HashSet::new();
    for entry in &ledger.pr {
        if !seen.insert(entry.number) {
            failures.push(format!(
                "{} contains duplicate PR #{}",
                path.display(),
                entry.number
            ));
        }
        if entry.title.trim().is_empty()
            || entry.summary.trim().is_empty()
            || entry.relevance.trim().is_empty()
        {
            failures.push(format!(
                "{} PR #{} is missing title/relevance/summary",
                path.display(),
                entry.number
            ));
        }
        if !matches!(entry.outcome.as_str(), "merged" | "closed-unmerged") {
            failures.push(format!(
                "{} PR #{} has unknown outcome '{}'",
                path.display(),
                entry.number,
                entry.outcome
            ));
        }
    }

    // These merged PRs carry wallet/security/protocol/release decisions that
    // Rustification must not accidentally erase. Their presence here makes the
    // historical contract machine-checked without making CI depend on GitHub.
    for required in [
        4_u32, 5, 6, 9, 10, 11, 13, 16, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 50, 53,
        56, 58, 60, 61, 62,
    ] {
        match ledger.pr.iter().find(|entry| entry.number == required) {
            Some(entry) if entry.outcome == "merged" => {}
            Some(_) => failures.push(format!(
                "{} PR #{} must be recorded as merged",
                path.display(),
                required
            )),
            None => failures.push(format!(
                "{} is missing required historical PR #{}",
                path.display(),
                required
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_history_snapshot_is_internally_consistent() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("xtask lives below workspace root");
        let mut failures = Vec::new();
        check(root, &mut failures);
        assert!(failures.is_empty(), "{failures:#?}");
    }
}
