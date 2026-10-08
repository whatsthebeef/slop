CREATE TABLE "notification_dismissals" (
	"notification_id" text NOT NULL,
	"email" text NOT NULL,
	"items" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_dismissals_notification_id_email_pk" PRIMARY KEY("notification_id","email")
);
--> statement-breakpoint
ALTER TABLE "board_notifications" ADD COLUMN "items" jsonb;--> statement-breakpoint
ALTER TABLE "notification_dismissals" ADD CONSTRAINT "notification_dismissals_notification_id_board_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."board_notifications"("id") ON DELETE cascade ON UPDATE no action;