# Build completeness

`packaging/release-assets.json` is the authoritative release inventory: **28
required assets**, including all seven CLI targets when the CLI crate is present.
No release assets are waived. Preview builds and release packages are different:
a successful compile is not evidence that an installer or signed device package
was produced.

| Platform                                | Pull-request validation / artifacts                      | Required release artifacts                 |
| --------------------------------------- | -------------------------------------------------------- | ------------------------------------------ |
| Windows x64                             | Native debug compile and binary check                    | NSIS `.exe`, MSI `.msi`                    |
| macOS Apple Silicon                     | Native debug compile and binary check                    | `.dmg`, `.app.zip`                         |
| macOS Intel                             | Native debug compile and binary check                    | `.dmg`, `.app.zip`                         |
| Linux x64                               | Native debug binary, DEB, installed Flatpak verification | AppImage, DEB, RPM, Flatpak                |
| Linux ARM64                             | Native debug binary, DEB, installed Flatpak verification | AppImage, DEB, RPM, Flatpak                |
| Linux riscv64 desktop                   | Cross-built binary with architecture check               | Unbundled binary                           |
| Android Play                            | Debug APK plus emulator checks                           | Play APK and AAB                           |
| Android F-Droid                         | Debug APK plus emulator checks                           | F-Droid APK                                |
| iOS                                     | Unsigned simulator `.app` in a verified ZIP              | Simulator ZIP; **not a signed device IPA** |
| Chrome extension                        | Built extension directory                                | Extension ZIP                              |
| Firefox extension                       | Built extension directory                                | Extension ZIP                              |
| CLI Linux x64 / ARM64 / riscv64 / ARMv7 | One binary per target; cross-target architecture checks  | Four CLI binaries                          |
| CLI macOS Apple Silicon / Intel         | One binary per target                                    | Two CLI binaries                           |
| CLI Windows x64                         | CLI executable                                           | CLI `.exe`                                 |

Full/manual desktop previews also require Windows installers, macOS disk images,
and Linux AppImage/RPM packages. PR Linux builds use DEB-only packaging to supply
Flatpak without paying the AppImage packaging cost on every PR.

The alternative Rust/Leptos surface has separate desktop, Android ARM64 APK, and
iOS ARM64 simulator build/output checks in `tauri-rust-ui-mobile.yml`. These are
additional compatibility checks, not published release artifacts. Web CI builds
the web surface. Neither simulator compilation nor cross-compilation proves
physical-device operation.

## Gates

- `Preview set is complete` requires successful desktop **and Flatpak** jobs on
  PRs, main pushes, and manual runs. It checks both Linux DEBs and Flatpaks on PRs
  and all 12 desktop preview package artifacts on full runs.
- `CLI preview set is complete` requires all seven targets. Deleting the CLI
  crate, skipping a target, or omitting an artifact fails the check.
- Android requires both store flavors; iOS, both browser extensions, and riscv64
  use fail-closed artifact uploads in their own workflows.
- `Assets completeness` executes the actual preview/release checking scripts
  against synthetic complete sets and individual omissions. It also checks
  platform matrix membership and unconditional mobile/extension/riscv64 uploads.
- Release publication waits for all builders and refuses missing required assets
  or unexpected files. A waiver needs an explicit reason in the release inventory.

Run the existing checks without building or publishing a release:

```sh
bash scripts/verify-release-completeness.sh
python scripts/verify-preview-completeness.py
npx vitest run scripts/__tests__/releaseWorkflow.test.mts
```

These checks validate the gates; actual CI runs validate the packages. Repository
rulesets control which check names block merging and are separate from this list.
