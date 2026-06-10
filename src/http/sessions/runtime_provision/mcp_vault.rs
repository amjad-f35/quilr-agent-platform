use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::credentials,
    errors::GatewayError,
    proxy::state::AppState,
    sdk::agents::{AgentRuntime, ANTHROPIC_VERSION, MANAGED_AGENTS_BETA},
};

use super::CreatedRuntimeSession;

const STORE_PREFIX: &str = "anthropic-managed-agent-mcp-vault:";
const STORE_ACTOR: &str = "runtime_provision";

#[derive(Debug, Clone, PartialEq, Eq)]
struct McpVaultCredential {
    url: String,
    token: String,
}

#[derive(Debug, Default)]
struct StoredVault {
    vault_id: Option<String>,
    credential_urls: BTreeSet<String>,
}

pub(super) async fn vault_ids(
    state: &AppState,
    pool: &PgPool,
    created: &CreatedRuntimeSession,
    mcp_servers: &[Value],
) -> Result<Option<Vec<String>>, GatewayError> {
    if created.resolved.agent_runtime != AgentRuntime::ClaudeManagedAgents {
        return Ok(None);
    }

    let required = gateway_mcp_credentials(state, mcp_servers);
    if required.is_empty() {
        return Ok(None);
    }

    let store_name = store_name(created);
    let mut stored = load_stored_vault(pool, &store_name).await?;
    let mut changed = false;
    let vault_id = match stored.vault_id.clone() {
        Some(vault_id) => vault_id,
        None => {
            let vault_id = create_vault(state, created).await?;
            stored.vault_id = Some(vault_id.clone());
            changed = true;
            vault_id
        }
    };

    for credential in required {
        if stored.credential_urls.contains(&credential.url) {
            continue;
        }
        create_credential(state, created, &vault_id, &credential).await?;
        stored.credential_urls.insert(credential.url);
        changed = true;
    }

    if changed {
        save_stored_vault(pool, &store_name, &stored).await?;
    }

    Ok(Some(vec![vault_id]))
}

fn gateway_mcp_credentials(state: &AppState, mcp_servers: &[Value]) -> Vec<McpVaultCredential> {
    let Some(proxy_base) = state.resolved_mcp_proxy_base_url() else {
        return Vec::new();
    };
    let proxy_prefix = format!("{}/", proxy_base.trim_end_matches('/'));
    let master_key = state.config.general_settings.master_key.as_deref();
    let mut by_url = BTreeMap::new();

    for server in mcp_servers {
        let Some(url) = server
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|url| url.starts_with(&proxy_prefix))
        else {
            continue;
        };
        let token = server
            .get("authorization_token")
            .and_then(Value::as_str)
            .or(master_key);
        if let Some(token) = token {
            by_url
                .entry(url.to_owned())
                .or_insert_with(|| token.to_owned());
        }
    }

    by_url
        .into_iter()
        .map(|(url, token)| McpVaultCredential { url, token })
        .collect()
}

