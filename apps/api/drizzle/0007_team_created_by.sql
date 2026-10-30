ALTER TABLE "asset" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "board" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "share" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board" ADD CONSTRAINT "board_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share" ADD CONSTRAINT "share_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "asset" SET "created_by" = "user_id";--> statement-breakpoint
UPDATE "board" SET "created_by" = "user_id";--> statement-breakpoint
UPDATE "share" SET "created_by" = "user_id";--> statement-breakpoint
-- One share per board now that boards are team-owned: keep the most
-- recently updated one.
DELETE FROM "share" s
USING "share" newer
WHERE s."board_id" = newer."board_id"
  AND (newer."updated_at", newer."token") > (s."updated_at", s."token");
