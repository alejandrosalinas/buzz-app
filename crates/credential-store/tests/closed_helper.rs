#![cfg(all(target_os = "macos", debug_assertions))]

use buzz_credential_store::dev_item;
use std::{fs, process::Command};

#[test]
fn reads_a_reply_after_the_helper_closes_its_socket() {
    let directory = tempfile::tempdir().unwrap();
    let closing_helper = directory.path().join("closing-helper");
    let source = directory.path().join("closing-helper.c");
    fs::write(
        &source,
        r#"
#include <signal.h>
#include <sys/types.h>
#include <unistd.h>
int main(void) {
    int done[2];
    pid_t caller = getppid();
    if (pipe(done) || kill(caller, SIGSTOP)) return 1;
    pid_t resumer = fork();
    if (resumer < 0) { kill(caller, SIGCONT); return 1; }
    if (resumer == 0) {
        close(STDOUT_FILENO);
        close(done[1]);
        char value;
        read(done[0], &value, 1);
        kill(caller, SIGCONT);
        _exit(0);
    }
    close(done[0]);
    write(STDOUT_FILENO, "{}", 2);
    close(STDOUT_FILENO);
    close(done[1]);
    return 0;
}
"#,
    )
    .unwrap();
    assert!(Command::new("/usr/bin/clang")
        .args(["-Wall", "-Wextra", "-Werror"])
        .arg(&source)
        .arg("-o")
        .arg(&closing_helper)
        .status()
        .unwrap()
        .success());
    std::env::set_var("BUZZ_DEV_CREDENTIAL_HELPER", &closing_helper);
    let reply = dev_item(
        "read",
        "xyz.block.buzz.desktop.agents",
        "agent-bundle-v1",
        &[],
    )
    .unwrap()
    .map(|value| value.to_vec());
    assert_eq!(reply, Ok(b"{}".to_vec()));
    std::env::remove_var("BUZZ_DEV_CREDENTIAL_HELPER");
}
