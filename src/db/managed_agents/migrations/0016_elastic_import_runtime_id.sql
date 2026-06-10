UPDATE "LiteLLM_ManagedAgentsTable"
SET config = jsonb_set(config, '{runtime}', '"elastic_agent_builder"'::jsonb)
WHERE config->>'runtime' = 'elastic'
  AND config->'source'->>'provider' = 'elastic'
  AND config->'source'->>'api_spec' = 'elastic_agent_builder';
