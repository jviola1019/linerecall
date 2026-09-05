BEGIN;

-- Exact-token share resolution is the sole intentionally public data path.
-- The migration owner must be a NOLOGIN owner role with BYPASSRLS; the runtime
-- app role receives EXECUTE only and cannot scan either underlying table.
CREATE OR REPLACE FUNCTION resolve_unlisted_share(
  requested_token_sha256 bytea,
  requested_at timestamptz
) RETURNS TABLE (share_id uuid, revision_id uuid, document jsonb)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
STABLE
AS $function$
  SELECT share.id, share.revision_id, revision.document
  FROM public.share_links share
  JOIN public.repertoire_revisions revision
    ON revision.user_id = share.user_id AND revision.id = share.revision_id
  WHERE share.token_sha256 = requested_token_sha256
    AND share.revoked_at IS NULL
    AND (share.expires_at IS NULL OR share.expires_at > requested_at)
  LIMIT 1
$function$;

REVOKE ALL ON FUNCTION resolve_unlisted_share(bytea, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_unlisted_share(bytea, timestamptz) TO linerecall_app;

COMMIT;
