//! Relays reached through the host's own dialer.
//!
//! The desktop already decides how every relay is reached -- the holder's Tor
//! switch, a relay they declared as their own, public addresses only for a
//! relay a peer named -- and opens the stream itself. A [`RelayDialer`] hands
//! that stream to rust-nostr, which runs the WebSocket over it, so Rust chat
//! follows the same egress as every other relay socket instead of a second
//! policy of its own.

use std::fmt;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use async_wsocket::Message as SocketMessage;
use futures::{Sink, StreamExt};
use nostr::types::Url;
use nostr_sdk::prelude::Error as ClientError;
use nostr_sdk::transport::websocket::{WebSocketSink, WebSocketStream, WebSocketTransport};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::tungstenite::{Error as WireError, Message as WireMessage};

/// Where a relay is: what a dialer needs to open a stream to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayEndpoint {
    pub host: String,
    pub port: u16,
    /// `wss`: the stream must be TLS to `host`.
    pub tls: bool,
}

impl RelayEndpoint {
    pub(crate) fn of(url: &Url) -> Result<Self, String> {
        let tls = match url.scheme() {
            "wss" => true,
            "ws" => false,
            other => return Err(format!("{other} is not a relay scheme")),
        };
        let host = url
            .host_str()
            .ok_or_else(|| format!("{url} names no host"))?
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned();
        let port = url
            .port_or_known_default()
            .ok_or_else(|| format!("{url} names no port"))?;
        Ok(Self { host, port, tls })
    }
}

/// A byte stream to a relay, TLS already applied for `wss`.
pub trait RelayIo: AsyncRead + AsyncWrite + Unpin + Send + 'static {}

impl<T> RelayIo for T where T: AsyncRead + AsyncWrite + Unpin + Send + 'static {}

/// A dialed stream, or why the host would not open one.
pub type Dialed = Pin<Box<dyn Future<Output = Result<Box<dyn RelayIo>, String>> + Send>>;

/// Opens streams to relays under the host's egress rules.
pub trait RelayDialer: Send + Sync + 'static {
    /// A stream to `endpoint`, or why it is not reached. Refusing is the
    /// dialer's call: rust-nostr reports it as that relay's failure.
    fn dial(&self, endpoint: RelayEndpoint) -> Dialed;
}

/// rust-nostr's transport over a [`RelayDialer`]: the dialer opens the
/// stream, the WebSocket handshake runs over it here.
#[derive(Clone)]
pub(crate) struct DialerTransport(pub(crate) Arc<dyn RelayDialer>);

impl fmt::Debug for DialerTransport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DialerTransport")
    }
}

impl WebSocketTransport for DialerTransport {
    fn support_ping(&self) -> bool {
        true
    }

    fn connect<'a>(
        &'a self,
        url: &'a Url,
        _proxy: Option<SocketAddr>,
    ) -> Pin<
        Box<dyn Future<Output = Result<(WebSocketSink, WebSocketStream), ClientError>> + Send + 'a>,
    > {
        Box::pin(async move {
            let endpoint = RelayEndpoint::of(url).map_err(ClientError::transport)?;
            let stream = self
                .0
                .dial(endpoint)
                .await
                .map_err(ClientError::transport)?;
            let (socket, _) = tokio_tungstenite::client_async(url.as_str(), stream)
                .await
                .map_err(ClientError::transport)?;
            let (sink, stream) = socket.split();
            let sink: WebSocketSink = Box::pin(DialedSink(sink));
            let stream: WebSocketStream = Box::pin(stream.filter_map(|next| async move {
                match next {
                    Ok(message) => from_wire(message).map(Ok),
                    Err(error) => Some(Err(ClientError::transport(error))),
                }
            }));
            Ok((sink, stream))
        })
    }
}

/// A frame read off the wire, as rust-nostr's socket message. Raw frames are
/// never yielded by a reading socket.
fn from_wire(message: WireMessage) -> Option<SocketMessage> {
    Some(match message {
        WireMessage::Text(text) => SocketMessage::Text(text.to_string()),
        WireMessage::Binary(data) => SocketMessage::Binary(data.to_vec()),
        WireMessage::Ping(data) => SocketMessage::Ping(data.to_vec()),
        WireMessage::Pong(data) => SocketMessage::Pong(data.to_vec()),
        WireMessage::Close(frame) => SocketMessage::Close(frame.map(Into::into)),
        WireMessage::Frame(_) => return None,
    })
}

/// The socket's write half, taking rust-nostr's messages. Errors are mapped
/// per call rather than with `sink_map_err` (rust-nostr #984).
struct DialedSink<S>(S);

impl<S> Sink<SocketMessage> for DialedSink<S>
where
    S: Sink<WireMessage, Error = WireError> + Unpin,
{
    type Error = ClientError;

    fn poll_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.0)
            .poll_ready(cx)
            .map_err(ClientError::transport)
    }

    fn start_send(mut self: Pin<&mut Self>, item: SocketMessage) -> Result<(), Self::Error> {
        Pin::new(&mut self.0)
            .start_send(item.into())
            .map_err(ClientError::transport)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.0)
            .poll_flush(cx)
            .map_err(ClientError::transport)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.0)
            .poll_close(cx)
            .map_err(ClientError::transport)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_endpoint_is_read_from_the_relay_url() {
        let endpoint = |url: &str| RelayEndpoint::of(&Url::parse(url).unwrap());
        assert_eq!(
            endpoint("wss://relay.example.org"),
            Ok(RelayEndpoint {
                host: "relay.example.org".into(),
                port: 443,
                tls: true
            })
        );
        assert_eq!(
            endpoint("ws://127.0.0.1:7777/path"),
            Ok(RelayEndpoint {
                host: "127.0.0.1".into(),
                port: 7777,
                tls: false
            })
        );
        assert_eq!(
            endpoint("ws://[::1]:7777"),
            Ok(RelayEndpoint {
                host: "::1".into(),
                port: 7777,
                tls: false
            })
        );
        assert!(endpoint("https://relay.example.org").is_err());
    }
}
