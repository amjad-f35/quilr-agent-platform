use serde_json::json;

use super::*;

#[test]
fn elastic_agent_config_uses_runtime_api_spec() {
    let agent = ImportAgent {
        external_id: "elastic-ai-agent".to_owned(),
        name: Some("Elastic AI Agent".to_owned()),
        description: None,
        model: None,
        raw: Some(json!({ "id": "elastic-ai-agent" })),
    };

    let config = agent_config(
        &ELASTIC_IMPORT_AGENTS,
        "https://example.elastic-cloud.com",
        &agent,
        &CredentialMode::Shared,
        Some("provider:elastic:agent:elastic-ai-agent".to_owned()),
    );

    assert_eq!(config["runtime"], "elastic_agent_builder");
    assert_eq!(config["elastic_agent_id"], "elastic-ai-agent");
    assert_eq!(config["source"]["provider"], "elastic");
    assert_eq!(config["source"]["api_spec"], "elastic_agent_builder");
}

#[test]
fn elastic_import_provider_resolves_by_api_spec() {
    let provider = provider_for_id("elastic_agent_builder").unwrap();

    assert_eq!(provider.id(), "elastic");
    assert_eq!(provider.api_spec(), "elastic_agent_builder");
}
