CREATE TABLE "output" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"format" text NOT NULL,
	"viewport" jsonb NOT NULL,
	"client_id" text,
	"board_id" text,
	"template_id" text,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "output_share" (
	"token" text PRIMARY KEY NOT NULL,
	"output_id" text NOT NULL,
	"version" integer NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "output_version" (
	"id" text PRIMARY KEY NOT NULL,
	"output_id" text NOT NULL,
	"version" integer NOT NULL,
	"template_version" integer,
	"kit_id" text,
	"kit_version" integer,
	"slot_values" jsonb NOT NULL,
	"html" text NOT NULL,
	"css" text NOT NULL,
	"js" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"format" text NOT NULL,
	"viewport" jsonb NOT NULL,
	"client_id" text,
	"starter_key" text,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_version" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"version" integer NOT NULL,
	"html" text NOT NULL,
	"css" text NOT NULL,
	"js" text DEFAULT '' NOT NULL,
	"slots" jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "output" ADD CONSTRAINT "output_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output" ADD CONSTRAINT "output_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output" ADD CONSTRAINT "output_template_id_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."template"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output" ADD CONSTRAINT "output_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_share" ADD CONSTRAINT "output_share_output_id_output_id_fk" FOREIGN KEY ("output_id") REFERENCES "public"."output"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_share" ADD CONSTRAINT "output_share_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_version" ADD CONSTRAINT "output_version_output_id_output_id_fk" FOREIGN KEY ("output_id") REFERENCES "public"."output"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_version" ADD CONSTRAINT "output_version_kit_id_style_kit_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."style_kit"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_version" ADD CONSTRAINT "output_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template" ADD CONSTRAINT "template_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template" ADD CONSTRAINT "template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_version" ADD CONSTRAINT "template_version_template_id_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_version" ADD CONSTRAINT "template_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "output_client_id_idx" ON "output" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "output_board_id_idx" ON "output" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "output_template_id_idx" ON "output" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "output_updated_at_idx" ON "output" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "output_share_output_idx" ON "output_share" USING btree ("output_id");--> statement-breakpoint
CREATE UNIQUE INDEX "output_version_output_version_idx" ON "output_version" USING btree ("output_id","version");--> statement-breakpoint
CREATE INDEX "output_version_kit_id_idx" ON "output_version" USING btree ("kit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "template_starter_key_idx" ON "template" USING btree ("starter_key");--> statement-breakpoint
CREATE INDEX "template_client_id_idx" ON "template" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "template_version_template_version_idx" ON "template_version" USING btree ("template_id","version");