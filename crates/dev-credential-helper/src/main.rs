//! A stable program that does Keychain reads and writes for `just desktop me`
//! debug builds. Keychain approvals belong to the program that asks, and a debug
//! build is a different program after every rebuild; this helper is installed
//! once outside the repository, so an approval given to it lasts.
//! See docs/identity.md, "Local credential helper on macOS".
mod policy;

#[cfg(target_os = "macos")]
mod macos;

use policy::{Command, PROTOCOL};

fn main() {
    let Some(args) = std::env::args_os()
        .skip(1)
        .map(|arg| arg.into_string().ok())
        .collect::<Option<Vec<_>>>()
    else {
        std::process::exit(policy::UNAVAILABLE);
    };
    let code = match policy::parse(&args) {
        Ok(Command::Version) => {
            println!("buzz-dev-credential-helper protocol {PROTOCOL}");
            0
        }
        Ok(Command::Item(request)) => run(request),
        Err(code) => code,
    };
    std::process::exit(code);
}

#[cfg(target_os = "macos")]
fn run(request: policy::Request) -> i32 {
    macos::run(&request)
}

#[cfg(not(target_os = "macos"))]
fn run(_: policy::Request) -> i32 {
    policy::UNAVAILABLE
}
