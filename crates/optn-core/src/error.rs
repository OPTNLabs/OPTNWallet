//! Error kinds and the exit codes they map to.
//!
//! A script needs to tell "you typed the address wrong" apart from "the server
//! is unreachable" without parsing English. Each kind gets a distinct exit
//! code, and those codes are part of the CLI's contract — see docs/cli.md.

use std::fmt;

#[derive(Debug)]
pub enum CliError {
    /// Bad input from the caller: malformed address, unusable flag.
    Usage(String),
    /// Could not reach the server at all.
    Network(String),
    /// Reached it, but it answered with something unusable.
    Protocol(String),
    /// Reached it, and it returned an explicit error.
    Server(String),
    /// A defect in this program.
    Internal(String),
}

pub type Result<T> = std::result::Result<T, CliError>;

impl CliError {
    pub fn exit_code(&self) -> i32 {
        match self {
            CliError::Usage(_) => 2,
            CliError::Network(_) => 3,
            CliError::Protocol(_) => 4,
            CliError::Server(_) => 5,
            CliError::Internal(_) => 70,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            CliError::Usage(_) => "usage",
            CliError::Network(_) => "network",
            CliError::Protocol(_) => "protocol",
            CliError::Server(_) => "server",
            CliError::Internal(_) => "internal",
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CliError::Usage(m)
            | CliError::Network(m)
            | CliError::Protocol(m)
            | CliError::Server(m)
            | CliError::Internal(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for CliError {}
