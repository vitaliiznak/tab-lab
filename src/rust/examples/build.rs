use std::{env, path::PathBuf, process::Command};

fn checked(command: &mut Command) {
    let status = command.status().expect("could not start the build tool");
    assert!(status.success(), "{command:?} failed with {status}");
}

fn main() {
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let generated = out.join("kernels.c");
    checked(
        Command::new("python3")
            .args(["/opt/cudawg/cudawgc.py", "kernels.cu", "-o"])
            .arg(&generated),
    );
    for (source, obj) in [
        (generated, "kernels.o"),
        ("/opt/cudawg/runtime/cudawg.c".into(), "cudawg.o"),
    ] {
        checked(
            Command::new("gcc")
                .args(["-std=gnu11", "-O1", "-I/opt/cudawg/runtime", "-c"])
                .arg(source)
                .arg("-o")
                .arg(out.join(obj)),
        );
    }
    checked(Command::new("ar").current_dir(&out).args([
        "rcs",
        "liblabcuda.a",
        "kernels.o",
        "cudawg.o",
    ]));
    println!("cargo:rerun-if-changed=kernels.cu");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=labcuda");
    println!("cargo:rustc-link-lib=m");
}
