//! The seam a host swaps renderers across.
//!
//! "The renderer is swappable" is only worth saying if a host can be written
//! once and pointed at a different one. That is what this module is: a trait
//! narrow enough that a renderer can satisfy it without giving anything up,
//! and a host function that drives *any* renderer without naming one.
//!
//! Swapping is then the type, and nothing else:
//!
//! ```ignore
//! type Ui<T> = optn_ui_text::TextRenderer<T>;   // ← the one line
//! // type Ui<T> = optn_ui_egui::EguiRenderer<T>;
//!
//! let painted = optn_transport::run::<_, Ui<_>>(transport, &script)?;
//! ```
//!
//! `optn-ui-text` and `optn-ui-egui` both implement it — one drawing plain
//! text with no framework at all, the other laying widgets out through a real
//! immediate-mode toolkit with its own event model. Each crate runs the same
//! script through [`run`] and asserts the same facts about what came back, so
//! the claim is a compiled artifact rather than a paragraph.
//!
//! Note what the trait does *not* carry: no wallet type, no view model, no
//! screen struct. A renderer that needed one of those in the seam would be a
//! renderer the host had to know about.

use optn_app::{AppAction, AppState};

use crate::{AppTransport, TransportError};

use std::future::Future;
use std::task::{Context, Poll, Waker};

/// Poll an already-ready future to completion.
///
/// Deliberately not an async runtime. `LocalTransport`'s futures are ready the
/// moment they are made, and a renderer proving portability must not have to
/// bring a runtime with it to be tested.
pub fn block_on_ready<F: Future>(future: F) -> F::Output {
    let mut future = Box::pin(future);
    let waker = Waker::noop();
    let mut cx = Context::from_waker(waker);
    match future.as_mut().poll(&mut cx) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("this host only drives already-ready transports"),
    }
}

/// Everything a host needs from a renderer.
///
/// Three things: attach to a transport, dispatch an action, and say what is on
/// screen. A renderer that needs more than this from its host is not
/// swappable, and a host that needs more than this from its renderer has taken
/// on a dependency it does not need.
pub trait Renderer<T: AppTransport>: Sized {
    /// Take the first snapshot, as any renderer must before drawing.
    fn attach(transport: T) -> Result<Self, TransportError>;

    /// Dispatch and re-read. This is the whole renderer/application contract.
    fn dispatch(&mut self, action: AppAction) -> Result<(), TransportError>;

    /// The state this renderer last drew.
    fn state(&self) -> &AppState;

    /// Every piece of text this renderer put on screen for that state.
    ///
    /// Text rather than pixels, because it is the one thing every renderer can
    /// honestly answer — and it is enough to tell whether a screen carries the
    /// field it was supposed to.
    fn painted(&self) -> Vec<String>;
}

/// Drive a renderer through a script and report what it drew.
///
/// The host does not know which renderer it has. That is the point: swapping
/// one for another changes the type at the call site and nothing here.
pub fn run<T, R>(transport: T, script: &[AppAction]) -> Result<Vec<String>, TransportError>
where
    T: AppTransport,
    R: Renderer<T>,
{
    let mut ui = R::attach(transport)?;
    for action in script {
        ui.dispatch(action.clone())?;
    }
    Ok(ui.painted())
}
