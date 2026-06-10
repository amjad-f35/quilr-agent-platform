UPDATE "LiteLLM_ManagedAgentsTable"
SET config = jsonb_set(
  config,
  '{elastic_agent_id}',
  to_jsonb(config->'source'->>'external_agent_id')
)
WHERE config->'source'->>'provider' = 'elastic'
  AND config->'source'->>'api_spec' = 'elastic_agent_builder'
  AND config->'source'->>'external_agent_id' IS NOT NULL
  AND config->>'elastic_agent_id' IS NULL;
