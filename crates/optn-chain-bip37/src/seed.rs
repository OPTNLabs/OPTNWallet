//! Nodes from DNS seeds (#75 §21.3).
//!
//! A DNS seed is a name, not a node: each lookup answers with some of the
//! nodes its crawler last found working. A full node uses one in two ways, and
//! so does this:
//!
//! - **Direct**: look the name up. The answer is the list of nodes.
//! - **Through a proxy**: the name must not be looked up here (#75 §4.1), and
//!   a proxy resolves one address per connection. So the seed is reached
//!   through the proxy by name, the node it leads to is asked once for the
//!   addresses it knows (`getaddr`), and the connection is closed. Bitcoin
//!   Core calls this an addrfetch connection and makes one per seed when it
//!   runs behind a proxy that resolves names; BCHN's seed list relies on the
//!   same fallback.
//!
//! Either way the answer is a hint, like every bootstrap entry: the caller
//! decides which of the addresses it would dial.

use super::{
    connect_peer, encode_message, handshake, params_for, read_message_bounded, read_u32, read_u64,
    read_varint, take, Bip37Transport, BoundedReadError, CONNECT_TIMEOUT,
};
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Addresses kept from one seed's answer.
pub const MAX_SEED_NODES: usize = 64;
/// `NODE_NETWORK`: serves the whole chain. A pruned node cannot serve the old
/// blocks a wallet scan asks for.
const NODE_NETWORK: u64 = 1;
/// One `addr` message carries at most this many entries (Bitcoin Core's
/// `MAX_ADDR_TO_SEND`); a longer one is malformed.
const MAX_ADDR_ENTRIES: u64 = 1000;
/// Payload bytes read from one addrfetch peer. A full `addr` is 30 kB; the rest
/// is room for what a node sends unasked after the handshake.
const ADDR_FETCH_BYTES: usize = 256 * 1024;
/// How long a seed asked through Tor is waited on once connected.
///
/// A node derived from Bitcoin Core sends its own address at once, but holds
/// its reply to `getaddr` until its next address-relay tick: about 30 s apart
/// on average, and random. Bitcoin Core gives an addrfetch connection five
/// minutes. A wallet asks several seeds at once and uses the first answer, so
/// a minute each is enough for one of them to answer in full, and a seed that
/// does not leaves at least the node's own address.
pub const ADDR_FETCH_WAIT: Duration = Duration::from_secs(60);

/// The nodes the DNS seed `host` names for `network`, found as `transport`
/// allows: by DNS when direct, by addrfetch through Tor.
pub async fn seed_nodes(
    host: &str,
    port: u16,
    network: &str,
    transport: &Bip37Transport,
) -> Result<Vec<SocketAddr>, String> {
    match transport {
        Bip37Transport::Direct => lookup_seed(host, port).await,
        Bip37Transport::Tor { .. } => {
            addr_fetch(host, port, network, transport, ADDR_FETCH_WAIT).await
        }
    }
}

async fn lookup_seed(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let answer = tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::lookup_host((host, port)))
        .await
        .map_err(|_| format!("timed out looking up {host}"))?
        .map_err(|error| format!("could not look up {host}: {error}"))?;
    let mut nodes = Vec::new();
    for address in answer {
        if nodes.len() == MAX_SEED_NODES {
            break;
        }
        if !nodes.contains(&address) {
            nodes.push(address);
        }
    }
    if nodes.is_empty() {
        return Err(format!("{host} named no nodes"));
    }
    Ok(nodes)
}

/// Connect to `host` and ask the node there for the addresses it knows,
/// waiting at most `wait` once connected (see [`ADDR_FETCH_WAIT`]).
pub async fn addr_fetch(
    host: &str,
    port: u16,
    network: &str,
    transport: &Bip37Transport,
    wait: Duration,
) -> Result<Vec<SocketAddr>, String> {
    let mut stream = connect_peer(host, port, transport).await?;
    let deadline = tokio::time::Instant::now() + wait;
    let nodes = addr_fetch_on_stream(&mut stream, params_for(network).magic, deadline).await?;
    if nodes.is_empty() {
        return Err(format!("the node {host} led to named no full nodes"));
    }
    Ok(nodes)
}

