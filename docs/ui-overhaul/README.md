# Wallet UI layouts

Canonical product layouts for the OPTN Wallet UI overhaul.

Tracking issue: https://github.com/OPTNLabs/OPTNWallet/issues/71

Implement these screens. Do not replace them with another wallet's interface.

| File | Screen |
| --- | --- |
| `A_home_single.png` | Home, one portfolio source |
| `B_home_multi.png` | Home, several portfolio sources |
| `C_portfolio_breakdown.png` | Portfolio breakdown |
| `D_actions_collapsed.png` | Actions, basic |
| `E_actions_expanded.png` | Actions, advanced open |
| `F_network_mainnet.png` | Network, Mainnet |
| `G_network_chipnet_confirm.png` | Network switch confirmation |
| `H_add_portfolio_source.png` | Add portfolio source |
| `I_qr_idle.png` | Scan QR |
| `J_walletconnect_detected.png` | WalletConnect request |
| `K_payment_detected.png` | Payment request |
| `L_send_bch.png` | Send BCH |
| `M_send_cashtoken.png` | Send CashToken |
| `N_receive.png` | Receive |
| `O_cauldron_swap.png` | Cauldron swap |
| `P_cauldron_review.png` | Cauldron review |
| `Q_transaction_success.png` | Transaction success |

## Two crowdfunding products

Keep them separate. Do not merge them into one campaign UI.

| Product | What it is |
| --- | --- |
| Flipstarter | Public Flipstarter assurance campaigns, including self-hosted sites. Pledge, list pledges, cancel and reclaim the reserved UTXO. Wallet-side workflow only; do not replace their campaign host. |
| FundMe | OPTN CashStarter campaigns (`optn.builtin.fundme`). Own contracts, own host (`fundme.cash` / self-host). The CashStarter contract path still needs work. Leave it as its own product until that is solid. |

A Flipstarter pledge holds a UTXO. That hold is the same freeze/reserve primitive as the UTXO page, not a FundMe-only flag.

## UTXO freeze

The user can freeze a coin, see reserved vs spendable, label it, and spend a specific coin. Frozen coins stay out of ordinary send, Fusion, and Flipstarter selection unless the user unfreezes them. Policy lives in wallet/domain code, not in a renderer.

## Desktop vs mobile layout

Do not share one responsive stylesheet and hope `sm:` / `lg:` means desktop.

That is how earlier bugs happened: the Capacitor UI is mobile-first and `max-w-md`. The desktop build currently disables those breakpoints so every screen stays a phone column. Shared `sm:` then does nothing on desktop, or a mobile tweak leaks into desktop.

Rule:

- Domain and actions are shared (`optn-core` / `optn-app`).
- Mobile screens stay stacked, full-width, 44px targets, one column.
- Desktop screens that need space get an explicit desktop shell (module swap), two-pane or wide table, keyboard, no phone column.
- Do not use Tailwind breakpoints in shared components to switch product layout.
- Prove both the Capacitor build and the desktop Vite config. A swap that only works in one of them is a regression.
