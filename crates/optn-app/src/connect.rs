//! Connecting to a dapp, and answering what it asks for.
//!
//! Three protocols reach the wallet through one control. The user pastes or
//! scans a URI; the scheme decides which session layer takes it; and when that
//! session later wants something signed, a request appears over whatever the
//! user was doing. `optn-core`'s `classify_scanned_payload` says *what* a
//! payload is. This says what the wallet does about it.
//!
//! The rules here are the ones the React implementation learned:
//!
//! **The connect popup closes the moment a request arrives.** Otherwise the
//! "paste a URI" sheet sits on top of the approval the user now has to read.
//!
//! **A pending request is answered once.** The desktop review gate names
//! duplicate execution outright, and it is the expensive kind of bug: a second
//! approval of the same proposal is a second transaction.
//!
//! **Pairing is guarded against re-entry.** A double tap on Connect must not
//! start two pairings for one URI, so a submission in flight refuses another.
//!
//! **A wallet that cannot sign cannot approve.** Watch-only wallets and the
//! read-only browser build get a refusal with a reason, not a signing attempt
//! that fails somewhere further down.
//!
//! **Changing or closing the wallet cancels everything.** A request belongs to
//! the session that raised it; carrying one across a lock or a wallet switch
//! would ask the wrong wallet to sign.

use optn_core::scan::{CASHCONNECT_URI_SCHEME, WALLETCONNECT_URI_SCHEME, WIZARDCONNECT_URI_SCHEME};

use crate::{AppSurface, SpendingCapability};

/// A session layer the wallet speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ConnectProtocol {
    /// Nostr-based, and the wallet's own.
    CashConnect,
    WalletConnect,
    WizardConnect,
}

impl ConnectProtocol {
    pub const ALL: &'static [Self] = &[Self::CashConnect, Self::WalletConnect, Self::WizardConnect];

    pub const fn label(self) -> &'static str {
        match self {
            Self::CashConnect => "CashConnect",
            Self::WalletConnect => "WalletConnect",
            Self::WizardConnect => "WizardConnect",
        }
    }

    /// The URI scheme this protocol's invites carry.
    pub const fn scheme(self) -> &'static str {
        match self {
            Self::CashConnect => CASHCONNECT_URI_SCHEME,
            Self::WalletConnect => WALLETCONNECT_URI_SCHEME,
            Self::WizardConnect => WIZARDCONNECT_URI_SCHEME,
        }
    }

    /// Whether pairing needs a wallet already open.
    ///
    /// CashConnect and WizardConnect both bind a session to a wallet id at
    /// pairing time and refuse without one. WalletConnect pairs first and
    /// chooses an account later, so it does not.
    pub const fn needs_open_wallet(self) -> bool {
        matches!(self, Self::CashConnect | Self::WizardConnect)
    }

    /// Whether the user sees the URI and approves before pairing starts.
    ///
    /// WizardConnect shows the shortened URI and waits; the other two begin as
    /// soon as the payload is recognised, because their own session layer
    /// raises a proposal the user then approves.
    pub const fn confirms_uri_before_pairing(self) -> bool {
        matches!(self, Self::WizardConnect)
    }
}

/// What a connected session is asking the wallet to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum RequestKind {
    /// A new session wants to be allowed in.
    SessionProposal,
    /// A transaction to sign and broadcast.
    SignTransaction,
    /// A message to sign. No coins move.
    SignMessage,
    /// A named contract action to execute.
    ExecuteAction,
}

impl RequestKind {
    /// Whether answering this yes moves money.
    ///
    /// A message signature does not, which is why a watch-only wallet may still
    /// be asked for one.
    pub const fn spends(self) -> bool {
        matches!(self, Self::SignTransaction | Self::ExecuteAction)
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::SessionProposal => "Connection request",
            Self::SignTransaction => "Signature request",
            Self::SignMessage => "Message signature request",
            Self::ExecuteAction => "Action request",
        }
    }
}

/// One thing a session is waiting on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectRequest {
    pub protocol: ConnectProtocol,
    pub kind: RequestKind,
    /// Who is asking, as the session reported it. Untrusted display text.
    pub origin: String,
    /// The session layer's own id for this request, so an answer names it.
    pub id: String,
}

/// Why a request cannot be approved by this wallet on this build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalBlock {
    /// No wallet is open.
    NoWallet,
    /// The wallet holds public keys only.
    WatchOnly,
    /// The build is a viewer.
    ViewerOnly,
}

