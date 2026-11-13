fn main() {
    println!("cargo:rerun-if-changed=../.env");
    if let Ok(values) = dotenvy::from_path_iter("../.env") {
        for (key, value) in values.flatten() {
            if key == "API_ORIGIN" || key == "WEB_ORIGIN" {
                println!("cargo:rustc-env=POWERBIN_{key}={value}");
            }
        }
    }
}
