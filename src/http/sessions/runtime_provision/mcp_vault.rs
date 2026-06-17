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

const STORE_PREFIX: &str = "anthropic-managed-agent-vault:";
const STORE_ACTOR: &str = "runtime_provision";

#[derive(Debug, Clone, PartialEq, Eq)]
struct McpVaultCredential {
    url: String,
    token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EnvironmentVaultCredential {
    name: String,
    value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum VaultCredential {
    McpStaticBearer(McpVaultCredential),
    EnvironmentVariable(EnvironmentVaultCredential),
}

#[derive(Debug, Default)]
struct StoredVault {
    vault_id: Option<String>,
    credential_keys: BTreeSet<String>,
    credential_fingerprints: BTreeMap<String, String>,
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

    let mut required: Vec<VaultCredential> = gateway_mcp_credentials(state, mcp_servers)
        .into_iter()
        .map(VaultCredential::McpStaticBearer)
        .collect();
    required.extend(
        environment_credentials(created)?
            .into_iter()
            .map(VaultCredential::EnvironmentVariable),
    );
    if required.is_empty() {
        return Ok(None);
    }

    let store_name = store_name(created);
    let mut stored = load_stored_vault(pool, &store_name).await?;
    let mut changed = false;
    if stored_credential_changed(&stored, &required) {
        stored = StoredVault::default();
        changed = true;
    }
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
        let credential_key = credential.storage_key();
        let credential_fingerprint = credential.fingerprint();
        let unchanged = stored
            .credential_fingerprints
            .get(&credential_key)
            .map(|stored| stored == &credential_fingerprint)
            .unwrap_or(true);
        if stored.credential_keys.contains(&credential_key) && unchanged {
            continue;
        }
        create_credential(state, created, &vault_id, &credential).await?;
        stored.credential_keys.insert(credential_key.clone());
        stored
            .credential_fingerprints
            .insert(credential_key, credential_fingerprint);
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
        credential_keys: stored_credential_keys(&row.credential_values),
        credential_fingerprints: stored_credential_fingerprints(&row.credential_values),
    })
}

fn stored_credential_changed(stored: &StoredVault, required: &[VaultCredential]) -> bool {
    let required_fingerprints = required
        .iter()
        .map(|credential| (credential.storage_key(), credential.fingerprint()))
        .collect::<BTreeMap<_, _>>();

    stored
        .credential_keys
        .iter()
        .any(|key| !required_fingerprints.contains_key(key))
        || required_fingerprints.iter().any(|(key, fingerprint)| {
            stored
                .credential_fingerprints
                .get(key)
                .is_some_and(|stored| stored != fingerprint)
        })
}

fn stored_credential_keys(values: &Value) -> BTreeSet<String> {
    let mut keys: BTreeSet<String> = values
        .get("credential_keys")
        .and_then(Value::as_array)
        .map(|keys| {
            keys.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    keys.extend(
        values
            .get("credential_urls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|url| format!("mcp:{url}")),
    );
    keys
}

fn stored_credential_fingerprints(values: &Value) -> BTreeMap<String, String> {
    values
        .get("credential_fingerprints")
        .and_then(Value::as_object)
        .map(|values| {
            values
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn save_stored_vault(
    pool: &PgPool,
    store_name: &str,
    stored: &StoredVault,
) -> Result<(), GatewayError> {
    let credential_keys = stored
        .credential_keys
        .iter()
        .cloned()
        .collect::<Vec<String>>();
    let credential_urls = stored
        .credential_keys
        .iter()
        .filter_map(|key| key.strip_prefix("mcp:").map(str::to_owned))
        .collect::<Vec<String>>();
    let credential_fingerprints = stored.credential_fingerprints.clone();
    credentials::upsert(
        pool,
        store_name,
        json!({
            "vault_id": stored.vault_id,
            "credential_keys": credential_keys,
            "credential_fingerprints": credential_fingerprints,
            "credential_urls": credential_urls,
        }),
        json!({
            "provider": "anthropic",
            "purpose": "managed_agent_vault",
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
    credential: &VaultCredential,
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
        .json(&json!({ "auth": credential.auth() }))
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

impl VaultCredential {
    fn storage_key(&self) -> String {
        match self {
            Self::McpStaticBearer(credential) => format!("mcp:{}", credential.url),
            Self::EnvironmentVariable(credential) => format!("env:{}", credential.name),
        }
    }

    fn fingerprint(&self) -> String {
        match self {
            Self::McpStaticBearer(credential) => {
                stable_hash(&format!("mcp\0{}\0{}", credential.url, credential.token))
            }
            Self::EnvironmentVariable(credential) => {
                stable_hash(&format!("env\0{}\0{}", credential.name, credential.value))
            }
        }
    }

    fn auth(&self) -> Value {
        match self {
            Self::McpStaticBearer(credential) => json!({
                "type": "static_bearer",
                "mcp_server_url": credential.url,
                "token": credential.token
            }),
            Self::EnvironmentVariable(credential) => json!({
                "type": "environment_variable",
                "secret_name": credential.name,
                "secret_value": credential.value
            }),
        }
    }
}

fn environment_credentials(
    created: &CreatedRuntimeSession,
) -> Result<Vec<EnvironmentVaultCredential>, GatewayError> {
    let Some(environment) = created.environment.as_object() else {
        return Ok(Vec::new());
    };
    let mut credentials = Vec::new();
    for key_name in agent_vault_key_names(created) {
        let Some(value) = environment.get(&key_name).and_then(Value::as_str) else {
            continue;
        };
        if !is_environment_variable_name(&key_name) {
            return Err(GatewayError::InvalidJsonMessage(format!(
                "vault key {key_name} must be a valid environment variable name for Claude managed agents"
            )));
        }
        credentials.push(EnvironmentVaultCredential {
            name: key_name,
            value: value.to_owned(),
        });
    }
    Ok(credentials)
}

fn agent_vault_key_names(created: &CreatedRuntimeSession) -> Vec<String> {
    let mut names = BTreeSet::new();
    for value in created
        .agent
        .vault_keys
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let value = value.trim();
        if !value.is_empty() {
            names.insert(value.to_owned());
        }
    }
    names.into_iter().collect()
}

fn is_environment_variable_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn store_name(created: &CreatedRuntimeSession) -> String {
    format!(
        "{STORE_PREFIX}{}",
        stable_hash(&format!(
            "{}\0{}\0{}",
            anthropic_v1_base(&created.resolved.credential.api_base),
            created.resolved.credential.api_key,
            created.agent.id
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
mod tests;
