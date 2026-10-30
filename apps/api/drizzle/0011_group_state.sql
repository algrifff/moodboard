ALTER TABLE "board_group_display" ALTER COLUMN "kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "board_group_display" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "board_group_display" ADD COLUMN "selected_agent_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "board_group_display" ADD COLUMN "ai_palette" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- Backfill: the agent row starts as the agents that produced the display,
-- and the palette lock comes from the display itself.
UPDATE "board_group_display" SET
  "selected_agent_ids" = "agent_ids",
  "ai_palette" = COALESCE(
    CASE "kind"
      WHEN 'ad' THEN ARRAY(SELECT jsonb_array_elements_text("data"->'palette'))
      WHEN 'brief' THEN ARRAY(SELECT p->>'hex' FROM jsonb_array_elements("data"->'palette') p)
    END,
    '{}'::text[]
  )
WHERE jsonb_typeof("data"->'palette') = 'array';
