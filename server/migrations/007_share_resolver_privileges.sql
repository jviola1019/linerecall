BEGIN;

-- Provision this dedicated role separately; never grant its membership to the
-- application or authentication roles. It may only read the resolver's tables.
DO $owner_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'linerecall_share_owner'
      AND NOT rolcanlogin AND NOT rolsuper AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'linerecall_share_owner must be a dedicated NOLOGIN NOSUPERUSER BYPASSRLS role';
  END IF;
  IF pg_catalog.pg_has_role('linerecall_app', 'linerecall_share_owner', 'MEMBER')
     OR pg_catalog.pg_has_role('linerecall_auth', 'linerecall_share_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'Runtime roles must not inherit or assume share resolver ownership';
  END IF;
END
$owner_check$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM linerecall_share_owner;
GRANT USAGE ON SCHEMA public TO linerecall_share_owner;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM linerecall_share_owner;
GRANT SELECT ON public.share_links, public.repertoire_revisions TO linerecall_share_owner;

ALTER FUNCTION public.resolve_unlisted_share(bytea, timestamptz) OWNER TO linerecall_share_owner;
ALTER FUNCTION public.resolve_unlisted_share(bytea, timestamptz) SET search_path = pg_catalog;
REVOKE ALL ON FUNCTION public.resolve_unlisted_share(bytea, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_unlisted_share(bytea, timestamptz) TO linerecall_app;

COMMIT;
