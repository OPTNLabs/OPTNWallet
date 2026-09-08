# PR63: GLib CodeQL path review, 2026-09-08

Reviewed the 13 newly visible alerts #113-125 against source at
`6dfcb3a24e7e36df4d142ff0607fb234d3bac755`. GitHub attributes these instances to
merge analysis `c9d5bb8f2bac93faf2b7c31a951753936991e720`. This is a review of
the reported paths, not an audit of all upstream GLib unsafe code.

No alerts were dismissed, no scan configuration changed, and no vendor code
was rewritten to hide a finding. These reports are separate from the 27
hard-coded-value alerts in wallet tests. Empty wallet passwords are supported
by design; their regression cases must remain.

| Alerts           | Source evidence                                                                                                                                                                                                                                                                                                                                                                                                   | Assessment of the reported path                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #113             | `src/auto/functions.rs:856` returns `bool`. Its `from_glib` instantiation uses `FromGlib<gboolean> for bool` in `src/translate.rs:1417`, which compares against `GFALSE`. The reported sink at `src/log.rs:85` belongs to `FromGlib<u32> for LogLevel`.                                                                                                                                                           | The UUID validator does not call that log-level conversion or log the supplied string. The reported cross-type path is not executable Rust.                                                 |
| #114-118         | The linked initializers belong to C string or `GError` output parameters, including charset, URI, key-file, and conversion functions. The reported sinks instead belong to `ObjectRef`, `GValue`, and a `#[cfg(test)]` boxed type. The concrete Rust return types select distinct translation implementations. For example, `file_set_contents` checks its C error output before converting it to `crate::Error`. | The reported paths conflate generic translation implementations. Null initialization before a C output call does not establish a null dereference in these unrelated implementations.       |
| #119             | `src/convert.rs:212-217` passes `&mut filename_charsets` to `g_get_filename_charsets` before translating the borrowed string array. The reported array-length helper also checks a null outer pointer before reading it.                                                                                                                                                                                          | The C function supplies a null-terminated array; its boolean result describes the encoding, not failure to initialize the array. The reported initial-null path omits that output contract. |
| #120, #122       | `shell_parse_argv` passes `&mut argvp` and an argument-count output to C, then converts successful output into `Vec<OsString>`. The reported sinks are `GSList` and `GList` converters.                                                                                                                                                                                                                           | The actual output is a C string array, not either linked-list type. Those generic converter paths are not selected.                                                                         |
| #121, #123, #124 | The same filename-character-set array from `src/convert.rs:212` is reported as reaching `GSList`, `GList`, and `GPtrArray` converters.                                                                                                                                                                                                                                                                            | The concrete output type is a borrowed C string array. Those three structure layouts are not used by this call.                                                                             |
| #125             | `PtrSlice::truncate` shortens the logical slice, drops an element in place, then writes a null terminator into the element's still-allocated storage with `ptr::write`. The slice allocation is not freed by dropping that element.                                                                                                                                                                               | Rust explicitly permits overwriting dropped storage with `ptr::write`. The report does not show a read of the dropped value or a freed slice allocation.                                    |

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
