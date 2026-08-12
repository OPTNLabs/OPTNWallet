# Addon Sample Template

This folder is a copy/paste starting point for a new addon integration.

## Files
- `manifest.example.json`: manifest scaffold with safe defaults
- `ExampleAddonApp.tsx`: minimal SDK-based app component
- `host-switch.example.tsx`: `MarketplaceAppHost` switch-case snippet

## Quickstart
1. Copy `manifest.example.json` fields into `src/addons/builtin/index.ts`.
2. Copy `ExampleAddonApp.tsx` into `src/pages/apps/<your-addon>/`.
3. Import your app in `src/pages/apps/MarketplaceAppHost.tsx`.
4. Add the `switch` case from `host-switch.example.tsx`.
5. Ensure `config.screen` in manifest matches your case value.
6. Run:
   - `npm run addons:validate`
   - `npm run typecheck`

## Notes
- Template is intentionally outside `src/` so it does not ship by default.
- Keep all wallet interactions through `AddonSDK` only.
- Add capability entries only for methods your app actually uses.
