# Introduction

This context document is designed to seed an LLM conversation with meaningful otherwise hard to find information regarding XO template development.
During work sessions, any insights that are not covered in the primary sources should be added in a new sub section of the recent learnings section.

## Primary Sources (read these first)

1) Vision to Reality series (latest articles supersede older ones)

	https://stack.xo.cash/blog/

2) Type definitions:

	https://gitlab.com/GeneralProtocols/xo/types/-/raw/development/source/template.ts
	https://gitlab.com/GeneralProtocols/xo/types/-/raw/development/source/invitation.ts

3) Reference templates:

	https://gitlab.com/GeneralProtocols/xo/templates/-/raw/development/source/p2pkh.ts?ref_type=heads
	wrap.ts – service-provider / immutable-covenant pattern (link coming soon, please ask user to provide this file for now)

## Recent learnings (Add insights during development)

### Unpublished from 2026-06-03

- Keep low-level contract parameters out of requirements.variables; expose only friendly fields and derive the rest in named script fragments.
- Scenarios are the primary safety net before real funds; a template that fails its own scenarios should be rejected early.