impl ApprovalBlock {
    pub const fn message(self) -> &'static str {
        match self {
            Self::NoWallet => "open a wallet before answering this request",
            Self::WatchOnly => {
                "this is a watch-only wallet: it can show the request but cannot sign it"
            }
            Self::ViewerOnly => "this build can view a wallet but not sign for it",
        }
    }
}

/// The connect control and whatever it is waiting on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConnectState {
    /// The "paste or scan a URI" sheet.
    pub popup_open: bool,
    /// What the user has typed or scanned so far.
    pub uri: String,
    /// A camera scan is running.
    pub scanning: bool,
    /// A pairing is in flight.
    pub submitting: bool,
    /// A WizardConnect URI shown for approval before pairing begins.
    pub awaiting_approval: Option<String>,
    /// The request the user is being asked to answer.
    pub request: Option<ConnectRequest>,
}

impl ConnectState {
    pub const fn new() -> Self {
        Self {
            popup_open: false,
            uri: String::new(),
            scanning: false,
            submitting: false,
            awaiting_approval: None,
            request: None,
        }
    }

    /// Open the "paste or scan" sheet.
    ///
    /// Refused while a request is up: the sheet would cover the approval the
    /// user is meant to be reading.
    pub fn open_popup(&mut self) -> bool {
        if self.request.is_some() {
            return false;
        }
        self.popup_open = true;
        true
    }

    pub fn close_popup(&mut self) {
        self.popup_open = false;
    }

    /// Whether another pairing may start.
    ///
    /// A double tap on Connect, or a scan that fires while one is already in
    /// flight, would otherwise pair the same URI twice.
    pub const fn can_submit(&self) -> bool {
        !self.submitting && !self.scanning
    }

    /// Begin pairing. `false` means one is already running.
    pub fn begin_submit(&mut self) -> bool {
        if !self.can_submit() {
            return false;
        }
        self.submitting = true;
        true
    }

    pub fn finish_submit(&mut self) {
        self.submitting = false;
    }

    /// Begin a camera scan. `false` means the camera or a pairing is busy.
    pub fn begin_scan(&mut self) -> bool {
        if !self.can_submit() {
            return false;
        }
        self.scanning = true;
        true
    }

    pub fn finish_scan(&mut self) {
        self.scanning = false;
    }

    /// Hold a WizardConnect URI for the user to approve before pairing.
    pub fn await_approval(&mut self, uri: impl Into<String>) {
        self.awaiting_approval = Some(uri.into());
    }

    /// A session raised something for the user to answer.
    ///
    /// The sheet closes, and a request already up is not replaced: answering
    /// the one on screen comes first, or a session could push its proposal in
    /// front of another's just as the user reached for Approve.
    pub fn raise(&mut self, request: ConnectRequest) -> bool {
        if self.request.is_some() {
            return false;
        }
        self.popup_open = false;
        self.awaiting_approval = None;
        self.request = Some(request);
        true
    }

    /// Answer the request, and forget it.
    ///
    /// `None` when there was nothing to answer -- which is how a second
    /// approval of the same request becomes a no-op rather than a second
    /// transaction.
    pub fn resolve(&mut self) -> Option<ConnectRequest> {
        self.request.take()
    }

    /// Everything belonging to the wallet that is going away.
    ///
    /// A request belongs to the session that raised it. Carrying one across a
    /// lock, a wallet switch or a network change would ask a different wallet
    /// to sign something it never saw.
    pub fn cancel_all(&mut self) {
        *self = Self::new();
    }

    /// Whether this wallet, on this build, may approve the pending request.
    pub fn approval_block(
        &self,
        surface: AppSurface,
        capability: Option<SpendingCapability>,
    ) -> Option<ApprovalBlock> {
        let request = self.request.as_ref()?;
        // A connection request commits nothing on its own, so it is answerable
        // by any open wallet.
        if !request.kind.spends() {
            return match capability {
                None => Some(ApprovalBlock::NoWallet),
                Some(_) => None,
            };
        }
        match capability {
            None => Some(ApprovalBlock::NoWallet),
            Some(SpendingCapability::WatchOnly) => Some(ApprovalBlock::WatchOnly),
            Some(_) if surface.is_viewer_only() => Some(ApprovalBlock::ViewerOnly),
            Some(_) => None,
        }
    }
}

