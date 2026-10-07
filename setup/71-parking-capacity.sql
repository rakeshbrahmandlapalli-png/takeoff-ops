-- Parking Ops — database part 71: car park capacity.
--
-- Each company sets how many cars it can park (Settings → Car park capacity),
-- in all and, if it wants, per yard. The dashboard shows Parked now against it
-- (spaces free, or over). Stored on companies:
--   • capacity       integer, null = not set
--   • yard_capacity  jsonb {"NB": 120, "S": 80}; only the company's own yards
-- set_capacity: owner and managers (can('settings')), logged as SETTINGS.
-- Safe to run twice.

alter table companies add column if not exists capacity integer;
alter table companies add column if not exists yard_capacity jsonb not null default '{}';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'companies_capacity_check') then
    alter table companies add constraint companies_capacity_check check (capacity is null or capacity between 1 and 100000);
  end if;
end $$;

-- p_total: null or 0 = not set. p_yards: {"NB": 120, …}; blank or 0 drops that yard.
create or replace function set_capacity(p_total integer, p_yards jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  ys text[] := (select yards from companies where id = s.company_id);
  yc jsonb := '{}';
  k text; v text; n integer;
  tot integer := nullif(coalesce(p_total, 0), 0);
begin
  if not can('settings') then raise exception 'Only an owner or manager can change settings.'; end if;
  if tot is not null and (tot < 1 or tot > 100000) then raise exception 'Check the number of spaces.'; end if;
  for k, v in select key, value #>> '{}' from jsonb_each(coalesce(p_yards, '{}')) loop
    if not (upper(k) = any(ys)) then raise exception 'Not a valid yard: %', k; end if;
    if coalesce(trim(v), '') = '' then continue; end if;
    if trim(v) !~ '^\d{1,6}$' then raise exception 'Check the spaces for %.', k; end if;
    n := trim(v)::integer;
    if n = 0 then continue; end if;
    if n > 100000 then raise exception 'Check the spaces for %.', k; end if;
    yc := yc || jsonb_build_object(upper(k), n);
  end loop;
  update companies set capacity = tot, yard_capacity = yc where id = s.company_id;
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (s.company_id, s.id, s.name, 'SETTINGS', case when tot is null then 'Capacity not set' else 'Capacity ' || tot || ' cars' end
    || coalesce((select ' (' || string_agg(key || ' ' || value, ', ' order by key) || ')' from jsonb_each_text(yc)), ''));
  return jsonb_build_object('capacity', tot, 'yard_capacity', yc);
end;
$$;
revoke execute on function set_capacity(integer, jsonb) from public, anon;
grant execute on function set_capacity(integer, jsonb) to authenticated;

select name, capacity, yard_capacity from companies order by name;
