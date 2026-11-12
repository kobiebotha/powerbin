use jni::{
    JNIEnv,
    objects::{JObject, JString},
};
use std::{path::PathBuf, sync::OnceLock};

pub static FILES_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn files_dir() -> Result<PathBuf, String> {
    FILES_DIR
        .get()
        .cloned()
        .ok_or("Android files directory is unavailable".into())
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_powersync_powerbin_MainActivity_initializeKeyring(
    mut env: JNIEnv<'_>,
    activity: JObject<'_>,
    context: JObject<'_>,
    directory: JString<'_>,
) {
    let Ok(directory) = env.get_string(&directory).map(String::from) else {
        return;
    };
    let _ = FILES_DIR.set(PathBuf::from(directory));
    // Both JNI wrappers borrow the current native frame; the verifier retains global refs.
    unsafe { jni_verifier::EnvUnowned::from_raw(env.get_raw().cast()) }
        .with_env(|verifier_env| {
            let context = unsafe {
                jni_verifier::objects::JObject::from_raw(verifier_env, context.as_raw().cast())
            };
            rustls_platform_verifier::android::init_with_env(verifier_env, context)
        })
        .resolve::<jni_verifier::errors::ThrowRuntimeExAndDefault>();
    if env.exception_check().unwrap_or(true) {
        return;
    }
    android_native_keyring_store::Java_io_crates_keyring_Keyring_00024Companion_initializeNdkContext(
        env, activity, context,
    );
}
