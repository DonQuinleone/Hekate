-- Roles become a level in each area (#142). What seeing a project used to bring with it is
-- now named, and each existing role is given what it could already do, so no one loses access:
-- seeing a project read its comments, takes, workflow and people; organising deleted;
-- managing roles archived and edited the project.
UPDATE "project_roles"
  SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['read_comments', 'view_takes', 'view_workflows', 'view_people']))
  WHERE 'view' = ANY("permissions");--> statement-breakpoint
UPDATE "project_roles"
  SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['delete_files']))
  WHERE 'organise' = ANY("permissions");--> statement-breakpoint
UPDATE "project_roles"
  SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['edit_project', 'delete_project']))
  WHERE 'manage_roles' = ANY("permissions");
