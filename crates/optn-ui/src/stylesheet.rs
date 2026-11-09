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
#[cfg(test)]
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
            include_str!("chain_sources.rs"),
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
    /// Every one of these renders unstyled today. Writing their rules is a
    /// design decision rather than a mechanical fix, so they are recorded
    /// rather than invented. Failure and caution text (`.error`,
    /// `.field-error`, `.warn`, `.warning`) were the defect that mattered --
    /// a failure read as ordinary body text -- and now use `--danger` and
    /// `--warning`.
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
        "hardware-section",
        "multisig-section",
        "row",
        "scan-button",
        "source-value",
        "stack",
        "threshold-select",
    ];

    /// The colour tokens of one theme block, by name.
    fn tokens(selector: &str) -> Vec<(String, String)> {
        let at = STYLE
            .find(&format!("{selector} {{"))
            .unwrap_or_else(|| panic!("{selector} is not in style.css"));
        let block = &STYLE[at..];
        let block = &block[..block.find('}').expect("a closed block")];
        block
            .lines()
            .filter_map(|line| {
                let (name, value) = line.trim().strip_prefix("--")?.split_once(':')?;
                Some((
                    name.trim().to_owned(),
                    value.trim().trim_end_matches(';').to_owned(),
                ))
            })
            .collect()
    }

    /// WCAG relative luminance of a `#rrggbb` colour.
    fn luminance(hex: &str) -> f64 {
        let hex = hex.strip_prefix('#').expect("a hex colour");
        let channel = |at: usize| {
            let value = f64::from(u8::from_str_radix(&hex[at..at + 2], 16).unwrap()) / 255.0;
            if value <= 0.039_28 {
                value / 12.92
            } else {
                ((value + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
    }

    /// `value` as `#rrggbb`: a translucent `rgba(...)` is laid over `under`,
    /// as it is drawn.
    fn solid(value: &str, under: &str) -> String {
        let Some(parts) = value
            .strip_prefix("rgba(")
            .and_then(|rest| rest.strip_suffix(')'))
        else {
            return value.to_owned();
        };
        let parts: Vec<f64> = parts
            .split(',')
            .map(|part| part.trim().parse().unwrap())
            .collect();
        let under = under.strip_prefix('#').expect("an opaque hex colour");
        let mut out = String::from("#");
        for (index, top) in parts[..3].iter().enumerate() {
            let below =
                f64::from(u8::from_str_radix(&under[index * 2..index * 2 + 2], 16).unwrap());
            let mixed = top * parts[3] + below * (1.0 - parts[3]);
            out.push_str(&format!("{:02x}", mixed.round() as u8));
        }
        out
    }

    fn contrast(a: &str, b: &str) -> f64 {
        let (a, b) = (luminance(a), luminance(b));
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }

    /// #71: body text stays readable, at WCAG 4.5:1, in all four modes and
    /// the default. Text, secondary text, failures and cautions are each
    /// checked against both the page and the surfaces drawn on it.
    #[test]
    fn text_meets_wcag_contrast_in_every_mode() {
        for selector in [
            ":root",
            ".app-shell.theme-light",
            ".app-shell.theme-gray",
            ".app-shell.dark",
            ".app-shell.theme-dark",
        ] {
            let tokens = tokens(selector);
            let token = |name: &str| {
                tokens
                    .iter()
                    .find(|(token, _)| token == name)
                    .map(|(_, value)| value.clone())
                    .unwrap_or_else(|| panic!("{selector} has no --{name}"))
            };
            let page = token("bg");
            for background in [page.clone(), solid(&token("surface"), &page)] {
                for text in ["text", "muted", "danger", "warning"] {
                    let ratio = contrast(&token(text), &background);
                    assert!(
                        ratio >= 4.5,
                        "{selector}: --{text} on {background} is {ratio:.2}:1"
                    );
                }
            }
        }
    }

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
