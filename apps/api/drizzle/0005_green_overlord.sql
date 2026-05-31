CREATE TABLE "board_group_display" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"group_key" text NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"agent_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_group_display" ADD CONSTRAINT "board_group_display_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "board_group_display_board_group_idx" ON "board_group_display" USING btree ("board_id","group_key");