/// Which of several pending things the user is shown first.
///
/// The React selectors coalesce in a fixed order -- CashConnect's proposal
/// before WalletConnect's, then CashConnect's action, then WalletConnect's
/// transaction, then its message. Ported as an ordering rather than a
/// coalescing chain so it can be stated and tested: proposals before actions,
/// and CashConnect before the rest, because it is the wallet's own protocol and
/// its sessions are short-lived.
pub fn most_urgent(pending: &[ConnectRequest]) -> Option<&ConnectRequest> {
    pending.iter().min_by_key(|request| {
        let by_kind = match request.kind {
            RequestKind::SessionProposal => 0,
            RequestKind::ExecuteAction => 1,
            RequestKind::SignTransaction => 2,
            RequestKind::SignMessage => 3,
        };
        let by_protocol = match request.protocol {
            ConnectProtocol::CashConnect => 0,
            ConnectProtocol::WalletConnect => 1,
            ConnectProtocol::WizardConnect => 2,
        };
        (by_kind, by_protocol)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(protocol: ConnectProtocol, kind: RequestKind) -> ConnectRequest {
        ConnectRequest {
            protocol,
            kind,
            origin: "example.dapp".into(),
            id: format!("{protocol:?}-{kind:?}"),
        }
    }

    #[test]
    fn a_request_closes_the_connect_sheet_it_would_otherwise_cover() {
        let mut state = ConnectState::new();
        assert!(state.open_popup());
        assert!(state.popup_open);

        assert!(state.raise(request(
            ConnectProtocol::CashConnect,
            RequestKind::SessionProposal
        )));
        assert!(!state.popup_open, "the sheet must get out of the way");

        // And it cannot be reopened over the request.
        assert!(!state.open_popup());
        assert!(!state.popup_open);
    }

    #[test]
    fn a_request_is_answered_once_and_a_second_answer_does_nothing() {
        // Duplicate execution is named in the review gate for this feature, and
        // a second approval of a signature request is a second transaction.
        let mut state = ConnectState::new();
        state.raise(request(
            ConnectProtocol::WalletConnect,
            RequestKind::SignTransaction,
        ));

        let answered = state.resolve().expect("the first answer resolves it");
        assert_eq!(answered.kind, RequestKind::SignTransaction);
        assert_eq!(state.resolve(), None, "the second answer must do nothing");
        assert!(state.request.is_none());
    }

    #[test]
    fn one_request_is_not_pushed_in_front_of_another() {
        // Otherwise a session could replace the proposal on screen just as the
        // user reached for Approve, and the tap would land on something else.
        let mut state = ConnectState::new();
        let first = request(ConnectProtocol::CashConnect, RequestKind::SessionProposal);
        assert!(state.raise(first.clone()));
        assert!(!state.raise(request(
            ConnectProtocol::WalletConnect,
            RequestKind::SignTransaction
        )));
        assert_eq!(state.request.as_ref(), Some(&first));
    }

    #[test]
    fn a_pairing_already_in_flight_refuses_another() {
        // A double tap on Connect, or a scan completing into a submit that is
        // already running, would otherwise pair the same URI twice.
        let mut state = ConnectState::new();
        assert!(state.begin_submit());
        assert!(!state.begin_submit(), "the second tap does nothing");
        assert!(!state.begin_scan(), "and neither does the camera");
        state.finish_submit();
        assert!(state.begin_submit(), "and it is available again after");
    }

    #[test]
    fn a_scan_in_progress_blocks_a_submit_and_the_other_way_round() {
        let mut state = ConnectState::new();
        assert!(state.begin_scan());
        assert!(!state.can_submit());
        assert!(!state.begin_submit());
        state.finish_scan();
        assert!(state.can_submit());
    }

    #[test]
    fn a_watch_only_wallet_may_be_asked_but_may_not_sign() {
        // It can show the request -- that is the point of watch-only -- but
        // approving anything that moves coins has to fail here, with a reason,
        // rather than further down where the failure has no explanation.
        let mut state = ConnectState::new();
        state.raise(request(
            ConnectProtocol::CashConnect,
            RequestKind::SignTransaction,
        ));
        assert_eq!(
            state.approval_block(AppSurface::Desktop, Some(SpendingCapability::WatchOnly)),
            Some(ApprovalBlock::WatchOnly)
        );
        assert_eq!(
            state.approval_block(AppSurface::Desktop, Some(SpendingCapability::Seed)),
            None
        );
        // A hardware wallet signs on the device, so it is not blocked here.
        assert_eq!(
            state.approval_block(AppSurface::Desktop, Some(SpendingCapability::Hardware)),
            None
        );
        assert_eq!(
            state.approval_block(AppSurface::Desktop, None),
            Some(ApprovalBlock::NoWallet)
        );
    }

    #[test]
    fn a_connection_request_commits_nothing_so_watch_only_can_answer_it() {
        let mut state = ConnectState::new();
        state.raise(request(
            ConnectProtocol::WalletConnect,
            RequestKind::SessionProposal,
        ));
        assert_eq!(
            state.approval_block(AppSurface::Desktop, Some(SpendingCapability::WatchOnly)),
            None,
            "connecting is not spending"
        );
        assert!(!RequestKind::SessionProposal.spends());
        assert!(!RequestKind::SignMessage.spends(), "no coins move");
        assert!(RequestKind::SignTransaction.spends());
        assert!(RequestKind::ExecuteAction.spends());
    }

    #[test]
    fn the_read_only_build_cannot_sign_for_a_wallet_it_can_read() {
        // The same boundary the send path enforces: the popup ships without a
        // key lifecycle, so it refuses rather than hiding the button.
        let mut state = ConnectState::new();
        state.raise(request(
            ConnectProtocol::WalletConnect,
            RequestKind::SignTransaction,
        ));
        assert_eq!(
            state.approval_block(AppSurface::Extension, Some(SpendingCapability::Seed)),
            Some(ApprovalBlock::ViewerOnly)
        );
        // Watch-only is reported ahead of it: the wallet has no key at all, and
        // that is the more useful thing to say.
        assert_eq!(
            state.approval_block(AppSurface::Extension, Some(SpendingCapability::WatchOnly)),
            Some(ApprovalBlock::WatchOnly)
        );
    }

    #[test]
    fn closing_the_wallet_cancels_every_pending_thing() {
        // A request belongs to the session that raised it. Carried across a
        // lock or a wallet switch, it would ask a different wallet to sign
        // something it never saw.
        let mut state = ConnectState::new();
        state.open_popup();
        state.uri = "wc:something@2".into();
        state.begin_submit();
        state.await_approval("wiz://relay.example/abc");
        state.request = Some(request(
            ConnectProtocol::CashConnect,
            RequestKind::ExecuteAction,
        ));

        state.cancel_all();

        assert_eq!(state, ConnectState::new());
        assert!(state.request.is_none());
        assert!(state.uri.is_empty());
        assert!(!state.submitting);
        assert!(state.awaiting_approval.is_none());
    }

    #[test]
    fn each_protocol_knows_what_pairing_it_needs() {
        // CashConnect and WizardConnect bind a session to a wallet id at
        // pairing time; WalletConnect pairs first and picks an account later.
        assert!(ConnectProtocol::CashConnect.needs_open_wallet());
        assert!(ConnectProtocol::WizardConnect.needs_open_wallet());
        assert!(!ConnectProtocol::WalletConnect.needs_open_wallet());

        // Only WizardConnect shows the URI and waits before pairing.
        assert!(ConnectProtocol::WizardConnect.confirms_uri_before_pairing());
        assert!(!ConnectProtocol::CashConnect.confirms_uri_before_pairing());

        // The schemes come from the classifier, so there is one definition of
        // each and a renderer cannot invent a fourth.
        assert_eq!(ConnectProtocol::CashConnect.scheme(), "bch-cc-v1:");
        assert_eq!(ConnectProtocol::WalletConnect.scheme(), "wc:");
        assert_eq!(ConnectProtocol::WizardConnect.scheme(), "wiz://");
        for protocol in ConnectProtocol::ALL {
            assert!(!protocol.label().is_empty());
            assert!(!protocol.scheme().is_empty());
        }
    }

    #[test]
    fn a_proposal_is_shown_before_an_action_and_cashconnect_before_the_rest() {
        let pending = vec![
            request(ConnectProtocol::WalletConnect, RequestKind::SignMessage),
            request(ConnectProtocol::WalletConnect, RequestKind::SignTransaction),
            request(ConnectProtocol::CashConnect, RequestKind::ExecuteAction),
            request(ConnectProtocol::WalletConnect, RequestKind::SessionProposal),
            request(ConnectProtocol::CashConnect, RequestKind::SessionProposal),
        ];
        let first = most_urgent(&pending).expect("something is pending");
        assert_eq!(first.protocol, ConnectProtocol::CashConnect);
        assert_eq!(first.kind, RequestKind::SessionProposal);

        // With no proposal, the action leads.
        let actions: Vec<ConnectRequest> = pending
            .into_iter()
            .filter(|r| r.kind != RequestKind::SessionProposal)
            .collect();
        let first = most_urgent(&actions).expect("something is pending");
        assert_eq!(first.protocol, ConnectProtocol::CashConnect);
        assert_eq!(first.kind, RequestKind::ExecuteAction);

        assert_eq!(most_urgent(&[]), None);
    }
}