async fn load_stored_vault(pool: &PgPool, store_name: &str) -> Result<StoredVault, GatewayError> {
    let Some(row) = credentials::get_by_name(pool, store_name).await? else {
        return Ok(StoredVault::default());
    };
    Ok(StoredVault {
        vault_id: row
            .credential_values
            .get("vault_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        credential_urls: row
            .credential_values
            .get("credential_urls")
            .and_then(Value::as_array)
            .map(|urls| {
                urls.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

async fn save_stored_vault(
    pool: &PgPool,
    store_name: &str,
    stored: &StoredVault,
) -> Result<(), GatewayError> {
    let credential_urls = stored
        .credential_urls
        .iter()
        .cloned()
        .collect::<Vec<String>>();
    credentials::upsert(
        pool,
        store_name,
        json!({
            "vault_id": stored.vault_id,
            "credential_urls": credential_urls,
        }),
        json!({
            "provider": "anthropic",
            "purpose": "managed_agent_mcp_vault",
        }),
        STORE_ACTOR,
    )
    .await
}

async fn create_vault(
    state: &AppState,
    created: &CreatedRuntimeSession,
) -> Result<String, GatewayError> {
    let response = state
        .http
        .post(format!(
            "{}/vaults?beta=true",
            anthropic_v1_base(&created.resolved.credential.api_base)
        ))
        .header("x-api-key", &created.resolved.credential.api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", MANAGED_AGENTS_BETA)
        .json(&json!({ "display_name": "LiteLLM MCP Gateway" }))
        .send()
        .await
        .map_err(GatewayError::Upstream)?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GatewayError::SandboxError(format!(
            "Anthropic vault create failed with status {status}: {body}"
        )));
    }
    let vault: Value = response.json().await.map_err(GatewayError::Upstream)?;
    vault
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| GatewayError::SandboxError("Anthropic vault response missing id".to_owned()))
}

async fn create_credential(
    state: &AppState,
    created: &CreatedRuntimeSession,
    vault_id: &str,
    credential: &McpVaultCredential,
) -> Result<(), GatewayError> {
    let response = state
        .http
        .post(format!(
            "{}/vaults/{vault_id}/credentials?beta=true",
            anthropic_v1_base(&created.resolved.credential.api_base)
        ))
        .header("x-api-key", &created.resolved.credential.api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", MANAGED_AGENTS_BETA)
        .json(&json!({
            "auth": {
                "type": "static_bearer",
                "mcp_server_url": credential.url,
                "token": credential.token
            }
        }))
        .send()
        .await
        .map_err(GatewayError::Upstream)?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GatewayError::SandboxError(format!(
            "Anthropic vault credential create failed with status {status}: {body}"
        )));
    }
    Ok(())
}

fn store_name(created: &CreatedRuntimeSession) -> String {
    format!(
        "{STORE_PREFIX}{}",
        stable_hash(&format!(
            "{}\0{}",
            anthropic_v1_base(&created.resolved.credential.api_base),
            created.resolved.credential.api_key
        ))
    )
}

fn anthropic_v1_base(api_base: &str) -> String {
    let base = api_base.trim_end_matches('/');
    if base.ends_with("/v1") {
        base.to_owned()
    } else {
        format!("{base}/v1")
    }
}

fn stable_hash(input: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{anthropic_v1_base, gateway_mcp_credentials};
    use crate::{
        agents::config::E2bSandboxParams,
        proxy::{
            config::{GatewayConfig, GeneralSettings},
            state::AppState,
        },
        sdk::{providers::ProviderRegistry, routing::Router as ModelRouter},
    };

    #[test]
    fn collects_gateway_mcp_credentials() {
        let state = state("https://gateway.example.com", Some("sk-master"));
        let credentials = gateway_mcp_credentials(
            &state,
            &[
                json!({
                    "name": "gmail",
                    "url": "https://gateway.example.com/mcp_gmail/mcp",
                    "authorization_token": "sk-scoped"
                }),
                json!({
                    "name": "platform",
                    "url": "https://gateway.example.com/mcp/platform/agent_1?session_id=ses_1"
                }),
                json!({
                    "name": "external",
                    "url": "https://mcp.example.com/mcp",
                    "authorization_token": "external-token"
                }),
            ],
        );

        assert_eq!(credentials.len(), 2);
        assert_eq!(
            credentials[0].url,
            "https://gateway.example.com/mcp/platform/agent_1?session_id=ses_1"
        );
        assert_eq!(credentials[0].token, "sk-master");
        assert_eq!(
            credentials[1].url,
            "https://gateway.example.com/mcp_gmail/mcp"
        );
        assert_eq!(credentials[1].token, "sk-scoped");
    }

    #[test]
    fn normalizes_anthropic_v1_base() {
        assert_eq!(
            anthropic_v1_base("https://api.anthropic.com"),
            "https://api.anthropic.com/v1"
        );
        assert_eq!(
            anthropic_v1_base("https://api.anthropic.com/v1/"),
            "https://api.anthropic.com/v1"
        );
    }

    fn state(proxy_base_url: &str, master_key: Option<&str>) -> AppState {
        let config = GatewayConfig {
            model_list: Vec::new(),
            mcp_servers: Default::default(),
            general_settings: GeneralSettings {
                master_key: master_key.map(str::to_owned),
                public_base_url: Some(proxy_base_url.to_owned()),
                e2b_sandbox_params: E2bSandboxParams {
                    e2b_api_key: None,
                    e2b_template: "litellm-4gb".to_owned(),
                    timeout_seconds: 1800,
                    workspace_dir: "/workspace".to_owned(),
                    e2b_api_base: "https://e2b.example.com".to_owned(),
                    envs: Default::default(),
                },
                ..Default::default()
            },
            slack: Default::default(),
            agents: Vec::new(),
        };
        let empty_config = GatewayConfig {
            model_list: Vec::new(),
            mcp_servers: Default::default(),
            general_settings: GeneralSettings::default(),
            slack: Default::default(),
            agents: Vec::new(),
        };
        AppState::new(
            config,
            ModelRouter::from_config(&empty_config, &ProviderRegistry::new()).unwrap(),
            AppState::build_http_client().unwrap(),
            Default::default(),
            None,
        )
        .unwrap()
    }
}
