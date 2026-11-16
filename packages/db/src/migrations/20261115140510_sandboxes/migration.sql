CREATE TABLE "sandbox_images" (
	"id" uuid PRIMARY KEY,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"image" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sandbox_images_organization_image_uidx" UNIQUE("organization_id","provider","image"),
	CONSTRAINT "sandbox_images_provider_check" CHECK ("provider" in ('uncloud'))
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"resource_id" uuid PRIMARY KEY,
	"organization_id" text NOT NULL,
	"slug" text NOT NULL,
	"provider" text NOT NULL,
	"cluster_id" uuid,
	"machine" text,
	"ssh_port" integer,
	"ssh_host" text,
	"volume_id" uuid CONSTRAINT "sandboxes_volume_uidx" UNIQUE,
	"image" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"external_id" text,
	"authorized_keys" text,
	"password" text,
	"ttl_seconds" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sandboxes_organization_slug_uidx" UNIQUE("organization_id","slug"),
	CONSTRAINT "sandboxes_cluster_ssh_port_uidx" UNIQUE("cluster_id","ssh_port"),
	CONSTRAINT "sandboxes_provider_check" CHECK ("provider" in ('uncloud')),
	CONSTRAINT "sandboxes_status_check" CHECK ("status" in ('provisioning', 'running', 'failed', 'destroying')),
	CONSTRAINT "sandboxes_ttl_check" CHECK ("ttl_seconds" is null or "ttl_seconds" > 0),
	CONSTRAINT "sandboxes_slug_check" CHECK ("slug" ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' and length("slug") <= 55),
	CONSTRAINT "sandboxes_cluster_check" CHECK (("provider" = 'uncloud') = ("cluster_id" is not null and "ssh_port" is not null)),
	CONSTRAINT "sandboxes_ssh_port_check" CHECK ("ssh_port" is null or "ssh_port" between 1 and 65535)
);
--> statement-breakpoint
CREATE TABLE "volumes" (
	"id" uuid PRIMARY KEY,
	"cluster_id" uuid NOT NULL,
	"name" text NOT NULL,
	"machine" text,
	"resource_id" uuid CONSTRAINT "volumes_resource_uidx" UNIQUE,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "volumes_cluster_name_uidx" UNIQUE("cluster_id","name")
);
--> statement-breakpoint
ALTER TABLE "sandbox_images" ADD CONSTRAINT "sandbox_images_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_resource_id_resources_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_cluster_id_clusters_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_volume_id_volumes_id_fkey" FOREIGN KEY ("volume_id") REFERENCES "volumes"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "volumes" ADD CONSTRAINT "volumes_cluster_id_clusters_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "volumes" ADD CONSTRAINT "volumes_resource_id_resources_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") DEFERRABLE INITIALLY DEFERRED;