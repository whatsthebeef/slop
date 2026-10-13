CREATE TABLE IF NOT EXISTS "status_dismissals" (
	"user_email" text NOT NULL,
	"glob_id" text NOT NULL,
	"key" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "status_dismissals_user_email_glob_id_key_pk" PRIMARY KEY("user_email","glob_id","key")
);
