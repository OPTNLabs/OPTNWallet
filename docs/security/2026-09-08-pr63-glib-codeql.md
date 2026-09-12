# PR63: GLib CodeQL path review, 2026-09-08

Reviewed the 13 newly visible alerts #113-125 against source at
`6dfcb3a24e7e36df4d142ff0607fb234d3bac755`. GitHub attributes these instances to
merge analysis `c9d5bb8f2bac93faf2b7c31a951753936991e720`. This is a review of
the reported paths, not an audit of all upstream GLib unsafe code.

No alerts were dismissed, no scan configuration changed, and no vendor code
was rewritten to hide a finding. These reports are separate from the 27
hard-coded-value alerts in wallet tests. Empty wallet passwords are supported
by design; their regression cases must remain.

| Alerts           | Source evidence                                                                                                                                                                                                                                                                                                                                                                                                   | Assessment of the reported path                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #113             | `src/auto/functions.rs:856` returns `bool`. Its `from_glib` instantiation uses `FromGlib<gboolean> for bool` in `src/translate.rs:1417`, which compares against `GFALSE`. The reported sink at `src/log.rs:85` belongs to `FromGlib<u32> for LogLevel`.                                                                                                                                                           | The UUID validator does not call that log-level conversion or log the supplied string. The reported cross-type path is not executable Rust.                                                        |
| #114-118         | The linked initializers belong to C string or `GError` output parameters, including charset, URI, key-file, and conversion functions. The reported sinks instead belong to `ObjectRef`, `GValue`, and a `#[cfg(test)]` boxed type. The concrete Rust return types select distinct translation implementations. For example, `file_set_contents` checks its C error output before converting it to `crate::Error`. | The reported paths conflate generic translation implementations. Null initialization before a C output call does not establish a null dereference in these unrelated implementations.              |
| #119             | `src/convert.rs:212-217` passes `&mut filename_charsets` to `g_get_filename_charsets` before translating the borrowed string array. The reported array-length helper also checks a null outer pointer before reading it.                                                                                                                                                                                          | The C function supplies a null-terminated array; its boolean result describes the encoding, not failure to initialize the array. The reported initial-null path omits that output contract.        |
| #120, #122       | `shell_parse_argv` passes `&mut argvp` and an argument-count output to C, then converts successful output into `Vec<OsString>`. The reported sinks are `GSList` and `GList` converters.                                                                                                                                                                                                                           | The actual output is a C string array, not either linked-list type. Those generic converter paths are not selected.                                                                                |
| #121, #123, #124 | The same filename-character-set array from `src/convert.rs:212` is reported as reaching `GSList`, `GList`, and `GPtrArray` converters.                                                                                                                                                                                                                                                                            | The concrete output type is a borrowed C string array. Those three structure layouts are not used by this call.                                                                                    |
| #125             | `PtrSlice::truncate` shortens the logical slice, drops an element in place, then writes a null terminator into the element's still-allocated storage with `ptr::write`. The slice allocation is not freed by dropping that element.                                                                                                                                                                               | Rust explicitly permits overwriting dropped storage with `ptr::write`. The normal drop/write path is valid. A later review found an unwind edge case in this same method; see the follow-up below. |

Paths in the table are relative to `vendor/glib-0.18.5`. The GitHub alert
messages expose multiple source links for #114-118; their linked initializer
contexts were inspected, including the concrete return types. These conclusions
are source-based analysis, not reproduction of every CodeQL graph or proof
that arbitrary callers satisfy every unsafe API precondition.

Primary references checked during this review:

