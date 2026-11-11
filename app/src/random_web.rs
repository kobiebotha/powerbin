// NSH 0.4 selects getrandom's custom backend for browser builds. Mixed apps
// use the browser's JavaScript engine, so they do not link nsh-js's native
// QuickJS shim. Keep the Web Crypto bridge for the Rust application core.
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn __nsh_random_fill(ptr: *mut u8, len: usize) -> i32;
}

#[unsafe(no_mangle)]
unsafe extern "Rust" fn __getrandom_v03_custom(
    ptr: *mut u8,
    len: usize,
) -> Result<(), getrandom::Error> {
    // SAFETY: getrandom supplies a writable range; the host fills it synchronously.
    if unsafe { __nsh_random_fill(ptr, len) } == 0 {
        Ok(())
    } else {
        Err(getrandom::Error::UNSUPPORTED)
    }
}
