CREATE TABLE "share" (
	"token" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"asset_filenames" text[] DEFAULT '{}'::text[] NOT NULL,
	"pdf_filename" text,
	"pdf_generated_at" timestamp,
	"captured_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "share" ADD CONSTRAINT "share_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share" ADD CONSTRAINT "share_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "share_board_user_idx" ON "share" USING btree ("board_id","user_id");