CREATE TABLE "boards" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "boards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"repo" text,
	"base_branch" text NOT NULL,
	"time_zone" text NOT NULL,
	"default_routine_owner" text,
	"environments" jsonb NOT NULL,
	"sensitive_paths" jsonb NOT NULL,
	"version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "errors" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"task" text NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"glob_id" text NOT NULL,
	"type" text NOT NULL,
	"actor" text,
	"at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "globs" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"type" text NOT NULL,
	"group_name" text,
	"planner" text NOT NULL,
	"implementer" text,
	"creation_key" text,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "id_counters" (
	"board_id" integer NOT NULL,
	"letter" text NOT NULL,
	"n" integer NOT NULL,
	CONSTRAINT "id_counters_board_id_letter_pk" PRIMARY KEY("board_id","letter")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"board_id" integer NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "members_board_id_email_pk" PRIMARY KEY("board_id","email")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"glob_id" text NOT NULL,
	"effect" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"email" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"cognito_sub" text,
	"github_username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "globs" ADD CONSTRAINT "globs_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_email_users_email_fk" FOREIGN KEY ("email") REFERENCES "public"."users"("email") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_email_users_email_fk" FOREIGN KEY ("email") REFERENCES "public"."users"("email") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_glob_idx" ON "events" USING btree ("glob_id","id");--> statement-breakpoint
CREATE INDEX "globs_board_status_idx" ON "globs" USING btree ("board_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "globs_creation_key_idx" ON "globs" USING btree ("board_id","creation_key");--> statement-breakpoint
CREATE INDEX "members_email_idx" ON "members" USING btree ("email");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("state","run_after");