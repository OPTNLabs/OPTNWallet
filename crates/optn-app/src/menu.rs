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
//!
//! And one more, learned from a bug rather than a design: **on macOS the Edit
//! and Window submenus are load-bearing.** AppKit routes Cmd+X/C/V/A into the
//! WebView only when the app menu carries those items, and Cmd+M / Cmd+W reach
//! the window the same way. Tauri's own default menu ships both; a hand-built
//! menu that omits them is exactly how pasting into the WalletConnect,
//! WizardConnect and CashConnect URI fields stopped working. So a macOS menu
//! without them is refused here rather than built, because a menu that looks
//! right while paste is dead is the failure that was hard to find.
//!
//! Those items are the operating system's own, not this application's. They act
//! on whatever has focus, and an application item that merely *claims* the same
//! chord is the bug rather than the fix.

use crate::{AppAction, AppRoute};

/// Which desktop the menu is being built for.
///
/// Only macOS needs the distinction, but it needs it badly enough to be worth
/// naming: WebView2 and WebKitGTK handle the edit chords themselves, and the
/// GTK backend has no Undo or Redo at all, so on Linux those items would render
/// permanently greyed out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum MenuPlatform {
    /// The app menu is mandatory, and so are Edit and Window.
    MacOs,
    Windows,
    Linux,
}

impl MenuPlatform {
    /// Whether this platform requires the application menu, and with it the
    /// Edit and Window submenus.
    pub const fn requires_app_menu(self) -> bool {
        matches!(self, Self::MacOs)
    }
}

/// An item the operating system owns outright.
///
/// These are not commands this application dispatches. A shell installs the
/// platform's own item -- Tauri calls them predefined items -- and the OS acts
/// on whatever has focus. Building a custom item with the same accelerator is
/// precisely the bug: it takes the chord and does nothing useful with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum NativeRole {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Maximize,
    CloseWindow,
    Fullscreen,
    Separator,
}

impl NativeRole {
    /// The Edit submenu, in order, separator included.
    pub const EDIT: &'static [Self] = &[
        Self::Undo,
        Self::Redo,
        Self::Separator,
        Self::Cut,
        Self::Copy,
        Self::Paste,
        Self::SelectAll,
    ];

    /// The Window submenu, in order.
    pub const WINDOW: &'static [Self] = &[
        Self::Minimize,
        Self::Maximize,
        Self::Separator,
        Self::CloseWindow,
    ];

    /// The keyboard chord the platform gives this role, where it has one.
    ///
    /// Listed so the application can be checked against it, not so anything
    /// here can claim it.
    pub const fn accelerator_key(self) -> Option<char> {
        match self {
            Self::Undo => Some('z'),
            // Cmd+Shift+Z on macOS, Ctrl+Y on Windows; both letters are spoken
            // for either way.
            Self::Redo => Some('y'),
            Self::Cut => Some('x'),
            Self::Copy => Some('c'),
            Self::Paste => Some('v'),
            Self::SelectAll => Some('a'),
            Self::Minimize => Some('m'),
            Self::CloseWindow => Some('w'),
            Self::Maximize | Self::Fullscreen | Self::Separator => None,
        }
    }
}

/// Letters the operating system's own edit items already own.
///
/// Nothing in [`MenuCommand::accelerator`] may use one. The list is checked by
/// a test rather than merely written down, so that adding, say, Cmd+A for
/// "select all wallets" later cannot silently kill pasting into a URI field --
/// which is exactly how the original bug would come back.
pub const NATIVE_EDIT_KEYS: &[char] = &['c', 'v', 'x', 'a', 'z', 'y'];

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
    /// The operating system's editing commands. macOS only, and mandatory
    /// there.
    Edit,
    Wallet,
    View,
    /// The operating system's window commands. macOS only, and mandatory there.
    Window,
    Tools,
    Help,
}

