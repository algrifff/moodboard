CREATE TABLE "rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_key_user_id_idx" ON "api_key" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "asset_filename_idx" ON "asset" USING btree ("filename");--> statement-breakpoint
CREATE INDEX "board_updated_at_idx" ON "board" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "connection_user_id_idx" ON "connection" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recent_external_user_id_idx" ON "recent_external" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recent_external_connection_id_idx" ON "recent_external" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "rate_limit" SET UNLOGGED;
