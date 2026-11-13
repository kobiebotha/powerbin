use reqwest::{Method, Url};
use serde_json::Value;

/// Reject insecure destinations before attaching credentials or opening a socket.
pub fn endpoint(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Enter a valid server URL")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.host_str().is_none()
        || !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
    {
        return Err(
            "Server URLs must use HTTPS. HTTP is allowed only for localhost development.".into(),
        );
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("Server URLs cannot contain credentials or fragments.".into());
    }
    Ok(url)
}

pub fn origin(value: &str) -> Result<Url, String> {
    let url = endpoint(value)?;
    if url.path() != "/" || url.query().is_some() {
        return Err("Enter the PowerBin server origin without a path or query.".into());
    }
    Ok(url)
}

pub fn sync_endpoint(server_origin: &str, value: &str) -> Result<Url, String> {
    let api = origin(server_origin)?;
    let sync = endpoint(value)?;
    if api.scheme() == "https" && sync.scheme() != "https" {
        return Err("An HTTPS PowerBin server requires an HTTPS sync endpoint.".into());
    }
    Ok(sync)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn client() -> Result<reqwest::Client, String> {
    // Refuse every redirect, including same-host downgrades and credentialed POST replay.
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(module = "/web/dist/adapter.js")]
extern "C" {
    #[wasm_bindgen::prelude::wasm_bindgen(catch, js_name = request)]
    async fn browser_request(
        origin: &str,
        token: &str,
        path: &str,
        method: &str,
        body: Option<String>,
    ) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue>;
}

pub async fn request(
    server_origin: &str,
    token: &str,
    path: &str,
    method: Method,
    body: Option<Value>,
) -> Result<Value, String> {
    let base = origin(server_origin)?;
    let url = base.join(path).map_err(|error| error.to_string())?;
    if url.origin() != base.origin() {
        return Err("API requests must stay on the configured server origin.".into());
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let mut request = client()?
            .request(method, url)
            .timeout(std::time::Duration::from_secs(15));
        if let Some(body) = body {
            request = request.json(&body);
        }
        if !token.is_empty() {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        let status = response.status();
        if status.is_redirection() {
            return Err("The server redirected the request. Use its final HTTPS origin.".into());
        }
        let value: Value = response.json().await.map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(value["error"].as_str().unwrap_or("Request failed").into());
        }
        Ok(value)
    }
    #[cfg(target_arch = "wasm32")]
    {
        // reqwest's browser backend cannot disable fetch redirects. Use the same
        // redirect-refusing fetch helper as the browser sync connector.
        let response = browser_request(
            base.as_str(),
            token,
            path,
            method.as_str(),
            body.map(|body| body.to_string()),
        )
        .await
        .map_err(crate::db_web::error)?;
        let text = response.as_string().ok_or("Invalid server response")?;
        serde_json::from_str(&text).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_urls_require_https_and_local_development_is_preserved() {
        for url in [
            "https://powerbin.test",
            "https://sync.test/powersync",
            "http://localhost:8080",
            "http://127.0.0.1:8080",
            "http://[::1]:8080",
        ] {
            assert!(endpoint(url).is_ok(), "{url}");
        }
        for url in [
            "http://powerbin.test",
            "http://192.0.2.1",
            "http://127.0.0.2",
            "http://localhost.attacker.test",
            "ftp://localhost",
            "https://user:secret@powerbin.test",
            "https://powerbin.test/#secret",
        ] {
            assert!(endpoint(url).is_err(), "{url}");
        }
        assert!(origin("https://powerbin.test/").is_ok());
        assert!(origin("https://powerbin.test/api").is_err());
        assert!(origin("https://powerbin.test/?server=other").is_err());
        assert!(sync_endpoint("https://powerbin.test", "http://127.0.0.1:8080").is_err());
        assert!(sync_endpoint("https://powerbin.test", "ws://sync.test").is_err());
        assert!(sync_endpoint("http://localhost:8080", "http://127.0.0.1:8081").is_ok());
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn unsafe_requests_never_reach_a_listener_and_redirects_are_not_replayed() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("0.0.0.0:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        for (method, body) in [
            (Method::GET, None),
            (
                Method::POST,
                Some(serde_json::json!({ "device_token": "dummy-device-token" })),
            ),
        ] {
            let result = runtime.block_on(request(
                &format!("http://127.0.0.2:{port}"),
                "dummy-setup-token",
                "/api/bootstrap",
                method,
                body,
            ));
            assert!(result.unwrap_err().contains("HTTPS"));
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        }

        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let source_port = source.local_addr().unwrap().port();
        let responder = std::thread::spawn(move || {
            let (mut stream, _) = source.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut buffer = [0; 4096];
            let length = stream.read(&mut buffer).unwrap();
            let received = String::from_utf8_lossy(&buffer[..length]);
            assert!(
                received
                    .to_lowercase()
                    .contains("authorization: bearer dummy-setup-token")
            );
            write!(stream, "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{port}/capture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let result = runtime.block_on(request(
            &format!("http://127.0.0.1:{source_port}"),
            "dummy-setup-token",
            "/api/bootstrap",
            Method::POST,
            Some(serde_json::json!({ "device_token": "dummy-device-token" })),
        ));
        assert!(result.unwrap_err().contains("redirected"));
        responder.join().unwrap();
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
