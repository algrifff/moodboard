CREATE TABLE "render_job" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_at" timestamp,
	"locked_by" text,
	"result" jsonb,
	"error" text,
	"output_id" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "render_job" ADD CONSTRAINT "render_job_output_id_output_id_fk" FOREIGN KEY ("output_id") REFERENCES "public"."output"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_job" ADD CONSTRAINT "render_job_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "render_job_status_created_idx" ON "render_job" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "render_job_output_id_idx" ON "render_job" USING btree ("output_id");--> statement-breakpoint
CREATE INDEX "render_job_created_by_idx" ON "render_job" USING btree ("created_by");