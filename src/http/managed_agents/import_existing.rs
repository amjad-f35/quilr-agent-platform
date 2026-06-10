use std::collections::HashMap;

use crate::errors::GatewayError;

pub async fn imported_agent_ids(
    pool: &sqlx::PgPool,
    provider_id: &str,
) -> Result<HashMap<String, String>, GatewayError> {
    let rows = sqlx::query_as::<_, (String, String)>(
        r#"
        SELECT
          config->'source'->>'external_agent_id' AS external_agent_id,
          id
        FROM "LiteLLM_ManagedAgentsTable"
        WHERE config->'source'->>'provider' = $1
          AND config->'source'->>'external_agent_id' IS NOT NULL
        "#,
    )
    .bind(provider_id)
    .fetch_all(pool)
    .await
    .map_err(GatewayError::Database)?;
    Ok(rows.into_iter().collect())
}
