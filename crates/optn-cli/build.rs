fn main() {
    // Windows' default 1 MiB main stack is smaller than the native async HTTP
    // and wallet-validation call chain in debug builds. Reserve the same bounded
    // 4 MiB for shipped and test CLI binaries; pages are committed on demand.
    println!("cargo:rerun-if-changed=build.rs");
    let target = std::env::var("TARGET").expect("Cargo supplies TARGET");
    if target.ends_with("windows-msvc") {
        println!("cargo:rustc-link-arg-bin=optn=/STACK:4194304");
    } else if target.ends_with("windows-gnu") {
        println!("cargo:rustc-link-arg-bin=optn=-Wl,--stack,4194304");
    }
}
