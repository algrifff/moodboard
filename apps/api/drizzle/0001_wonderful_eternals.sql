CREATE TABLE "group_analysis" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"analysis" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