/// The exchange itself: handshake, one `getaddr`, and the `addr` replies until
/// one names more than a single address. A lone address is the node
/// announcing itself, which can come first; Bitcoin Core ends an addrfetch on
/// the first reply longer than that, and so does this. Whatever was gathered
/// when the deadline passes or the node hangs up is the answer.
async fn addr_fetch_on_stream<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
    magic: [u8; 4],
    deadline: tokio::time::Instant,
) -> Result<Vec<SocketAddr>, String> {
    let left = deadline.saturating_duration_since(tokio::time::Instant::now());
    tokio::time::timeout_at(deadline, handshake(stream, magic, left))
        .await
        .map_err(|_| "timed out in the handshake".to_string())??;
    stream
        .write_all(&encode_message(magic, "getaddr", &[]))
        .await
        .map_err(|error| format!("getaddr send failed: {error}"))?;
    let mut nodes = Vec::new();
    let mut remaining = ADDR_FETCH_BYTES;
    loop {
        let (command, payload) =
            match read_message_bounded(stream, magic, deadline, remaining).await {
                Ok(message) => message,
                Err(BoundedReadError::Framing(error)) => return Err(error),
                Err(error) if nodes.is_empty() => return Err(format!("no addr reply: {error:?}")),
                Err(_) => return Ok(nodes),
            };
        remaining = remaining.saturating_sub(payload.len());
        match command.as_str() {
            "addr" => {
                let entries = parse_addr(&payload)?;
                for (services, address) in &entries {
                    if services & NODE_NETWORK != 0
                        && address.port() != 0
                        && nodes.len() < MAX_SEED_NODES
                        && !nodes.contains(address)
                    {
                        nodes.push(*address);
                    }
                }
                if entries.len() > 1 {
                    return Ok(nodes);
                }
            }
            "ping" => {
                stream
                    .write_all(&encode_message(magic, "pong", &payload))
                    .await
                    .map_err(|error| format!("pong send failed: {error}"))?;
            }
            _ => {}
        }
    }
}

