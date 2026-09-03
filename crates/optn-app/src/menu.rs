//! The desktop menu bar, as intent rather than as a widget.
//!
//! A native menu is built by the shell — Tauri today, something else later —
//! but *what each item means* is application state, so it lives here. A shell
//! turns a click into a [`MenuCommand`] and asks for its [`AppAction`]; it
//! never decides what "Lock Wallet" does. That is the same seam the renderer
//! uses, and it is why a different shell does not re-implement the menu's
//! behaviour, only its construction.
//!
//! Two rules are carried from the React implementation because both were
//! learned the hard way:
//!
//! **A menu command targets one window.** Tauri's `emit` goes to every target,
//! and the React notes record what that cost: routing an action to the right
//! window and then broadcasting "undoes the routing entirely: every window's
//! listener runs the command, so Lock Wallet locked every open wallet and
//! Export Wallet fired in all of them". A shell must deliver a command to the
//! window it was raised in.
//!
//! **Wallet-scoped items grey out when no wallet is open**, rather than
//! erroring when clicked.

use crate::{AppAction, AppRoute};

/// One item in the native menu bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum MenuCommand {
    NewWallet,
    ImportWallet,
    OpenWallet,
    LockWallet,
    Send,
    Receive,
    History,
    Settings,
    ToggleTheme,
    Console,
    About,
}

/// Which top-level menu an item sits under.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum MenuSection {
    File,
    Wallet,
    View,
    Tools,
    Help,
}

impl MenuSection {
    pub const ALL: &'static [Self] = &[
        Self::File,
        Self::Wallet,
        Self::View,
        Self::Tools,
        Self::Help,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::File => "File",
            Self::Wallet => "Wallet",
            Self::View => "View",
            Self::Tools => "Tools",
            Self::Help => "Help",
        }
    }
}

impl MenuCommand {
    pub const ALL: &'static [Self] = &[
        Self::NewWallet,
        Self::ImportWallet,
        Self::OpenWallet,
        Self::LockWallet,
        Self::Send,
        Self::Receive,
        Self::History,
        Self::Settings,
        Self::ToggleTheme,
        Self::Console,
        Self::About,
    ];

    /// The id a shell emits. Matches `src-tauri/src/menu.rs`.
    pub const fn id(self) -> &'static str {
        match self {
            Self::NewWallet => "new_wallet",
            Self::ImportWallet => "import_wallet",
            Self::OpenWallet => "open_wallet",
            Self::LockWallet => "lock_wallet",
            Self::Send => "send",
            Self::Receive => "receive",
            Self::History => "history",
            Self::Settings => "settings",
            Self::ToggleTheme => "toggle_theme",
            Self::Console => "console",
            Self::About => "about",
        }
    }

    /// Unknown ids are refused rather than ignored, so a shell and this list
    /// drifting apart is a visible failure instead of a dead menu item.
    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|item| item.id() == id)
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::NewWallet => "New Wallet",
            Self::ImportWallet => "Import Wallet",
            Self::OpenWallet => "Open Wallet…",
            Self::LockWallet => "Lock Wallet",
            Self::Send => "Send",
            Self::Receive => "Receive",
            Self::History => "Transaction History",
            Self::Settings => "Settings",
            Self::ToggleTheme => "Toggle Light / Dark",
            Self::Console => "Console / Logs",
            Self::About => "About OPTN Wallet",
        }
    }

    pub const fn section(self) -> MenuSection {
        match self {
            Self::NewWallet | Self::ImportWallet | Self::OpenWallet => MenuSection::File,
            Self::LockWallet | Self::Send | Self::Receive | Self::History => MenuSection::Wallet,
            Self::ToggleTheme => MenuSection::View,
            Self::Console | Self::Settings => MenuSection::Tools,
            Self::About => MenuSection::Help,
        }
    }

    pub const fn accelerator(self) -> Option<&'static str> {
        match self {
            Self::NewWallet => Some("CmdOrCtrl+N"),
            Self::OpenWallet => Some("CmdOrCtrl+O"),
            Self::LockWallet => Some("CmdOrCtrl+L"),
            Self::Settings => Some("CmdOrCtrl+,"),
            _ => None,
        }
    }

    /// Whether this item needs an open wallet.
    ///
    /// These grey out on the wallet picker rather than failing when clicked.
    pub const fn requires_wallet(self) -> bool {
        matches!(
            self,
            Self::LockWallet | Self::Send | Self::Receive | Self::History
        )
    }

    /// What the application should do.
    ///
    /// `None` means the shell owns it — creating a window, opening a file
    /// picker, showing an about box. Those are not application state, and
    /// pretending otherwise would drag a file dialog into `optn-app`.
    pub fn action(self) -> Option<AppAction> {
        match self {
            Self::LockWallet => Some(AppAction::LockWallet),
            Self::Send => Some(AppAction::Navigate(AppRoute::Send)),
            Self::Receive => Some(AppAction::Navigate(AppRoute::Receive)),
            Self::History => Some(AppAction::Navigate(AppRoute::History)),
            Self::Settings => Some(AppAction::Navigate(AppRoute::Settings)),
            Self::ToggleTheme => Some(AppAction::ToggleTheme),
            Self::NewWallet
            | Self::ImportWallet
            | Self::OpenWallet
            | Self::Console
            | Self::About => None,
        }
    }
}

