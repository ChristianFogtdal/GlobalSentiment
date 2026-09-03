-- ============================================================================
-- inspect_legacy_analysis_schema.sql
--
-- READ-ONLY inspection script for the hosted legacy sentiment-analysis
-- schema. Run this in the Supabase SQL editor (or via `supabase db pull`
-- style tooling) against the hosted project BEFORE writing any new
-- migration that touches post_analyses / completed_post_analyses.
--
-- This script does not create, alter, or drop anything. It only reads
-- catalog metadata (information_schema / pg_catalog) so the exact legacy
-- definitions can be captured and reproduced in a clearly labelled legacy
-- baseline migration.
--
-- Save the query results OUTSIDE source control unless you have confirmed
-- they contain no sensitive operational data (e.g. no embedded secrets,
-- no real user PII in sample rows -- this script does not select data
-- rows from the tables themselves, only structure/metadata).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Table existence + basic metadata for the legacy tables/views of interest
-- ---------------------------------------------------------------------------
select
    table_schema,
    table_name,
    table_type
from information_schema.tables
where table_schema = 'public'
  and table_name in ('post_analyses', 'completed_post_analyses', 'bluesky_posts')
order by table_name;

-- ---------------------------------------------------------------------------
-- 2. Column definitions for the legacy tables/views
-- ---------------------------------------------------------------------------
select
    table_name,
    ordinal_position,
    column_name,
    data_type,
    udt_name,
    character_maximum_length,
    numeric_precision,
    numeric_scale,
    is_nullable,
    column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('post_analyses', 'completed_post_analyses')
order by table_name, ordinal_position;

-- ---------------------------------------------------------------------------
-- 3. View definition (if completed_post_analyses is a view, not a table)
-- ---------------------------------------------------------------------------
select
    table_name,
    view_definition
from information_schema.views
where table_schema = 'public'
  and table_name = 'completed_post_analyses';

-- ---------------------------------------------------------------------------
-- 4. Constraints: primary key, unique, check, foreign key
-- ---------------------------------------------------------------------------
select
    tc.table_name,
    tc.constraint_name,
    tc.constraint_type,
    kcu.column_name,
    ccu.table_name as foreign_table_name,
    ccu.column_name as foreign_column_name
from information_schema.table_constraints tc
left join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name
   and tc.table_schema = kcu.table_schema
left join information_schema.constraint_column_usage ccu
    on tc.constraint_name = ccu.constraint_name
   and tc.table_schema = ccu.table_schema
where tc.table_schema = 'public'
  and tc.table_name in ('post_analyses', 'completed_post_analyses')
order by tc.table_name, tc.constraint_type, tc.constraint_name;

-- ---------------------------------------------------------------------------
-- 5. Check constraint definitions (full expression text)
-- ---------------------------------------------------------------------------
select
    conrelid::regclass as table_name,
    conname as constraint_name,
    pg_get_constraintdef(oid) as constraint_definition
from pg_constraint
where conrelid in (
    'public.post_analyses'::regclass,
    'public.completed_post_analyses'::regclass
)
and contype = 'c'
order by conrelid, conname;

-- ---------------------------------------------------------------------------
-- 6. Indexes
-- ---------------------------------------------------------------------------
select
    tablename,
    indexname,
    indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('post_analyses', 'completed_post_analyses')
order by tablename, indexname;

-- ---------------------------------------------------------------------------
-- 7. Triggers
-- ---------------------------------------------------------------------------
select
    event_object_table as table_name,
    trigger_name,
    action_timing,
    event_manipulation,
    action_statement
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table in ('post_analyses', 'completed_post_analyses')
order by event_object_table, trigger_name;

-- ---------------------------------------------------------------------------
-- 8. Functions referenced by triggers, or otherwise related by naming
-- ---------------------------------------------------------------------------
select
    n.nspname as schema_name,
    p.proname as function_name,
    pg_get_functiondef(p.oid) as function_definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (
    p.proname ilike '%post_analys%'
    or p.proname ilike '%analysis%'
  );

-- ---------------------------------------------------------------------------
-- 9. Row Level Security status and policies
-- ---------------------------------------------------------------------------
select
    schemaname,
    tablename,
    rowsecurity,
    forcerowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('post_analyses', 'completed_post_analyses');

select
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('post_analyses', 'completed_post_analyses')
order by tablename, policyname;

-- ---------------------------------------------------------------------------
-- 10. Grants (table privileges) per role
-- ---------------------------------------------------------------------------
select
    table_name,
    grantee,
    privilege_type,
    is_grantable
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('post_analyses', 'completed_post_analyses')
order by table_name, grantee, privilege_type;

-- ---------------------------------------------------------------------------
-- 11. Role membership relevant to anon / authenticated / service_role
-- ---------------------------------------------------------------------------
select
    r.rolname as role_name,
    r.rolsuper,
    r.rolinherit,
    r.rolcreaterole,
    r.rolcreatedb,
    r.rolcanlogin,
    array(
        select b.rolname
        from pg_auth_members m
        join pg_roles b on b.oid = m.roleid
        where m.member = r.oid
    ) as member_of
from pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role', 'postgres')
order by r.rolname;

-- ---------------------------------------------------------------------------
-- 12. Sequences owned by the legacy tables (for identity/serial columns)
-- ---------------------------------------------------------------------------
select
    s.relname as sequence_name,
    t.relname as owning_table,
    a.attname as owning_column
from pg_class s
join pg_depend d on d.objid = s.oid and d.deptype = 'a'
join pg_class t on t.oid = d.refobjid
join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
where s.relkind = 'S'
  and t.relname in ('post_analyses', 'completed_post_analyses');
