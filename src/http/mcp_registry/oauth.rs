use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::Redirect,
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::{
    db::{
        credentials,
        mcp_servers::{repository, schema::McpServerRow},
    },
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, credential_crypto, state::AppState},
};

type HmacSha256 = Hmac<Sha256>;

const STATE_TTL_MS: i64 = 10 * 60 * 1000;
const REFRESH_SKEW_MS: i64 = 60 * 1000;

#[derive(Debug, Deserialize)]
pub struct StartOAuthRequest {
    pub redirect_after: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StartOAuthResponse {
    pub authorization_url: String,
    pub redirect_uri: String,
}

#[derive(Debug, Deserialize)]
pub struct OAuthCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct SignedOAuthState {
    server_id: String,
    user_id: String,
    redirect_after: Option<String>,
    redirect_uri: String,
    nonce: String,
    iat_ms: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct StoredOAuthCredential {
    access_token: String,
    refresh_token: Option<String>,
    expires_at_ms: Option<i64>,
    token_type: Option<String>,
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    token_type: Option<String>,
    scope: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

pub async fn start_oauth(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
    Json(input): Json<StartOAuthRequest>,
) -> Result<Json<StartOAuthResponse>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;

    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let server = repository::get(pool, &server_id)
        .await?
        .ok_or_else(|| GatewayError::NotFound(format!("MCP server not found: {server_id}")))?;

    let enc_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    let client_id = oauth_client_value(&server, &enc_key, &["oauth_client_id", "client_id"])
        .ok_or_else(|| {
            GatewayError::InvalidConfig("MCP OAuth client_id is not configured".to_owned())
        })?;
    let authorization_url = required_server_url(
        server.authorization_url.as_deref(),
        "MCP OAuth authorization_url is not configured",
    )?;
    let scopes = oauth_scopes(&server)?;
    let resource = oauth_resource(&server);
    let redirect_uri = format!("{}/v1/mcp/oauth/callback", origin(&headers));
    let user_id = super::caller_user_id(&headers, &state);
    let signed_state = SignedOAuthState {
        server_id,
        user_id,
        redirect_after: input.redirect_after,
        redirect_uri: redirect_uri.clone(),
        nonce: uuid::Uuid::new_v4().simple().to_string(),
        iat_ms: now_ms(),
    };
    let state_value = encode_state(&signed_state, &enc_key)?;

    let mut url = Url::parse(authorization_url).map_err(|error| {
        GatewayError::InvalidConfig(format!("invalid MCP OAuth authorization_url: {error}"))
    })?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", &scopes.join(" "))
        .append_pair("state", &state_value);
    if let Some(resource) = resource.as_deref() {
        url.query_pairs_mut().append_pair("resource", resource);
    }
    url.query_pairs_mut()
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("include_granted_scopes", "true");

    Ok(Json(StartOAuthResponse {
        authorization_url: url.to_string(),
        redirect_uri,
    }))
}

pub async fn oauth_callback(
    State(state): State<Arc<AppState>>,
    Query(query): Query<OAuthCallbackQuery>,
) -> Result<Redirect, GatewayError> {
    let pool = state.db.as_ref().ok_or(GatewayError::MissingDatabase)?;
    let enc_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    let state_value = required(query.state.as_deref(), "missing OAuth state")?;
    let signed_state = decode_state(state_value, &enc_key)?;
    let redirect_after = safe_redirect_after(signed_state.redirect_after.as_deref());

    if let Some(error) = query.error {
        let message = query.error_description.unwrap_or(error);
        return Ok(Redirect::to(&redirect_target(
            &redirect_after,
            "failed",
            &signed_state.server_id,
            Some(&message),
        )));
    }

    let server = repository::get(pool, &signed_state.server_id)
        .await?
        .ok_or_else(|| {
            GatewayError::NotFound(format!("MCP server not found: {}", signed_state.server_id))
        })?;
    let code = required(query.code.as_deref(), "missing OAuth code")?;
    let token_url = required_server_url(
        server.token_url.as_deref(),
        "MCP OAuth token_url is not configured",
    )?;
    let resource = oauth_resource(&server);
    let client_id = oauth_client_value(&server, &enc_key, &["oauth_client_id", "client_id"])
        .ok_or_else(|| {
            GatewayError::InvalidConfig("MCP OAuth client_id is not configured".to_owned())
        })?;
    let client_secret =
        oauth_client_value(&server, &enc_key, &["oauth_client_secret", "client_secret"])
            .ok_or_else(|| {
                GatewayError::InvalidConfig("MCP OAuth client_secret is not configured".to_owned())
            })?;

    let token = exchange_code(
        &state,
        token_url,
        &client_id,
        &client_secret,
        code,
        &signed_state.redirect_uri,
        resource.as_deref(),
    )
    .await?;
    let credential = credential_from_token(token, None)?;
    store_oauth_credential(
        pool,
        &state,
        &signed_state.server_id,
        &signed_state.user_id,
        &credential,
    )
    .await?;

    Ok(Redirect::to(&redirect_target(
        &redirect_after,
        "connected",
        &signed_state.server_id,
        None,
    )))
}

pub(super) async fn resolve_oauth_bearer_token(
    state: &AppState,
    pool: &sqlx::PgPool,
    server: &McpServerRow,
    user_id: &str,
    enc_key: &str,
) -> Result<Option<String>, GatewayError> {
    let Some(raw) = read_user_credential(pool, &server.server_id, user_id, enc_key).await? else {
        return Ok(None);
    };

    let Ok(mut credential) = serde_json::from_str::<StoredOAuthCredential>(&raw) else {
        return Ok(Some(raw));
    };

    if token_is_fresh(credential.expires_at_ms) {
        return Ok(Some(credential.access_token));
    }

    let Some(refresh_token) = credential.refresh_token.clone() else {
        return Ok(Some(credential.access_token));
    };
    let token_url = match server.token_url.as_deref() {
        Some(value) if !value.trim().is_empty() => value.trim(),
        _ => return Ok(Some(credential.access_token)),
    };
    let Some(client_id) = oauth_client_value(server, enc_key, &["oauth_client_id", "client_id"])
    else {
        return Ok(Some(credential.access_token));
    };
    let Some(client_secret) =
        oauth_client_value(server, enc_key, &["oauth_client_secret", "client_secret"])
    else {
        return Ok(Some(credential.access_token));
    };

    let resource = oauth_resource(server);
    let token = refresh_access_token(
        state,
        token_url,
        &client_id,
        &client_secret,
        &refresh_token,
        resource.as_deref(),
    )
    .await?;
    credential = credential_from_token(token, credential.refresh_token.as_deref())?;
    store_oauth_credential(pool, state, &server.server_id, user_id, &credential).await?;
    Ok(Some(credential.access_token))
}

async fn exchange_code(
    state: &AppState,
    token_url: &str,
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
    resource: Option<&str>,
) -> Result<OAuthTokenResponse, GatewayError> {
    let mut form = vec![
        ("grant_type", "authorization_code".to_owned()),
        ("code", code.to_owned()),
        ("redirect_uri", redirect_uri.to_owned()),
        ("client_id", client_id.to_owned()),
        ("client_secret", client_secret.to_owned()),
    ];
    if let Some(resource) = resource {
        form.push(("resource", resource.to_owned()));
    }
    token_request(state, token_url, form).await
}

async fn refresh_access_token(
    state: &AppState,
    token_url: &str,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
    resource: Option<&str>,
) -> Result<OAuthTokenResponse, GatewayError> {
    let mut form = vec![
        ("grant_type", "refresh_token".to_owned()),
        ("refresh_token", refresh_token.to_owned()),
        ("client_id", client_id.to_owned()),
        ("client_secret", client_secret.to_owned()),
    ];
    if let Some(resource) = resource {
        form.push(("resource", resource.to_owned()));
    }
    token_request(state, token_url, form).await
}

async fn token_request(
    state: &AppState,
    token_url: &str,
    form: Vec<(&str, String)>,
) -> Result<OAuthTokenResponse, GatewayError> {
    let res = state
        .http
        .post(token_url)
        .form(&form)
        .send()
        .await
        .map_err(GatewayError::Upstream)?;
    let status = res.status().as_u16();
    let text = res.text().await.map_err(GatewayError::Upstream)?;
    if status >= 400 {
        return Err(GatewayError::UpstreamHttp(status, text));
    }
    let token =
        serde_json::from_str::<OAuthTokenResponse>(&text).map_err(GatewayError::InvalidJson)?;
    if let Some(error) = token.error.as_deref() {
        let detail = token.error_description.as_deref().unwrap_or(error);
        return Err(GatewayError::UpstreamHttp(status, detail.to_owned()));
    }
    Ok(token)
}

fn credential_from_token(
    token: OAuthTokenResponse,
    existing_refresh_token: Option<&str>,
) -> Result<StoredOAuthCredential, GatewayError> {
    let access_token = token
        .access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            GatewayError::InvalidConfig("OAuth token response omitted access_token".to_owned())
        })?;
    Ok(StoredOAuthCredential {
        access_token,
        refresh_token: token
            .refresh_token
            .filter(|value| !value.trim().is_empty())
            .or_else(|| existing_refresh_token.map(str::to_owned)),
        expires_at_ms: token.expires_in.map(|seconds| now_ms() + seconds * 1000),
        token_type: token.token_type,
        scope: token.scope,
    })
}