impl MenuSection {
    /// Every section, in the order they appear. `Edit` sits after `File` and
    /// `Window` before `Tools`, which is where macOS users look for them.
    pub const ALL: &'static [Self] = &[
        Self::File,
        Self::Edit,
        Self::Wallet,
        Self::View,
        Self::Window,
        Self::Tools,
        Self::Help,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::File => "File",
            Self::Edit => "Edit",
            Self::Wallet => "Wallet",
            Self::View => "View",
            Self::Window => "Window",
            Self::Tools => "Tools",
            Self::Help => "Help",
        }
    }

    /// The operating system's items in this section, if it is one of its own.
    ///
    /// A section with roles carries no [`MenuCommand`]s at all: the whole point
    /// is that the platform, not this application, acts on them.
    pub const fn native_roles(self) -> &'static [NativeRole] {
        match self {
            Self::Edit => NativeRole::EDIT,
            Self::Window => NativeRole::WINDOW,
            _ => &[],
        }
    }

    /// Whether this section belongs in the menu on this platform.
    pub const fn appears_on(self, platform: MenuPlatform) -> bool {
        match self {
            Self::Edit | Self::Window => platform.requires_app_menu(),
            _ => true,
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

/// One section of the menu bar, resolved for a platform and a wallet state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuBarSection {
    pub section: MenuSection,
    /// This application's items.
    pub entries: Vec<MenuEntry>,
    /// The operating system's items, which a shell installs as the platform's
    /// own rather than dispatching.
    pub native_roles: &'static [NativeRole],
}

/// The menu bar for the current state, section by section.
///
/// On macOS this always includes Edit and Window. They are the OS's, not this
/// application's, and leaving them out is how Cmd+V stopped reaching a URI
/// field -- so they are produced here rather than left to a shell to remember.
pub fn menu_bar(platform: MenuPlatform, wallet_is_open: bool) -> Vec<MenuBarSection> {
    MenuSection::ALL
        .iter()
        .copied()
        .filter(|section| section.appears_on(platform))
        .map(|section| {
            let entries = MenuCommand::ALL
                .iter()
                .copied()
                .filter(|command| command.section() == section)
                .map(|command| MenuEntry {
                    command,
                    enabled: wallet_is_open || !command.requires_wallet(),
                })
                .collect();
            MenuBarSection {
                section,
                entries,
                native_roles: section.native_roles(),
            }
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
        for section in menu_bar(MenuPlatform::MacOs, false) {
            for entry in section.entries {
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

        for section in menu_bar(MenuPlatform::MacOs, true) {
            assert!(section.entries.iter().all(|entry| entry.enabled));
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
            vec!["File", "Edit", "Wallet", "View", "Window", "Tools", "Help"]
        );
        // Every command lands in exactly one section, so none is unreachable.
        let placed: usize = menu_bar(MenuPlatform::MacOs, true)
            .iter()
            .map(|section| section.entries.len())
            .sum();
        assert_eq!(placed, MenuCommand::ALL.len());

        assert_eq!(MenuCommand::NewWallet.accelerator(), Some("CmdOrCtrl+N"));
        assert_eq!(MenuCommand::LockWallet.accelerator(), Some("CmdOrCtrl+L"));
        assert_eq!(MenuCommand::Send.accelerator(), None);
    }

    #[test]
    fn a_macos_menu_always_carries_edit_and_window() {
        // The bug this exists for: a hand-built menu that replaced Tauri's
        // default and left these out, after which Cmd+V into a WalletConnect,
        // WizardConnect or CashConnect URI field did nothing at all.
        let mac: Vec<MenuSection> = menu_bar(MenuPlatform::MacOs, false)
            .into_iter()
            .map(|section| section.section)
            .collect();
        assert!(mac.contains(&MenuSection::Edit), "{mac:?}");
        assert!(mac.contains(&MenuSection::Window), "{mac:?}");
        // In the order a macOS user looks for them.
        assert_eq!(
            mac,
            vec![
                MenuSection::File,
                MenuSection::Edit,
                MenuSection::Wallet,
                MenuSection::View,
                MenuSection::Window,
                MenuSection::Tools,
                MenuSection::Help,
            ]
        );

        // Elsewhere the WebView handles those chords itself, and the GTK
        // backend has no Undo or Redo at all, so the items would only render
        // permanently greyed out.
        for platform in [MenuPlatform::Windows, MenuPlatform::Linux] {
            let sections: Vec<MenuSection> = menu_bar(platform, false)
                .into_iter()
                .map(|section| section.section)
                .collect();
            assert!(!sections.contains(&MenuSection::Edit), "{platform:?}");
            assert!(!sections.contains(&MenuSection::Window), "{platform:?}");
            // And nothing this application owns goes missing with them.
            let placed: usize = menu_bar(platform, true)
                .iter()
                .map(|section| section.entries.len())
                .sum();
            assert_eq!(placed, MenuCommand::ALL.len(), "{platform:?}");
        }
    }

    #[test]
    fn the_operating_systems_items_are_never_this_applications_commands() {
        // Edit and Window carry roles a shell installs as the platform's own.
        // If they ever became MenuCommands, this application would be claiming
        // the chord and doing nothing useful with it -- which is the bug, not
        // the fix.
        for section in menu_bar(MenuPlatform::MacOs, true) {
            if section.native_roles.is_empty() {
                continue;
            }
            assert!(
                section.entries.is_empty(),
                "{:?} must be the OS's alone",
                section.section
            );
        }
        assert_eq!(MenuSection::Edit.native_roles(), NativeRole::EDIT);
        assert!(NativeRole::EDIT.contains(&NativeRole::Paste));
        assert!(NativeRole::WINDOW.contains(&NativeRole::CloseWindow));
    }

    #[test]
    fn no_application_accelerator_steals_a_native_edit_chord() {
        // A guard rather than a note. Adding, say, Cmd+A for "select all
        // wallets" later is exactly how pasting into a URI field would break
        // again, and it would break silently.
        for command in MenuCommand::ALL {
            let Some(accelerator) = command.accelerator() else {
                continue;
            };
            let key = accelerator
                .rsplit('+')
                .next()
                .and_then(|last| last.chars().next())
                .map(|c| c.to_ascii_lowercase())
                .expect("an accelerator names a key");
            assert!(
                !NATIVE_EDIT_KEYS.contains(&key),
                "{command:?} claims '{key}', which the operating system's edit \
                 items already own"
            );
        }
        // And the list really is the set those roles use.
        for role in NativeRole::EDIT {
            if let Some(key) = role.accelerator_key() {
                assert!(NATIVE_EDIT_KEYS.contains(&key), "{role:?} -> {key}");
            }
        }
    }
}
