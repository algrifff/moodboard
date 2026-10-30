-- Notion integration removed. Strip notion-page objects from boards and
-- share snapshots (plus their ids from snapshot groups), then drop the
-- connections. recent_external rows cascade with the connection.
UPDATE "board"
SET "data" = jsonb_set(
  "data",
  '{objects}',
  COALESCE(
    (SELECT jsonb_agg(o) FROM jsonb_array_elements("data"->'objects') o WHERE o->>'type' <> 'notion-page'),
    '[]'::jsonb
  )
)
WHERE jsonb_typeof("data"->'objects') = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements("data"->'objects') o WHERE o->>'type' = 'notion-page');
--> statement-breakpoint
UPDATE "share"
SET "snapshot" = jsonb_set(
  jsonb_set(
    "snapshot",
    '{objects}',
    COALESCE(
      (SELECT jsonb_agg(o) FROM jsonb_array_elements("snapshot"->'objects') o WHERE o->>'type' <> 'notion-page'),
      '[]'::jsonb
    )
  ),
  '{groups}',
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_set(
          g,
          '{objectIds}',
          COALESCE(
            (
              SELECT jsonb_agg(id)
              FROM jsonb_array_elements(g->'objectIds') id
              WHERE id NOT IN (
                SELECT o->'id' FROM jsonb_array_elements("snapshot"->'objects') o
                WHERE o->>'type' = 'notion-page'
              )
            ),
            '[]'::jsonb
          )
        )
      )
      FROM jsonb_array_elements("snapshot"->'groups') g
    ),
    '[]'::jsonb
  )
)
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements("snapshot"->'objects') o WHERE o->>'type' = 'notion-page');
--> statement-breakpoint
DELETE FROM "connection" WHERE "provider" = 'notion';
