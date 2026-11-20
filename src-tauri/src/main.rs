#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod legacy_cli_invocation;

fn main() -> std::process::ExitCode {
    // Reject before native startup, including the single-instance plugin, which
    // would otherwise foreground the app and report success without doing work.
    if std::env::args_os()
        .nth(1)
        .as_deref()
        .is_some_and(legacy_cli_invocation::is_legacy_cli_arg)
    {
        eprintln!(
            "This executable is the Buzz desktop app; no CLI command was executed. \
             Use the bundled buzz CLI instead (on macOS: \
             Buzz.app/Contents/Resources/bin/buzz). Update your script or PATH \
             to point to that executable."
        );
        return std::process::ExitCode::from(1);
    }
    buzz_foundation_lib::run();
    std::process::ExitCode::SUCCESS
}