/// One rendered menu item, with its enabled state resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MenuEntry {
    pub command: MenuCommand,
    pub enabled: bool,
}

/// The menu bar for the current state, section by section.
pub fn menu_bar(wallet_is_open: bool) -> Vec<(MenuSection, Vec<MenuEntry>)> {
    MenuSection::ALL
        .iter()
        .map(|section| {
            let entries = MenuCommand::ALL
                .iter()
                .copied()
                .filter(|command| command.section() == *section)
                .map(|command| MenuEntry {
                    command,
                    enabled: wallet_is_open || !command.requires_wallet(),
                })
                .collect();
            (*section, entries)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wallet_scoped_items_grey_out_with_no_wallet_open() {
        // They grey out rather than failing when clicked, which is what the
        // React menu does on the picker window.
        for (_, entries) in menu_bar(false) {
            for entry in entries {
                assert_eq!(
                    entry.enabled,
                    !entry.command.requires_wallet(),
                    "{:?} enabled state is wrong with no wallet",
                    entry.command
                );
            }
        }
        assert!(MenuCommand::LockWallet.requires_wallet());
        assert!(MenuCommand::Send.requires_wallet());
        // Opening or creating a wallet must stay reachable from the picker.
        assert!(!MenuCommand::NewWallet.requires_wallet());
        assert!(!MenuCommand::OpenWallet.requires_wallet());

        for (_, entries) in menu_bar(true) {
            assert!(entries.iter().all(|entry| entry.enabled));
        }
    }

    #[test]
    fn every_id_round_trips_and_an_unknown_one_is_refused() {
        // A shell and this list drifting apart should be a visible failure,
        // not a menu item that quietly does nothing.
        for command in MenuCommand::ALL {
            assert_eq!(MenuCommand::from_id(command.id()), Some(*command));
            assert!(!command.label().is_empty());
        }
        assert_eq!(MenuCommand::from_id("open_the_pod_bay_doors"), None);
        assert_eq!(MenuCommand::from_id(""), None);
    }

    #[test]
    fn the_application_owns_behaviour_and_the_shell_owns_windows() {
        // Anything that maps to an AppAction is the same in every shell.
        assert_eq!(
            MenuCommand::LockWallet.action(),
            Some(AppAction::LockWallet)
        );
        assert_eq!(
            MenuCommand::Send.action(),
            Some(AppAction::Navigate(AppRoute::Send))
        );
        assert_eq!(
            MenuCommand::ToggleTheme.action(),
            Some(AppAction::ToggleTheme)
        );

        // And anything that needs a window, a file picker or an about box is
        // the shell's, so a file dialog never gets dragged into optn-app.
        for shell_owned in [
            MenuCommand::NewWallet,
            MenuCommand::ImportWallet,
            MenuCommand::OpenWallet,
            MenuCommand::Console,
            MenuCommand::About,
        ] {
            assert_eq!(shell_owned.action(), None, "{shell_owned:?}");
        }
    }

    #[test]
    fn the_sections_match_the_native_menu_they_were_ported_from() {
        assert_eq!(
            MenuSection::ALL
                .iter()
                .map(|s| s.label())
                .collect::<Vec<_>>(),
            vec!["File", "Wallet", "View", "Tools", "Help"]
        );
        // Every command lands in exactly one section, so none is unreachable.
        let placed: usize = menu_bar(true).iter().map(|(_, items)| items.len()).sum();
        assert_eq!(placed, MenuCommand::ALL.len());

        assert_eq!(MenuCommand::NewWallet.accelerator(), Some("CmdOrCtrl+N"));
        assert_eq!(MenuCommand::LockWallet.accelerator(), Some("CmdOrCtrl+L"));
        assert_eq!(MenuCommand::Send.accelerator(), None);
    }
}
