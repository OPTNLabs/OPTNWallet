use std::path::PathBuf;

fn main() {
    build_fusion_proto();
    tauri_build::build()
}

// Compile the vendored CashFusion protobuf schema (proto/fusion.proto, taken
// verbatim from Electron Cash — the reference implementation) into Rust types.
//
// protox parses the .proto in pure Rust and hands prost a pre-built descriptor
// set, so no `protoc` binary is needed. prost-build's normal path shells out to
// protoc, which isn't installed here or on CI.
fn build_fusion_proto() {
    let proto = PathBuf::from("proto/fusion.proto");
    println!("cargo:rerun-if-changed={}", proto.display());

    let descriptors =
        protox::compile([&proto], ["proto"]).expect("failed to parse proto/fusion.proto");

    prost_build::Config::new()
        .compile_fds(descriptors)
        .expect("failed to generate Rust types from fusion.proto");
}
