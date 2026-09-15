//! A second shell, deliberately not Tauri.
//!
//! `optn-ui-text` proves the *renderer* is replaceable. This proves the other
//! seam: the **shell**. A shell's whole job is to host the application, supply
//! OS capabilities the application cannot reach itself, and turn native
//! chrome — a menu bar, a window — into typed intent.
//!
//! `HeadlessShell` does all three with no Tauri, no webview, and no OS:
//!
//! - it implements [`AppTransport`], so a renderer talks to it unchanged;
//! - it supplies `scan_qr`, the capability a shell owns and a renderer must
//!   never reach for itself;
//! - it dispatches [`MenuCommand`]s, so native chrome drives the application
//!   through the same actions every other surface uses.
//!
//! If a future Dioxus or egui shell had to reimplement wallet behaviour rather
//! than just these three, this file would not compile against the same
//! contracts — which is what makes it a test rather than a claim.

use std::cell::RefCell;
use std::future::Future;
use std::task::{Context, Poll, Waker};

use optn_app::{AppAction, AppState, MenuCommand};
use optn_transport::{AppTransport, LocalTransport, TransportError, TransportFuture};

fn now<F: Future>(future: F) -> F::Output {
    let mut future = Box::pin(future);
    let waker = Waker::noop();
    let mut cx = Context::from_waker(waker);
    match future.as_mut().poll(&mut cx) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("the headless shell only drives ready transports"),
    }
}

/// A shell with no OS behind it.
///
/// Wraps the in-process transport and adds the one capability a shell owes a
/// renderer. Scans are queued rather than read from a camera, which is exactly
/// what a shell does: it decides *how* the payload is obtained.
pub struct HeadlessShell {
    inner: LocalTransport,
    /// Payloads a future `scan_qr` will return, oldest first.
    queued_scans: RefCell<Vec<String>>,
    /// Whether this shell claims a camera at all.
    has_camera: bool,
}

impl HeadlessShell {
    pub fn new(initial: AppState) -> Self {
        Self {
            inner: LocalTransport::new(initial),
            queued_scans: RefCell::new(Vec::new()),
            has_camera: true,
        }
    }

    /// A shell that cannot scan, like a popup with no camera permission.
    pub fn without_camera(initial: AppState) -> Self {
        Self {
            has_camera: false,
            ..Self::new(initial)
        }
    }

    /// Hand the next scan its payload.
    pub fn queue_scan(&self, payload: impl Into<String>) {
        self.queued_scans.borrow_mut().push(payload.into());
    }

    /// Native chrome raising a command, exactly as a menu click would.
    ///
    /// The shell decides *which* window the command belongs to; it does not
    /// decide what the command means. Anything the application owns comes
    /// back as an `AppAction` and is dispatched here.
    pub fn invoke_menu(&self, command: MenuCommand) -> Result<bool, TransportError> {
        match command.action() {
            Some(action) => {
                now(self.dispatch(action))?;
                Ok(true)
            }
            // Windows, file pickers and about boxes stay the shell's problem.
            None => Ok(false),
        }
    }

    pub fn snapshot_now(&self) -> Result<AppState, TransportError> {
        now(self.snapshot())
    }
}

impl AppTransport for HeadlessShell {
    fn dispatch<'a>(&'a self, action: AppAction) -> TransportFuture<'a, ()> {
        self.inner.dispatch(action)
    }

    fn snapshot<'a>(&'a self) -> TransportFuture<'a, AppState> {
        self.inner.snapshot()
    }

    fn next_event<'a>(&'a self) -> TransportFuture<'a, Option<optn_app::AppEvent>> {
        self.inner.next_event()
    }

    fn scan_qr<'a>(&'a self) -> TransportFuture<'a, String> {
        let payload = if self.has_camera {
            let mut queued = self.queued_scans.borrow_mut();
            if queued.is_empty() {
                None
            } else {
                Some(queued.remove(0))
            }
        } else {
            None
        };
        let has_camera = self.has_camera;
        Box::pin(async move {
            match payload {
                Some(text) => Ok(text),
                // A shell without a camera says Unsupported, which is how the
                // renderer knows to hide the control rather than fail on it.
                None if !has_camera => Err(TransportError::Unsupported),
                None => Err(TransportError::Other("no QR in view".into())),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TextRenderer;
    use optn_app::{AppRoute, AppSurface, Network};

    #[test]
    fn a_shell_that_is_not_tauri_hosts_the_whole_application() {
        // The three things a shell owes: host the app, supply a capability,
        // and turn native chrome into typed intent. No Tauri anywhere.
        let shell = HeadlessShell::new(AppState::for_surface(AppSurface::Desktop));

        // 1. Hosting: a renderer attaches to it unchanged.
        let state = shell.snapshot_now().expect("snapshot");
        assert_eq!(state.route, AppRoute::Landing);

        // 2. Native chrome: a menu click becomes an application action.
        assert!(
            shell.invoke_menu(MenuCommand::ToggleTheme).expect("toggle"),
            "the application owns the theme"
        );
        assert_ne!(shell.snapshot_now().unwrap().theme, state.theme);

        // Shell-owned items are handled by the shell, not smuggled into the
        // application as a no-op action.
        assert!(
            !shell.invoke_menu(MenuCommand::About).expect("about"),
            "an about box is the shell's own business"
        );

        // 3. Capability: the shell supplies the scanner.
        shell.queue_scan("xpub-from-a-camera");
        assert_eq!(
            now(shell.scan_qr()).expect("scan"),
            "xpub-from-a-camera",
            "a renderer never touches a camera itself"
        );
    }

    #[test]
    fn the_text_renderer_runs_on_this_shell_with_no_changes() {
        // The two seams compose: a non-Leptos renderer on a non-Tauri shell.
        // Neither knows about the other, which is the entire architecture.
        let shell = HeadlessShell::new(AppState::for_surface(AppSurface::Desktop));
        let mut ui = TextRenderer::attach(shell).expect("attach");

        assert_eq!(ui.screen().title, "OPTN Wallet");
        ui.dispatch(AppAction::SetNetwork(Network::Chipnet))
            .expect("network");
        ui.dispatch(AppAction::Navigate(AppRoute::CreateWallet))
            .expect("navigate");
        assert_eq!(ui.screen().title, "Create wallet");
    }

    #[test]
    fn a_shell_without_a_camera_reports_unsupported_rather_than_failing() {
        // The distinction the renderer relies on to hide the scan control
        // instead of offering one that always errors.
        let blind = HeadlessShell::without_camera(AppState::for_surface(AppSurface::Extension));
        assert_eq!(now(blind.scan_qr()), Err(TransportError::Unsupported));

        // A shell that has a camera but sees nothing is a different answer.
        let seeing = HeadlessShell::new(AppState::for_surface(AppSurface::Desktop));
        assert!(matches!(
            now(seeing.scan_qr()),
            Err(TransportError::Other(_))
        ));
    }

    #[test]
    fn every_menu_command_is_either_the_applications_or_the_shells() {
        // No command may fall through unhandled: a shell author enumerating
        // these gets a total answer, so nothing is silently dead.
        let shell = HeadlessShell::new(AppState::for_surface(AppSurface::Desktop));
        for command in MenuCommand::ALL {
            let handled_by_app = shell.invoke_menu(*command).expect("dispatch");
            assert_eq!(
                handled_by_app,
                command.action().is_some(),
                "{command:?} must be owned by exactly one side"
            );
        }
    }
}