/// An `addr` payload: each entry's services and address. IPv4 travels as
/// IPv4-mapped IPv6 and comes back as IPv4.
fn parse_addr(payload: &[u8]) -> Result<Vec<(u64, SocketAddr)>, String> {
    let mut pos = 0;
    let count = read_varint(payload, &mut pos)?;
    if count > MAX_ADDR_ENTRIES {
        return Err(format!("addr message with {count} entries"));
    }
    let mut entries = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let _seen = read_u32(payload, &mut pos)?;
        let services = read_u64(payload, &mut pos)?;
        let octets: [u8; 16] = take(payload, &mut pos, 16)?
            .try_into()
            .expect("16-byte slice");
        let port = u16::from_be_bytes(take(payload, &mut pos, 2)?.try_into().expect("2 bytes"));
        let v6 = Ipv6Addr::from(octets);
        let ip = v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4);
        entries.push((services, SocketAddr::new(ip, port)));
    }
    if pos != payload.len() {
        return Err("addr message has trailing bytes".into());
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{build_version_payload, read_message, IO_TIMEOUT};
    use std::net::Ipv4Addr;

    fn addr_payload(entries: &[(u64, SocketAddr)]) -> Vec<u8> {
        let mut payload = vec![entries.len() as u8];
        for (services, address) in entries {
            payload.extend_from_slice(&1_700_000_000u32.to_le_bytes());
            payload.extend_from_slice(&services.to_le_bytes());
            let v6 = match address.ip() {
                IpAddr::V4(v4) => v4.to_ipv6_mapped(),
                IpAddr::V6(v6) => v6,
            };
            payload.extend_from_slice(&v6.octets());
            payload.extend_from_slice(&address.port().to_be_bytes());
        }
        payload
    }

    fn v4(a: u8, b: u8, c: u8, d: u8, port: u16) -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(a, b, c, d)), port)
    }

    #[test]
    fn addr_entries_decode_with_ipv4_unmapped() {
        let v6: SocketAddr = "[2001:db8::7]:8333".parse().unwrap();
        let entries = [(1 | 4, v4(203, 0, 113, 9, 8333)), (1024, v6)];
        assert_eq!(parse_addr(&addr_payload(&entries)).unwrap(), entries);
        let mut long = addr_payload(&entries);
        long.push(0);
        assert!(parse_addr(&long).is_err());
        assert!(parse_addr(&[0xfd, 0xe9, 0x03]).is_err(), "1001 entries");
    }

    /// The node announces itself, pings, then answers `getaddr`: the reply is
    /// what comes back, pruned nodes left out, and the ping is answered.
    #[tokio::test]
    async fn an_addrfetch_waits_past_a_self_announcement_for_the_real_reply() {
        let magic = params_for("mainnet").magic;
        let (mut client, mut node) = tokio::io::duplex(64 * 1024);
        let full = v4(203, 0, 113, 1, 8333);
        let pruned = v4(203, 0, 113, 2, 8333);
        let other = v4(198, 51, 100, 3, 8333);
        let peer = tokio::spawn(async move {
            assert_eq!(
                read_message(&mut node, magic, IO_TIMEOUT).await.unwrap().0,
                "version"
            );
            node.write_all(&encode_message(magic, "version", &build_version_payload(1)))
                .await
                .unwrap();
            assert_eq!(
                read_message(&mut node, magic, IO_TIMEOUT).await.unwrap().0,
                "verack"
            );
            assert_eq!(
                read_message(&mut node, magic, IO_TIMEOUT).await.unwrap().0,
                "getaddr"
            );
            node.write_all(&encode_message(magic, "addr", &addr_payload(&[(1, full)])))
                .await
                .unwrap();
            node.write_all(&encode_message(magic, "ping", &7u64.to_le_bytes()))
                .await
                .unwrap();
            let (command, nonce) = read_message(&mut node, magic, IO_TIMEOUT).await.unwrap();
            assert_eq!(
                (command.as_str(), nonce),
                ("pong", 7u64.to_le_bytes().to_vec())
            );
            node.write_all(&encode_message(
                magic,
                "addr",
                &addr_payload(&[(1 << 10, pruned), (1 | 4, other), (1, full)]),
            ))
            .await
            .unwrap();
            // Anything after the reply is never read.
            node
        });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let nodes = addr_fetch_on_stream(&mut client, magic, deadline)
            .await
            .unwrap();
        assert_eq!(nodes, [full, other]);
        drop(peer.await.unwrap());
    }

    /// A node that never answers leaves what it said before the deadline, and
    /// one that said nothing is an error.
    #[tokio::test(start_paused = true)]
    async fn an_addrfetch_ends_at_its_deadline() {
        let magic = params_for("chipnet").magic;
        for announce in [false, true] {
            let (mut client, mut node) = tokio::io::duplex(64 * 1024);
            let lone = v4(203, 0, 113, 4, 48333);
            let peer = tokio::spawn(async move {
                read_message(&mut node, magic, IO_TIMEOUT).await.unwrap();
                node.write_all(&encode_message(magic, "version", &build_version_payload(1)))
                    .await
                    .unwrap();
                read_message(&mut node, magic, IO_TIMEOUT).await.unwrap();
                read_message(&mut node, magic, IO_TIMEOUT).await.unwrap();
                if announce {
                    node.write_all(&encode_message(magic, "addr", &addr_payload(&[(1, lone)])))
                        .await
                        .unwrap();
                }
                // Then silence, connection held open.
                tokio::time::sleep(Duration::from_secs(3600)).await;
                drop(node);
            });
            let deadline = tokio::time::Instant::now() + ADDR_FETCH_WAIT;
            let result = addr_fetch_on_stream(&mut client, magic, deadline).await;
            if announce {
                assert_eq!(result.unwrap(), [lone]);
            } else {
                assert!(result.is_err());
            }
            peer.abort();
        }
    }

    /// A seed that is a name on this machine answers by DNS like any other.
    #[tokio::test]
    async fn a_direct_seed_is_looked_up() {
        let nodes = seed_nodes("localhost", 18444, "regtest", &Bip37Transport::Direct)
            .await
            .unwrap();
        assert!(!nodes.is_empty());
        assert!(nodes
            .iter()
            .all(|node| node.ip().is_loopback() && node.port() == 18444));
    }
}
