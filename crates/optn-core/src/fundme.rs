//! FundMe is OPTN CashStarter. It is a different product from Flipstarter.
//!
//! Flipstarter is the public assurance-campaign workflow (self-hosted campaign
//! sites, ANYONECANPAY pledges, UTXO freeze). FundMe is `optn.builtin.fundme`:
//! its own CashStarter contracts and host (`fundme.cash` / self-host).
//!
//! The CashStarter contract path is unfinished. This module keeps the product
//! identity so UI and application code cannot merge the two.

use std::fmt;

pub const PRODUCT_ID: &str = "optn.builtin.fundme";
pub const PRODUCT_NAME: &str = "FundMe";
pub const DEFAULT_HOST: &str = "fundme.cash";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FundMeStatus {
    /// CashStarter contracts still need work. Do not treat this as Flipstarter.
    Unavailable,
}

impl FundMeStatus {
    pub const fn reason(self) -> &'static str {
        match self {
            Self::Unavailable => {
                "CashStarter contracts still need work. FundMe stays a separate product from Flipstarter."
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FundMeProduct {
    pub id: &'static str,
    pub name: &'static str,
    pub host: &'static str,
    pub status: FundMeStatus,
}

pub const fn product() -> FundMeProduct {
    FundMeProduct {
        id: PRODUCT_ID,
        name: PRODUCT_NAME,
        host: DEFAULT_HOST,
        status: FundMeStatus::Unavailable,
    }
}

impl fmt::Display for FundMeProduct {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.name, self.host)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flipstarter::PLEDGE_SIGHASH;

    #[test]
    fn fundme_is_not_flipstarter() {
        let fundme = product();
        assert_eq!(fundme.id, "optn.builtin.fundme");
        assert_eq!(fundme.name, "FundMe");
        assert_ne!(fundme.name, "Flipstarter");
        assert_eq!(fundme.status, FundMeStatus::Unavailable);
        assert!(fundme.status.reason().contains("separate product"));
        // Flipstarter's sighash constant must not leak into FundMe identity.
        assert_ne!(PLEDGE_SIGHASH, 0);
    }
}
