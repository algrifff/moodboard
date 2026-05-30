CREATE TABLE "connection" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"account_email" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text,
	"expires_at" timestamp,
	"scopes" text NOT NULL,
	"workspace_id" text,
	"workspace_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "recent_external" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"icon_url" text,
	"mime_type" text,
	"last_used_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- asset.kind was previously applied via `drizzle-kit push` in dev; this
-- ADD COLUMN backfills that into the migration history so a from-scratch
-- migrate run also gets the column. Idempotent so it's safe either way.
ALTER TABLE "asset" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_external" ADD CONSTRAINT "recent_external_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_external" ADD CONSTRAINT "recent_external_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;