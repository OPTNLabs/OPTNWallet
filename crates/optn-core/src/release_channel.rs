//! Which published releases a holder has opted in to see.
//!
//! The release workflow already encodes the channel in the tag it publishes:
//! `main` produces `v1.7.4`, `staging` produces `v1.7.4-beta.128`, and a
//! hand-dispatched tag carries whatever suffix was typed. So the channel is
//! read back out of the tag rather than tracked beside it, which means a
//! release cannot be published into one channel and advertised in another.
//!
//! Opting in is additive and off by default. Stable only, unless the holder
//! asks for beta; beta includes stable; alpha includes both. Nobody is shown a
//! prerelease they did not ask for, and nobody who asked for alpha is left
//! behind on a stable that is older than the alpha they are running.
//!
//! There is no I/O here. Fetching the list of releases is the shell's job;
//! this decides what the list means.

/// How finished a release claims to be.
///
/// Ordered deliberately: `Stable < Beta < Alpha` is "how much unfinished work
/// you are willing to see", not "how good it is".
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ReleaseChannel {
    Stable,
    Beta,
    Alpha,
}

impl ReleaseChannel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
            Self::Alpha => "alpha",
        }
    }

    /// The channel a holder sees, from two independent opt-ins.
    ///
    /// Alpha wins when both are set: someone who asked for alpha has asked for
    /// everything, and showing them only beta would be a quieter setting than
    /// the one they chose.
    pub const fn from_opt_ins(beta: bool, alpha: bool) -> Self {
        if alpha {
            Self::Alpha
        } else if beta {
            Self::Beta
        } else {
            Self::Stable
        }
    }

    /// Does a holder on this channel get to see `release`?
    pub const fn accepts(self, release: Self) -> bool {
        (release as u8) <= (self as u8)
    }
}

/// A parsed release tag: `v1.7.4`, `v1.7.4-beta.128`, `v1.7.4-alpha.3`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseTag {
    pub version: [u32; 3],
    pub channel: ReleaseChannel,
    /// The number after the channel name, so two betas of one version order.
    pub iteration: u32,
}

impl ReleaseTag {
    /// Parse a published tag, or `None` if it is not one of ours.
    ///
    /// Unknown suffixes are **alpha**, not stable. A tag this build does not
    /// recognise is an unfinished thing by every reading available, and
    /// treating it as stable would offer it to the holders who asked for the
    /// least risk.
    pub fn parse(tag: &str) -> Option<Self> {
        let tag = tag.strip_prefix('v').unwrap_or(tag);
        let (core, suffix) = match tag.split_once('-') {
            Some((core, suffix)) => (core, Some(suffix)),
            None => (tag, None),
        };

        let mut parts = core.split('.');
        let mut version = [0u32; 3];
        for slot in &mut version {
            *slot = parts.next()?.parse().ok()?;
        }
        if parts.next().is_some() {
            return None;
        }

        let (channel, iteration) = match suffix {
            None => (ReleaseChannel::Stable, 0),
            Some(suffix) => {
                let (name, iteration) = match suffix.split_once('.') {
                    Some((name, rest)) => (name, rest.parse().unwrap_or(0)),
                    None => (suffix, 0),
                };
                let channel = match name {
                    // `rc` is a release candidate: more finished than alpha,
                    // and still not something a stable-only holder asked for.
                    "beta" | "rc" => ReleaseChannel::Beta,
                    "alpha" => ReleaseChannel::Alpha,
                    _ => ReleaseChannel::Alpha,
                };
                (channel, iteration)
            }
        };

        Some(Self {
            version,
            channel,
            iteration,
        })
    }

    /// Order for "is this newer".
    ///
    /// Within one version number, a stable release is newer than any
    /// prerelease of it -- `1.7.4` supersedes `1.7.4-beta.9`, which is what
    /// semver means and what a holder expects when the final build lands.
    fn rank(&self) -> (u32, u32, u32, u8, u32) {
        // Stable sorts above prereleases, so it is inverted here.
        let finished = match self.channel {
            ReleaseChannel::Stable => 2,
            ReleaseChannel::Beta => 1,
            ReleaseChannel::Alpha => 0,
        };
        (
            self.version[0],
            self.version[1],
            self.version[2],
            finished,
            self.iteration,
        )
    }

    pub fn is_newer_than(&self, other: &Self) -> bool {
        self.rank() > other.rank()
    }
}

