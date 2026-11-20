fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    cc::Build::new()
        .file("src/probe.m")
        .flag("-fobjc-arc")
        .flag("-fblocks")
        .compile("webkit_reaper_probe");
    println!("cargo:rustc-link-lib=framework=WebKit");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=sqlite3");
    println!("cargo:rerun-if-changed=src/probe.m");
}
