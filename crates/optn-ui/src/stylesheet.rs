//! What the stylesheet promises, checked against the stylesheet.
//!
//! Two failures this catches, both silent.
//!
//! A class name that no rule defines renders an unstyled control. Nothing
//! errors: the button is there, it works, and it looks wrong. `TorSection`
//! shipped `class="button"` when the file's controls are `primary`,
//! `secondary` and `chip` -- caught here rather than by someone noticing a
//! plain grey rectangle.
//!
//! And a tap target below 44px is a control that fingers miss. It cannot be
//! computed from padding without a layout engine, so the rule is stated as an
//! explicit `min-height` and asserted, rather than inferred from `0.72rem`
//! padding and hoped to land above the line.

/// The stylesheet, compiled in so the test reads exactly what Trunk ships.
const STYLE: &str = include_str!("../style.css");

/// The smallest comfortable touch target, from every mobile HIG that states
/// one: 44 CSS pixels.
#[allow(dead_code)]
pub const MIN_TAP_TARGET_PX: u32 = 44;

#[cfg(test)]
mod tests {
    use super::*;

    /// Every `class="..."` literal in this crate's sources.
    fn classes_used() -> Vec<String> {
        let mut used = Vec::new();
        for source in [
            include_str!("settings.rs"),
            include_str!("tools.rs"),
            include_str!("onboarding.rs"),
            include_str!("airgap.rs"),
            include_str!("derivation.rs"),
            include_str!("hardware.rs"),
            include_str!("multisig.rs"),
            include_str!("scan.rs"),
            include_str!("security.rs"),
            include_str!("main.rs"),
        ] {
            let mut rest = source;
            while let Some(at) = rest.find("class=\"") {
                rest = &rest[at + 7..];
                let Some(end) = rest.find('"') else { break };
                let value = &rest[..end];
                rest = &rest[end..];
                // Skip interpolated values -- `class=move || ...` and format
                // strings are not literal class lists.
                if value.contains('{') || value.contains('}') {
                    continue;
                }
                for class in value.split_whitespace() {
                    let class = class.to_owned();
                    if !used.contains(&class) {
                        used.push(class);
                    }
                }
            }
        }
        used.sort();
        used
    }

    fn defines(class: &str) -> bool {
        // A selector mentions the class when `.name` appears followed by
        // something that cannot be part of an identifier.
        let needle = format!(".{class}");
        let mut rest = STYLE;
        while let Some(at) = rest.find(&needle) {
            let after = &rest[at + needle.len()..];
            let boundary = after
                .chars()
                .next()
                .is_none_or(|c| !c.is_alphanumeric() && c != '-' && c != '_');
            if boundary {
                return true;
            }
            rest = &rest[at + needle.len()..];
        }
        false
    }

    /// Classes the renderer uses that `style.css` has never defined.
    ///
    /// Every one of these renders unstyled today. That is a real defect --
    /// `.error` and `.warn` mean a failure message displays as ordinary body
    /// text -- but writing seventeen rules is a design decision rather than a
    /// mechanical fix, so they are recorded rather than invented.
    ///
    /// The list may shrink. It must not grow: a new undefined class is a new
    /// unstyled control, and this is the only thing that would notice.
    const UNSTYLED_TODAY: &[&str] = &[
        "advanced-list",
        "airgap-section",
        "back",
        "coin-control",
        "cosigner",
        "device-section",
        "error",
        "field-error",
        "hardware-section",
        "multisig-section",
        "row",
        "scan-button",
        "source-value",
        "stack",
        "threshold-select",
        "warn",
        "warning",
    ];

    #[test]
    fn no_new_class_is_left_unstyled() {
        let undefined: Vec<String> = classes_used()
            .into_iter()
            .filter(|class| !defines(class))
            .collect();
        let fresh: Vec<&String> = undefined
            .iter()
            .filter(|class| !UNSTYLED_TODAY.contains(&class.as_str()))
            .collect();
        assert!(
            fresh.is_empty(),
            "these classes are used in optn-ui and defined nowhere in style.css, so the \
             controls render unstyled: {fresh:?}"
        );

        // And the baseline stays honest: an entry that has since been styled
        // should leave the list rather than sit there implying work remains.
        let stale: Vec<&&str> = UNSTYLED_TODAY
            .iter()
            .filter(|class| defines(class))
            .collect();
        assert!(
            stale.is_empty(),
            "these are styled now and should be removed from UNSTYLED_TODAY: {stale:?}"
        );
    }

    #[test]
    fn interactive_controls_declare_a_44px_minimum_tap_target() {
        // Stated, not inferred. Padding plus line-height lands somewhere near
        // 42px, which is the kind of "nearly" that never gets revisited.
        for selector in [
            ".primary",
            ".secondary",
            ".chip",
            ".tab-item",
            ".settings-row",
        ] {
            let at = STYLE
                .find(selector)
                .unwrap_or_else(|| panic!("{selector} is not in style.css"));
            // The rule body this selector participates in.
            let body_start = STYLE[at..]
                .find('{')
                .map(|offset| at + offset)
                .unwrap_or_else(|| panic!("{selector} has no rule body"));
            let body_end = STYLE[body_start..]
                .find('}')
                .map(|offset| body_start + offset)
                .unwrap_or(STYLE.len());
            let body = &STYLE[body_start..body_end];
            assert!(
                body.contains(&format!("min-height: {MIN_TAP_TARGET_PX}px")),
                "{selector} declares no {MIN_TAP_TARGET_PX}px minimum tap target; a control \
                 smaller than that is one fingers miss"
            );
        }
    }

    #[test]
    fn the_shell_respects_the_devices_safe_areas() {
        // A wallet that paints under the notch or the home indicator hides the
        // control a holder is reaching for.
        for inset in ["env(safe-area-inset-top)", "env(safe-area-inset-bottom)"] {
            assert!(STYLE.contains(inset), "style.css never uses {inset}");
        }
    }
}