async fn read_user_credential(
    pool: &sqlx::PgPool,
    server_id: &str,
    user_id: &str,
    enc_key: &str,
) -> Result<Option<String>, GatewayError> {
    let key_name = format!("mcp_user:{server_id}:{user_id}");
    let Some(row) = credentials::get_personal_by_name(pool, &key_name, user_id).await? else {
        return Ok(None);
    };
    let Some(encrypted) = row
        .credential_values
        .get("value")
        .and_then(|value| value.as_str())
    else {
        return Ok(None);
    };
    Ok(Some(credential_crypto::decrypt_value(encrypted, enc_key)?))
}

async fn store_oauth_credential(
    pool: &sqlx::PgPool,
    state: &AppState,
    server_id: &str,
    user_id: &str,
    credential: &StoredOAuthCredential,
) -> Result<(), GatewayError> {
    let enc_key =
        credential_crypto::encryption_key(state.config.general_settings.master_key.as_deref())?;
    let raw = serde_json::to_string(credential).map_err(GatewayError::InvalidJson)?;
    let encrypted = credential_crypto::encrypt_value(&raw, &enc_key)?;
    let key_name = format!("mcp_user:{server_id}:{user_id}");
    credentials::upsert_vault_key(
        pool,
        &key_name,
        "personal",
        Some(user_id),
        &encrypted,
        user_id,
    )
    .await
}

