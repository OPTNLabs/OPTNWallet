# OPTN Wallet UX Improvement Plan

## Summary

The current UI is feature-rich, but it asks users to interpret too much at once. The main improvement is not more visual polish; it is clearer hierarchy, fewer equal-weight choices, and more task-first flows.

The goal is to make every screen answer one primary question:

- Home: What do I have, and what should I do next?
- Receive: Which address should I share?
- Send: Who am I sending to, and what am I sending?
- History: What happened recently?
- Apps: Which tool should I open?
- Settings: What do I configure or recover?

## Priority order

### 1. Clarify the home screen

Home currently behaves like a control room. It exposes balance, contracts, apps, Quantumroot, address creation, sync, and token inspection at the same level.

Change this to a simpler entry point:

- Keep balance and wallet status at the top.
- Make one primary next action obvious.
- Move less frequent actions into grouped secondary sections.
- Treat sync as a utility action, not a competing primary action.

Recommended home hierarchy:

1. Balance and network status
2. Primary action, likely receive/address creation
3. Secondary wallet tools
4. Advanced features
5. Token details

### 2. Turn Send into a guided flow

The send experience already has good building blocks, but it still feels like a dense form rather than a guided task.

Change this to:

- Recipient first
- Asset second
- Amount third
- Review last

Keep the review action prominent and make reset clearly secondary. If there is an advanced builder, frame it as an alternate path rather than a competing one.

### 3. Simplify Receive around one selected address

Receive currently shows too many addresses and address types at once. That forces users to understand wallet internals before they can share funds.

Change this to:

- Show one selected address clearly.
- Put the QR code and copy/share action front and center.
- Use tabs or segmented controls for main and change addresses.
- Separate Quantumroot into its own subsection if it remains relevant on this screen.

### 4. Reframe Apps by intent

The Apps screen is a flat grid of tools. That is technically complete, but it is not especially discoverable.

Change this to:

- Group tools by user intent.
- Add short “best for” descriptions.
- Highlight the most common or recommended apps first.
- Avoid making every tile feel equally important.

### 5. Reduce density in Transaction History

History is usable, but the current layout makes the user parse hashes and pagination before the status of the transaction is obvious.

Change this to:

- Put status first.
- Surface amount and direction when available.
- Make filtering controls compact.
- Consider simpler pagination if the current control set feels heavy.

### 6. Reorganize Settings into sections

Settings is acting like a catch-all. Security, integrations, support, network tools, and logout should not all compete in one grid.

Change this to:

- Group settings by purpose.
- Keep the theme toggle visible.
- Put destructive actions in a separate block.
- Give integrations a short explanation so they do not feel opaque.

## Screen-by-screen proposal

### Home

Current problems:

- Too many actions are visible at once.
- Feature labels compete with task labels.
- Advanced functionality appears before the user needs it.

Proposed layout:

- Header
- Balance card
- Primary action block
- Secondary tools block
- Token summary

Suggested copy changes:

- `Sync` -> `Refresh`
- `Show CashTokens` -> `View tokens`
- `Quantumroot Vaults` -> `Advanced vaults` or `Vaults`
- `Apps` -> keep as-is
- `Contracts` -> keep as-is if the audience already understands it

### Receive

Current problems:

- Too much address data is shown at once.
- Main and change addresses are visually similar.
- The action of sharing an address is not the strongest visual cue.

Proposed layout:

- Selected receive address
- Large QR code
- Copy/share actions
- Main/change address switcher
- Advanced receive modes

Suggested copy changes:

- `Main Addresses` -> `Receive`
- `Change Addresses` -> `Change addresses`
- Add short helper text for change addresses to explain why they exist

### Send

Current problems:

- The form is functional, but not strongly guided.
- Asset selection, destination, and amount all appear at roughly the same weight.
- The user must mentally assemble the send flow.

Proposed layout:

- Step 1: recipient
- Step 2: asset
- Step 3: amount
- Step 4: review

Suggested copy changes:

- `Simple Send` -> `Send`
- `Advanced` -> `Advanced builder`
- `Reset` should remain secondary

### Transaction History

Current problems:

- Transaction hashes dominate the list.
- Status is present, but not the first thing the eye sees.
- Pagination and filters take up a lot of attention.

Proposed layout:

- Filter toolbar
- Transaction list with strong status cues
- Pagination or “load more” footer

Suggested copy changes:

- `Newest first` / `Oldest first` is fine
- `10 per page` can become `Page size` if you want more clarity

### Apps

Current problems:

- The app grid is visually flat.
- Users have to know what each app does before they choose.
- There is no strong “recommended” path.

Proposed layout:

- Featured apps section
- Grouped categories
- Full catalog below

Suggested grouping:

- Create
- Distribute
- Sweep
- Swap
- Campaigns

### Settings

Current problems:

- Security, support, integration, and maintenance actions are mixed together.
- Log out is visually strong, but everything else is too uniform.

Proposed layout:

- Security
- Integrations
- Support
- Network tools
- Destructive actions

## Shared design-system changes

These changes will improve consistency across the app:

- Define one true primary button per screen.
- Make secondary buttons visually lighter.
- Reserve danger styling for destructive actions only.
- Use section headers more aggressively.
- Reduce repeated card emphasis so important cards can stand out.
- Prefer task language over internal feature names where possible.

## Copy cleanup recommendations

Use clearer labels where they reduce mental load:

- `Sync` -> `Refresh`
- `Show CashTokens` -> `View tokens`
- `Go Back` -> `Back to apps` or `All apps`
- `Quantumroot Vaults` -> `Vaults` or `Advanced vaults`
- `Simple Send` -> `Send`

Keep technical labels only when they help accuracy and are already familiar to the user.

## Implementation sequence

1. Rework Home hierarchy and copy.
2. Rework Send into a more guided flow.
3. Simplify Receive presentation.
4. Group Apps by intent.
5. Tighten Transaction History density.
6. Reorganize Settings into sections.
7. Normalize shared button and card hierarchy.

## Expected outcome

After these changes, the app should feel:

- easier to scan
- less crowded
- more task-oriented
- more confident in its primary actions
- less like a feature dump

