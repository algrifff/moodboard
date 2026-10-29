-- array_to_string is only STABLE, which a generated column rejects; this
-- IMMUTABLE wrapper is safe for text[] (no locale- or type-dependent output).
CREATE FUNCTION "asset_tags_text"(text[]) RETURNS text
	LANGUAGE sql IMMUTABLE PARALLEL SAFE
	AS $$ SELECT array_to_string($1, ' ') $$;
--> statement-breakpoint
CREATE TABLE "client" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_mapping" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"linear_id" text NOT NULL,
	"linear_name" text NOT NULL,
	"client_id" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "style_kit" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "style_kit_version" (
	"id" text PRIMARY KEY NOT NULL,
	"kit_id" text NOT NULL,
	"version" integer NOT NULL,
	"tokens" jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "original_name" text;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "media_kind" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "colors" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "caption" text;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "enriched_at" timestamp;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', regexp_replace(coalesce(original_name, ''), '[._-]+', ' ', 'g')), 'A') || setweight(to_tsvector('english', asset_tags_text(tags)), 'A') || setweight(to_tsvector('english', coalesce(caption, '')), 'B')) STORED;--> statement-breakpoint
ALTER TABLE "board" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "client_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_mapping" ADD CONSTRAINT "linear_mapping_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_mapping" ADD CONSTRAINT "linear_mapping_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_kit" ADD CONSTRAINT "style_kit_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_kit" ADD CONSTRAINT "style_kit_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_kit_version" ADD CONSTRAINT "style_kit_version_kit_id_style_kit_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."style_kit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_kit_version" ADD CONSTRAINT "style_kit_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_slug_idx" ON "client" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_mapping_kind_linear_id_idx" ON "linear_mapping" USING btree ("kind","linear_id");--> statement-breakpoint
CREATE INDEX "linear_mapping_client_id_idx" ON "linear_mapping" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "style_kit_client_id_idx" ON "style_kit" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "style_kit_version_kit_version_idx" ON "style_kit_version" USING btree ("kit_id","version");--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board" ADD CONSTRAINT "board_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_client_id_idx" ON "asset" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "asset_created_at_idx" ON "asset" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "asset_search_idx" ON "asset" USING gin ("search");--> statement-breakpoint
CREATE INDEX "board_client_id_idx" ON "board" USING btree ("client_id");--> statement-breakpoint
-- Backfill the library kind for existing assets (mirrors mediaKindFromMime in
-- packages/shared/src/library.ts). Colours, dimensions and captions are filled
-- lazily by the maintenance tick; only images have anything to extract, so the
-- rest are marked done.
UPDATE "asset" SET "media_kind" = CASE
	WHEN "mime_type" LIKE 'image/%' THEN 'image'
	WHEN "mime_type" = 'application/pdf' THEN 'pdf'
	WHEN "mime_type" LIKE 'audio/%' THEN 'audio'
	WHEN "mime_type" LIKE 'font/%' OR "mime_type" ~ '^application/(x-)?font' OR "mime_type" = 'application/vnd.ms-fontobject' THEN 'font'
	ELSE 'other'
END;--> statement-breakpoint
UPDATE "asset" SET "enriched_at" = now() WHERE "media_kind" <> 'image' OR "kind" = 'pdf-thumb';
