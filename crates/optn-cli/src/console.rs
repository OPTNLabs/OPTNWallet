//! An interactive console over the same commands.
//!
//! The command line is fine for one question. It is tiresome for ten: every
//! invocation re-reads the recovery phrase, reconnects to Electrum, and
//! re-parses the same flags. The console keeps those and takes commands as you
//! would type them.
//!
//! Like `serve`, it is a thin layer. A line is split into arguments and handed
//! to the same parser, gated by the same policy, and answered with the same
//! JSON. Nothing here decides what `balance` means.
//!
//! The one thing it adds is the thing a shell would otherwise do badly:
//! quoting. A recovery phrase or a contract argument with a space in it has to
//! survive being typed, so the splitter honours quotes and refuses an
//! unterminated one rather than silently dropping the rest of the line.

use crate::error::{CliError, Result};

/// What a console line asked for.
#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    /// Nothing to do — blank, or a comment.
    Empty,
    /// Leave the console.
    Quit,
    /// Print the available commands.
    Help,
    /// Run a command with these arguments.
    Command(Vec<String>),
}

/// Split a line the way a shell would, honouring quotes.
///
/// Needed because the arguments people type here contain spaces: a contract
/// string parameter, a scan instruction, a label. Splitting on whitespace
/// alone would break those silently — the command would run with the wrong
/// arguments rather than fail.
pub fn split(line: &str) -> Result<Vec<String>> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else if c == '\\' && q == '"' {
                    // Only inside double quotes, as a shell does: inside single
                    // quotes a backslash is literal, which matters for the hex
                    // and paths people paste here.
                    match chars.next() {
                        Some(escaped) => current.push(escaped),
                        None => {
                            return Err(CliError::Usage(
                                "line ends with a trailing backslash".to_string(),
                            ))
                        }
                    }
                } else {
                    current.push(c);
                }
            }
            None => match c {
                '\'' | '"' => {
                    quote = Some(c);
                    // An empty quoted string is still an argument.
                    started = true;
                }
                c if c.is_whitespace() => {
                    if started {
                        args.push(std::mem::take(&mut current));
                        started = false;
                    }
                }
                _ => {
                    current.push(c);
                    started = true;
                }
            },
        }
    }

    if let Some(q) = quote {
        // Refused rather than closed for them: silently completing the quote
        // would run a command with an argument nobody typed.
        return Err(CliError::Usage(format!(
            "unterminated {} quote",
            if q == '"' { "double" } else { "single" }
        )));
    }
    if started {
        args.push(current);
    }
    Ok(args)
}

/// Interpret one line of input.
pub fn parse(line: &str) -> Result<Line> {
    let trimmed = line.trim();
    // A comment is useful when a session is pasted from notes.
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return Ok(Line::Empty);
    }

    let args = split(trimmed)?;
    if args.is_empty() {
        return Ok(Line::Empty);
    }

    match args[0].as_str() {
        "quit" | "exit" | ":q" => Ok(Line::Quit),
        "help" | "?" => Ok(Line::Help),
        _ => Ok(Line::Command(args)),
    }
}

/// The argv a console line becomes.
///
/// The global flags the console started with are applied to every line, so
/// `--network chipnet` is stated once rather than on each command.
pub fn argv(base: &[String], args: &[String], json: bool) -> Vec<String> {
    let mut out = vec!["optn".to_string()];
    if json {
        out.push("--json".to_string());
    }
    out.extend(base.iter().cloned());
    out.extend(args.iter().cloned());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(line: &str) -> Vec<String> {
        split(line).unwrap()
    }

    #[test]
    fn splits_on_whitespace() {
        assert_eq!(words("balance bchtest:qq"), ["balance", "bchtest:qq"]);
        assert_eq!(words("   ping   "), ["ping"]);
        assert!(words("").is_empty());
    }

    #[test]
    fn keeps_quoted_arguments_whole() {
        // A contract string parameter or a label has spaces in it. Splitting
        // those would run the command with different arguments rather than
        // fail, which is the worst way to be wrong.
        assert_eq!(
            words(r#"contract address P2PKH --arg "two words""#),
            ["contract", "address", "P2PKH", "--arg", "two words"]
        );
        assert_eq!(words("send 'a b' 1"), ["send", "a b", "1"]);
    }

    #[test]
    fn a_backslash_is_literal_inside_single_quotes() {
        // People paste Windows paths and hex here. A shell treats a backslash
        // literally inside single quotes and so does this.
        assert_eq!(words(r"decode 'C:\path\to'"), ["decode", r"C:\path\to"]);
        assert_eq!(words(r#"decode "a\"b""#), ["decode", "a\"b"]);
    }

    #[test]
    fn an_unterminated_quote_is_refused() {
        // Closing it for them would run a command with an argument nobody
        // typed.
        assert!(split(r#"send "unfinished"#).is_err());
        assert!(split("send 'unfinished").is_err());
        assert!(split(r#"send "a\"#).is_err());
    }

    #[test]
    fn an_empty_quoted_string_is_still_an_argument() {
        assert_eq!(words(r#"tx "" --verbose"#), ["tx", "", "--verbose"]);
    }

    #[test]
    fn blank_lines_and_comments_do_nothing() {
        assert_eq!(parse("").unwrap(), Line::Empty);
        assert_eq!(parse("   ").unwrap(), Line::Empty);
        assert_eq!(parse("# a note").unwrap(), Line::Empty);
    }

    #[test]
    fn quit_and_help_are_recognised() {
        for word in ["quit", "exit", ":q"] {
            assert_eq!(parse(word).unwrap(), Line::Quit, "{word}");
        }
        for word in ["help", "?"] {
            assert_eq!(parse(word).unwrap(), Line::Help, "{word}");
        }
    }

    #[test]
    fn anything_else_is_a_command() {
        assert_eq!(
            parse("balance bchtest:qq").unwrap(),
            Line::Command(vec!["balance".into(), "bchtest:qq".into()])
        );
    }

    #[test]
    fn the_consoles_global_flags_apply_to_every_line() {
        // Stated once when the console starts rather than on each command.
        let base = vec!["--network".to_string(), "chipnet".to_string()];
        assert_eq!(
            argv(&base, &["balance".to_string(), "x".to_string()], true),
            ["optn", "--json", "--network", "chipnet", "balance", "x"]
        );
        assert_eq!(
            argv(&base, &["ping".to_string()], false),
            ["optn", "--network", "chipnet", "ping"]
        );
    }
}
