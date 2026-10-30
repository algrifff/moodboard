CREATE TABLE "design_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_run" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text,
	"format" text NOT NULL,
	"brief" text NOT NULL,
	"client_id" text,
	"kit_id" text,
	"kit_version" integer,
	"linear_issue" text,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chosen_output_id" text,
	"linear_comment_url" text,
	"posted_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design_run" ADD CONSTRAINT "design_run_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_run" ADD CONSTRAINT "design_run_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_run" ADD CONSTRAINT "design_run_kit_id_style_kit_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."style_kit"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_run" ADD CONSTRAINT "design_run_chosen_output_id_output_id_fk" FOREIGN KEY ("chosen_output_id") REFERENCES "public"."output"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_run" ADD CONSTRAINT "design_run_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_run_board_id_idx" ON "design_run" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "design_run_client_id_idx" ON "design_run" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "design_run_kit_id_idx" ON "design_run" USING btree ("kit_id");--> statement-breakpoint
CREATE INDEX "design_run_chosen_output_id_idx" ON "design_run" USING btree ("chosen_output_id");--> statement-breakpoint
CREATE INDEX "design_run_created_by_idx" ON "design_run" USING btree ("created_by");