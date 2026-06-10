use std::{env, path::PathBuf};

use axum::{
    body::Body,
    http::{header, HeaderValue, Response, StatusCode},
    response::Redirect,
};
use tower_http::services::{ServeDir, ServeFile};

pub fn static_files() -> ServeDir<ServeFile> {
    let dir = ui_dir();
    ServeDir::new(&dir)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(dir.join("index.html")))
}

pub async fn redirect_to_sessions() -> Redirect {
    Redirect::temporary("/sessions/")
}

pub async fn inbox_html() -> Result<Response<Body>, StatusCode> {
    no_store_file("inbox/index.html", "text/html; charset=utf-8").await
}

pub async fn inbox_index_txt() -> Result<Response<Body>, StatusCode> {
    no_store_file("inbox/index.txt", "text/plain; charset=utf-8").await
}

fn ui_dir() -> PathBuf {
    env::var_os("LITELLM_UI_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("src/ui/out"))
}

async fn no_store_file(
    relative_path: &str,
    content_type: &'static str,
) -> Result<Response<Body>, StatusCode> {
    let bytes = tokio::fs::read(ui_dir().join(relative_path))
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    Ok(response)
}
