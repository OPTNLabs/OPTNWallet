//! Framework-neutral section flow.
//!
//! Renderers (Leptos, later Dioxus, egui, Tauri webviews) do not own Back/Next.
//! They read [`FlowViewModel`] and dispatch [`crate::AppAction::GoBack`] /
//! [`crate::AppAction::AdvanceOnboarding`]. The mnemonic never lives here.

use crate::{AppRoute, SettingsRowId};

/// Desktop create: reveal seed → confirm words → path → name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CreateStep {
    #[default]
    Reveal,
    Confirm,
    Path,
    Name,
}

impl CreateStep {
    pub const fn title(self) -> &'static str {
        match self {
            Self::Reveal => "Write down your recovery phrase",
            Self::Confirm => "Confirm your recovery phrase",
            Self::Path => "Wallet setup",
            Self::Name => "Name this wallet",
        }
    }

    pub const fn next_label(self) -> &'static str {
        match self {
            Self::Reveal => "I wrote it down",
            Self::Confirm => "Confirm",
            Self::Path => "Continue",
            Self::Name => "Create wallet",
        }
    }

    pub const fn next(self) -> Option<Self> {
        match self {
            Self::Reveal => Some(Self::Confirm),
            Self::Confirm => Some(Self::Path),
            Self::Path => Some(Self::Name),
            Self::Name => None,
        }
    }

    pub const fn back(self) -> Option<Self> {
        match self {
            Self::Reveal => None,
            Self::Confirm => Some(Self::Reveal),
            Self::Path => Some(Self::Confirm),
            Self::Name => Some(Self::Path),
        }
    }
}

/// Desktop import: paste words → path → name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ImportStep {
    #[default]
    Words,
    Path,
    Name,
}

impl ImportStep {
    pub const fn title(self) -> &'static str {
        match self {
            Self::Words => "Import wallet",
            Self::Path => "Wallet setup",
            Self::Name => "Name this wallet",
        }
    }

    pub const fn next_label(self) -> &'static str {
        match self {
            Self::Words => "Continue",
            Self::Path => "Continue",
            Self::Name => "Import and open",
        }
    }

    pub const fn next(self) -> Option<Self> {
        match self {
            Self::Words => Some(Self::Path),
            Self::Path => Some(Self::Name),
            Self::Name => None,
        }
    }

    pub const fn back(self) -> Option<Self> {
        match self {
            Self::Words => None,
            Self::Path => Some(Self::Words),
            Self::Name => Some(Self::Path),
        }
    }
}

/// What the renderer should paint for Back/Next. No framework types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlowViewModel {
    pub route: AppRoute,
    pub create_step: CreateStep,
    pub import_step: ImportStep,
    pub settings_focus: Option<SettingsRowId>,
    pub title: &'static str,
    pub next_label: &'static str,
    pub back_label: &'static str,
    /// False on the last create/import step: the renderer must open the wallet.
    pub can_advance: bool,
}

pub fn flow_view_model(
    route: AppRoute,
    create_step: CreateStep,
    import_step: ImportStep,
    settings_focus: Option<SettingsRowId>,
) -> FlowViewModel {
    match route {
        AppRoute::CreateWallet => FlowViewModel {
            route,
            create_step,
            import_step,
            settings_focus,
            title: create_step.title(),
            next_label: create_step.next_label(),
            back_label: "Back",
            can_advance: create_step.next().is_some(),
        },
        AppRoute::ImportWallet => FlowViewModel {
            route,
            create_step,
            import_step,
            settings_focus,
            title: import_step.title(),
            next_label: import_step.next_label(),
            back_label: "Back",
            can_advance: import_step.next().is_some(),
        },
        AppRoute::Settings => FlowViewModel {
            route,
            create_step,
            import_step,
            settings_focus,
            title: settings_focus
                .map(SettingsRowId::title)
                .unwrap_or("Settings"),
            next_label: "",
            back_label: if settings_focus.is_some() {
                "Settings"
            } else {
                "Back"
            },
            can_advance: false,
        },
        _ => FlowViewModel {
            route,
            create_step,
            import_step,
            settings_focus,
            title: "",
            next_label: "",
            back_label: "Back",
            can_advance: false,
        },
    }
}

/// Word positions to confirm after reveal. First, middle, last — every renderer.
pub fn create_confirm_indices(word_count: usize) -> [usize; 3] {
    if word_count < 3 {
        return [0, 0, 0];
    }
    [0, word_count / 2, word_count - 1]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_matches_the_desktop_section_order() {
        assert_eq!(CreateStep::Reveal.next(), Some(CreateStep::Confirm));
        assert_eq!(CreateStep::Confirm.next(), Some(CreateStep::Path));
        assert_eq!(CreateStep::Path.next(), Some(CreateStep::Name));
        assert_eq!(CreateStep::Name.next(), None);
        assert_eq!(CreateStep::Confirm.back(), Some(CreateStep::Reveal));
        assert_eq!(CreateStep::Reveal.back(), None);
    }

    #[test]
    fn import_matches_the_desktop_section_order() {
        assert_eq!(ImportStep::Words.next(), Some(ImportStep::Path));
        assert_eq!(ImportStep::Path.next(), Some(ImportStep::Name));
        assert_eq!(ImportStep::Name.back(), Some(ImportStep::Path));
        assert_eq!(ImportStep::Words.back(), None);
    }

    #[test]
    fn confirm_indices_cover_a_24_word_phrase() {
        assert_eq!(create_confirm_indices(12), [0, 6, 11]);
        assert_eq!(create_confirm_indices(24), [0, 12, 23]);
    }
}
