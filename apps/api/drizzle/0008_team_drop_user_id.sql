ALTER TABLE "asset" DROP CONSTRAINT "asset_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "board" DROP CONSTRAINT "board_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "share" DROP CONSTRAINT "share_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "share_board_user_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "share_board_idx" ON "share" USING btree ("board_id");--> statement-breakpoint
ALTER TABLE "asset" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "board" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "share" DROP COLUMN "user_id";