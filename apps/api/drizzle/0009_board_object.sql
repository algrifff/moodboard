CREATE TABLE "board_object" (
	"board_id" text NOT NULL,
	"id" text NOT NULL,
	"type" text NOT NULL,
	"object" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "board_object_board_id_id_pk" PRIMARY KEY("board_id","id")
);
--> statement-breakpoint
ALTER TABLE "board_object" ADD CONSTRAINT "board_object_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_object" ADD CONSTRAINT "board_object_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_object_type_idx" ON "board_object" USING btree ("type");--> statement-breakpoint
-- Backfill from the board.data blob. Array order is the canvas stacking
-- order, so created_at is offset by ordinality to preserve it.
INSERT INTO "board_object" ("board_id", "id", "type", "object", "updated_by", "created_at", "updated_at")
SELECT b."id", o.value->>'id', o.value->>'type', o.value, b."created_by",
       b."created_at" + (o.ordinality * interval '1 microsecond'), b."updated_at"
FROM "board" b,
     jsonb_array_elements(CASE WHEN jsonb_typeof(b."data"->'objects') = 'array' THEN b."data"->'objects' ELSE '[]'::jsonb END)
       WITH ORDINALITY o(value, ordinality)
WHERE o.value->>'id' IS NOT NULL AND o.value->>'type' IS NOT NULL
ON CONFLICT DO NOTHING;
