CREATE TABLE "deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"event" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