- [GLib UUID validation](https://docs.gtk.org/glib/func.uuid_string_is_valid.html)
  returns a validity boolean.
- [GLib filename charsets](https://docs.gtk.org/glib/func.get_filename_charsets.html)
  supplies a borrowed, null-terminated array through its output parameter.
- [GLib shell argument parsing](https://docs.gtk.org/glib/func.shell_parse_argv.html)
  supplies an argument array on success and documents the initialized error output.
- [Rust `drop_in_place` safety](https://doc.rust-lang.org/std/ptr/fn.drop_in_place.html)
  distinguishes reading a dropped value from overwriting its storage with `write`.
- [CodeQL invalid-pointer query](https://codeql.github.com/codeql-query-help/rust/rust-access-invalid-pointer/)
  describes the unsafe read that its example detects.

These findings remain open for review of the analyzer paths. Do not infer that
the existing GLib advisory has been closed: the backport, provenance, focused
Linux regression, and continuing registry audit are documented separately in
[the vendor note](../../vendor/glib-0.18.5/OPTN.md).

## Truncation unwind follow-up

The review against PR source `3488efc1` and CodeQL merge `fc87aeb1` found a
separate reachable edge case at the #125 location. `TransparentPtrType` permits
an owning Rust wrapper whose destructor panics. The old `truncate` decrements
`len`, drops the element, then writes the null terminator. If destruction
unwinds, the surviving slice violates its documented null-terminated-pointer
contract. A caller inspecting the array through `as_ptr()` can encounter a
stale element pointer beyond the new length. This corrects the earlier broad
source-only assessment; normal `ptr::write` after drop was not itself invalid.

The fix calls the existing `pop()` and then drops its returned value. `pop()`
already restores the terminator before exposing the removed element. No new
unsafe primitive, allocation scheme, representation or GLib version is added.
The regression checks normal truncation and caught destructor panic, exact
remaining length, unchanged allocation, termination and exactly one drop per
item. The existing optimized Linux regression gate now also runs this test.
See [the vendor verification commands](../../vendor/glib-0.18.5/OPTN.md).

Alerts #113-124 were rechecked against the exported SARIF's concrete source
locations and return types. The generic cross-type paths remain unsupported by
the source contracts described above. The unwind fix is not a claim that every
GLib unsafe caller has been audited.

CodeQL analysis of first-party wallet/CLI/Tauri sources ignores `vendor/**`
via `.github/codeql/codeql-config.yml` (GitHub's documented `paths-ignore` for
Rust `build-mode: none`). Vendored GLib remains covered by the rust-quality
regressions above and by the crates.io advisory audit in `OPTN.md`. That
exclusion is not a rewrite of GLib converters and is not a first-party alert
dismissal.

## Urgent #117 follow-up: GValue copy callers

The screenshot at `value.rs:462` is alert #117, still open in Rust analysis
`1740807108` on merge `a7ad16e0`. Its four exported representative paths start
at `console_charset`, `charset`, `file_set_contents` and
`file_set_contents_full`. The first two return string types; the last two
convert a non-null `GError` into `crate::Error` only in their error branch.
Those instantiations of `from_glib_none/full` do not select the `GValue`
conversion. The repeated messages represent source links into one sink, not
independent proof of that many executable memory errors. No dismissal follows
from this source assessment.

Tracing the actual `copy_into_value` callers found a **separate real defect**
in the shared `BoxedInline` full-transfer array conversion: it allocated only
`size_of::<T>()` bytes, then copied every element of an arbitrary slice into
that allocation. It also skipped the destination initializer required by
`GValue`. This is reachable through the library's safe slice conversion API;
no direct OPTN application call to that owned-array conversion was found.

The fix allocates the full count with overflow-checked
[`g_malloc_n`](https://docs.gtk.org/glib/func.malloc_n.html), then invokes the
existing per-type initializer before copying each element, matching the
single-value conversion's initialization order. It applies to both
`Value` and `SendValue` and the container-copy path that delegates to it.
The new regression covers zero, one and four mixed-type values, dropping
the source before the owned roundtrip and cloning a surviving value.
The existing Linux job now runs it under Valgrind with fatal GLib criticals
and failure on invalid accesses, uninitialized reads or definite leaks.
The optimized array regression passed under Valgrind on source `416285e7`
in [run 34226399477](https://github.com/OPTNLabs/OPTNWallet/actions/runs/34226399477):
zero memory errors, zero suppressed errors and zero definitely lost bytes.

This does not make the impossible generic paths executable, resolve #117,
or establish safety for arbitrary unsafe callers. The source review and
the new array defect must not be conflated.

## Related ownership follow-up

The same caller review found `GStringBuilder::copy_into` replacing an already
initialized allocation without freeing it and resetting the copied length to
zero. It now appends the source's explicit byte length into the initialized
destination using GLib's existing API. The regression covers empty and embedded
NUL strings, cloning, full/borrowed imports, source drop and contiguous arrays.

`ThreadPool::push` also freed a callback after worker creation failed, although
[GLib explicitly keeps that task queued](https://docs.gtk.org/glib/method.ThreadPool.push.html).
The callback now remains owned by the queue and its worker frees it. A regression
uses the real queue with workers paused, injects the documented error result,
then resumes a worker and checks execution and exactly one callback drop.
This tests the ownership contract, not actual operating-system thread exhaustion.

Both changes and their tests passed Windows Rust typechecking using local-only
system dependency metadata overrides. That does not link or execute GLib.
Their optimized Linux Valgrind execution passed in
[run 34227538754](https://github.com/OPTNLabs/OPTNWallet/actions/runs/34227538754)
on source `33225589`, with zero errors, zero suppressed errors and zero definitely
lost bytes. Scanner coverage and alert states were not changed.

The generated `BoxedInline` single-value copy, used when a wrapper supplies only
init/copy-into/clear operations, also omitted initialization. It now uses the
same initializer; the existing value regression exercises that public macro arm.
No concrete wrapper in this vendored crate selected it before the regression.

The two Unix spawn wrappers read uninitialized PID/FD outputs on failure and
leaked the parent's child-setup box. They now check the C result and error first,
retain parent ownership of the callback, and reject flags that suppress pipes
required by the Rust return type (including unknown bits at older feature levels).
The Unix regression covers missing executables/directories, FALSE without a
GError, incompatible flags, callback cleanup, and successful pipe/FD roundtrips
with closing and reaping. Its intentional empty-argv cases assert the specific
GLib diagnostic; unexpected criticals remain fatal. CI enables `v2_74` to cover
newer flags and the `v2_58` FD wrapper.
Cross-target Linux `cargo check --lib --tests --features v2_74` passed locally
with dependency metadata overrides; this compiles the Unix tests but does not
link or execute them. No GLib library or linker result is inferred from it.

The final optimized Linux execution passed on source `1a36623e` in
[run 34228111716](https://github.com/OPTNLabs/OPTNWallet/actions/runs/34228111716).
All four Valgrind regressions (value/macro, strings, queued callbacks and Unix
spawn) passed with zero errors, zero suppressed errors and zero definitely lost
bytes, including the forked failure paths. The existing iterator and pointer
slice regressions also passed, as did the run's workspace/core tests, dependency
policy, feature/fuzz compilation and coverage jobs.

The refreshed PR alert inventory still contains 40 open findings. Alert #125's
PR instance is `fixed` with no dismissal; #117 remains open. These focused
regressions verify the repaired ownership paths, not complete GLib safety or
the full wallet/platform architecture.