/// The release to offer, out of everything published.
///
/// `current` is what is running. Returns `None` when nothing published beats
/// it on this channel, which is the normal answer and must not be dressed up
/// as an error.
pub fn newest_offer<'a>(
    current: &str,
    channel: ReleaseChannel,
    published: impl IntoIterator<Item = &'a str>,
) -> Option<String> {
    let running = ReleaseTag::parse(current)?;
    let mut best: Option<(ReleaseTag, &str)> = None;
    for tag in published {
        let Some(parsed) = ReleaseTag::parse(tag) else {
            continue;
        };
        if !channel.accepts(parsed.channel) {
            continue;
        }
        if !parsed.is_newer_than(&running) {
            continue;
        }
        if best
            .as_ref()
            .is_none_or(|(current_best, _)| parsed.is_newer_than(current_best))
        {
            best = Some((parsed, tag));
        }
    }
    best.map(|(_, tag)| tag.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_workflows_own_tag_shapes_parse() {
        // Exactly what .github/workflows/release.yml publishes: `v${version}`
        // from main and `v${version}-beta.${RUN_NUMBER}` from staging.
        let stable = ReleaseTag::parse("v1.7.4").expect("stable");
        assert_eq!(stable.version, [1, 7, 4]);
        assert_eq!(stable.channel, ReleaseChannel::Stable);

        let beta = ReleaseTag::parse("v1.7.4-beta.128").expect("beta");
        assert_eq!(beta.channel, ReleaseChannel::Beta);
        assert_eq!(beta.iteration, 128);

        let alpha = ReleaseTag::parse("v1.8.0-alpha.3").expect("alpha");
        assert_eq!(alpha.channel, ReleaseChannel::Alpha);

        // A hand-dispatched release candidate.
        assert_eq!(
            ReleaseTag::parse("v1.7.0-rc.1").unwrap().channel,
            ReleaseChannel::Beta
        );
    }

    #[test]
    fn an_unrecognised_suffix_is_alpha_rather_than_stable() {
        // The direction matters. Reading an unknown suffix as stable would
        // offer it to the holders who opted into the least risk.
        assert_eq!(
            ReleaseTag::parse("v1.7.4-nightly.2").unwrap().channel,
            ReleaseChannel::Alpha
        );
        assert_eq!(
            ReleaseTag::parse("v1.7.4-wip").unwrap().channel,
            ReleaseChannel::Alpha
        );
    }

    #[test]
    fn things_that_are_not_our_tags_are_refused() {
        for tag in ["", "v", "latest", "1.7", "v1.7.4.1", "vX.Y.Z", "release-7"] {
            assert!(ReleaseTag::parse(tag).is_none(), "{tag} parsed");
        }
    }

    #[test]
    fn opting_in_is_additive_and_off_by_default() {
        assert_eq!(
            ReleaseChannel::from_opt_ins(false, false),
            ReleaseChannel::Stable
        );
        assert_eq!(
            ReleaseChannel::from_opt_ins(true, false),
            ReleaseChannel::Beta
        );
        assert_eq!(
            ReleaseChannel::from_opt_ins(false, true),
            ReleaseChannel::Alpha
        );
        // Both: alpha, because that holder asked for everything.
        assert_eq!(
            ReleaseChannel::from_opt_ins(true, true),
            ReleaseChannel::Alpha
        );

        assert!(ReleaseChannel::Stable.accepts(ReleaseChannel::Stable));
        assert!(!ReleaseChannel::Stable.accepts(ReleaseChannel::Beta));
        assert!(ReleaseChannel::Beta.accepts(ReleaseChannel::Stable));
        assert!(!ReleaseChannel::Beta.accepts(ReleaseChannel::Alpha));
        assert!(ReleaseChannel::Alpha.accepts(ReleaseChannel::Beta));
    }

    #[test]
    fn a_stable_holder_is_never_offered_a_prerelease() {
        // The whole point of the default.
        let published = ["v1.7.4", "v1.8.0-beta.1", "v1.9.0-alpha.7"];
        assert_eq!(
            newest_offer("v1.7.4", ReleaseChannel::Stable, published),
            None
        );
        assert_eq!(
            newest_offer("v1.7.3", ReleaseChannel::Stable, published),
            Some("v1.7.4".into())
        );
    }

    #[test]
    fn beta_sees_staging_and_alpha_sees_everything() {
        let published = ["v1.7.4", "v1.8.0-beta.1", "v1.9.0-alpha.7"];
        assert_eq!(
            newest_offer("v1.7.4", ReleaseChannel::Beta, published),
            Some("v1.8.0-beta.1".into())
        );
        assert_eq!(
            newest_offer("v1.7.4", ReleaseChannel::Alpha, published),
            Some("v1.9.0-alpha.7".into())
        );
    }

    #[test]
    fn the_finished_build_supersedes_its_own_prereleases() {
        // Someone running 1.7.4-beta.9 should be moved onto 1.7.4 when it
        // lands, not told they are already current.
        let published = ["v1.7.4", "v1.7.4-beta.9"];
        assert_eq!(
            newest_offer("v1.7.4-beta.9", ReleaseChannel::Beta, published),
            Some("v1.7.4".into())
        );
        // And not dragged backwards onto the beta once on the stable.
        assert_eq!(
            newest_offer("v1.7.4", ReleaseChannel::Beta, published),
            None
        );
    }

    #[test]
    fn two_betas_of_one_version_order_by_their_run_number() {
        let published = ["v1.7.5-beta.7", "v1.7.5-beta.128", "v1.7.5-beta.9"];
        assert_eq!(
            newest_offer("v1.7.4", ReleaseChannel::Beta, published),
            Some("v1.7.5-beta.128".into())
        );
    }

    #[test]
    fn a_running_build_no_one_can_parse_offers_nothing() {
        // Refusing to guess. Offering an "update" against an unreadable
        // current version could walk someone backwards.
        assert_eq!(
            newest_offer("not-a-version", ReleaseChannel::Alpha, ["v9.9.9"]),
            None
        );
    }

    #[test]
    fn junk_in_the_published_list_is_skipped_not_fatal() {
        let published = ["latest", "v1.8.0", "nightly", ""];
        assert_eq!(
            newest_offer("v1.7.4", ReleaseChannel::Stable, published),
            Some("v1.8.0".into())
        );
    }
}