fn oauth_scopes(server: &McpServerRow) -> Result<Vec<String>, GatewayError> {
    let scopes = server
        .mcp_info
        .pointer("/oauth/scopes")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if scopes.is_empty() {
        return Err(GatewayError::InvalidConfig(
            "MCP OAuth scopes are not configured in mcp_info.oauth.scopes".to_owned(),
        ));
    }
    Ok(scopes)
}

fn oauth_resource(server: &McpServerRow) -> Option<String> {
    server
        .mcp_info
        .pointer("/oauth/resource")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn oauth_client_value(server: &McpServerRow, enc_key: &str, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        server
            .credentials
            .get(*name)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|raw| {
                credential_crypto::decrypt_value(raw, enc_key).unwrap_or_else(|_| raw.to_owned())
            })
    })
}

fn required_server_url<'a>(value: Option<&'a str>, message: &str) -> Result<&'a str, GatewayError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| GatewayError::InvalidConfig(message.to_owned()))
}

fn required<'a>(value: Option<&'a str>, message: &str) -> Result<&'a str, GatewayError> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| GatewayError::InvalidJsonMessage(message.to_owned()))
}

fn encode_state(state: &SignedOAuthState, secret: &str) -> Result<String, GatewayError> {
    let payload = serde_json::to_vec(state).map_err(GatewayError::InvalidJson)?;
    let payload = URL_SAFE_NO_PAD.encode(payload);
    let signature = sign_state(&payload, secret)?;
    Ok(format!("{payload}.{signature}"))
}

fn decode_state(value: &str, secret: &str) -> Result<SignedOAuthState, GatewayError> {
    let (payload, signature) = value.split_once('.').ok_or(GatewayError::Unauthorized)?;
    verify_state(payload, signature, secret)?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| GatewayError::Unauthorized)?;
    let state = serde_json::from_slice::<SignedOAuthState>(&payload)
        .map_err(|_| GatewayError::Unauthorized)?;
    if now_ms().saturating_sub(state.iat_ms) > STATE_TTL_MS {
        return Err(GatewayError::Unauthorized);
    }
    Ok(state)
}

fn sign_state(payload: &str, secret: &str) -> Result<String, GatewayError> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| {
        GatewayError::InvalidConfig("OAuth state signing key is invalid".to_owned())
    })?;
    mac.update(payload.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn verify_state(payload: &str, signature: &str, secret: &str) -> Result<(), GatewayError> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| {
        GatewayError::InvalidConfig("OAuth state signing key is invalid".to_owned())
    })?;
    mac.update(payload.as_bytes());
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| GatewayError::Unauthorized)?;
    mac.verify_slice(&signature)
        .map_err(|_| GatewayError::Unauthorized)
}

fn token_is_fresh(expires_at_ms: Option<i64>) -> bool {
    expires_at_ms.is_none_or(|expires_at| expires_at > now_ms() + REFRESH_SKEW_MS)
}

fn redirect_target(
    redirect_after: &str,
    status: &str,
    server_id: &str,
    error: Option<&str>,
) -> String {
    let mut params = vec![
        ("mcp_oauth", status.to_owned()),
        ("server_id", server_id.to_owned()),
    ];
    if let Some(error) = error {
        params.push(("error", error.to_owned()));
    }
    let query = params
        .into_iter()
        .map(|(key, value)| format!("{key}={}", query_escape(&value)))
        .collect::<Vec<_>>()
        .join("&");
    let separator = if redirect_after.contains('?') {
        "&"
    } else {
        "?"
    };
    format!("{redirect_after}{separator}{query}")
}

fn safe_redirect_after(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| {
            value.starts_with('/')
                && !value.starts_with("//")
                && !value.contains('\n')
                && !value.contains('\r')
        })
        .unwrap_or("/integrations")
        .to_owned()
}

fn query_escape(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn origin(headers: &HeaderMap) -> String {
    let proto = forwarded_header(headers, "x-forwarded-proto")
        .or_else(|| forwarded_header(headers, "x-forwarded-protocol"))
        .unwrap_or("http");
    let host = forwarded_header(headers, "x-forwarded-host")
        .or_else(|| forwarded_header(headers, "host"))
        .unwrap_or("localhost");
    format!("{proto}://{host}")
}

fn forwarded_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
