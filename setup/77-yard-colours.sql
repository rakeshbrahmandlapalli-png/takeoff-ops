-- Parking Ops — database part 77: a colour for each yard's tag.
--
-- Settings → Yard colours (owners only): one colour per yard (#RRGGBB). The
-- app paints that yard's tag on DROPS and PICKS rows, the PICKS location
-- button and the car panel's yard buttons with it. A yard with no colour
-- keeps its look's own colour.
--   • companies.yard_colours ({"MY": "#2E7D32", …}), set_yard_colours()
-- Airport Parking Bay starts with main yard green, GS orange, terminal yellow.
-- Safe to run twice (the starting colours go in only while none are set).

alter table companies add column if not exists yard_colours jsonb not null default '{}';

-- p_colours: {"MY": "#2E7D32", …}; blank drops that yard's colour.
create or replace function set_yard_colours(p_colours jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  ys text[] := (select yards from companies where id = s.company_id);
  yc jsonb := '{}';
  k text; v text;
begin
  if s.role <> 'owner' then raise exception 'Only an owner can change the yard colours.'; end if;
  for k, v in select key, value #>> '{}' from jsonb_each(coalesce(p_colours, '{}')) loop
    if not (upper(k) = any(ys)) then raise exception 'Not a valid yard: %', k; end if;
    if coalesce(trim(v), '') = '' then continue; end if;
    if trim(v) !~ '^#[0-9A-Fa-f]{6}$' then raise exception 'Check the colour for %.', k; end if;
    yc := yc || jsonb_build_object(upper(k), upper(trim(v)));
  end loop;
  update companies set yard_colours = yc where id = s.company_id;
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (s.company_id, s.id, s.name, 'SETTINGS', 'Yard colours'
    || coalesce(' ' || (select string_agg(key || ' ' || value, ', ' order by key) from jsonb_each_text(yc)), ' cleared'));
  return jsonb_build_object('yard_colours', yc);
end;
$$;
revoke execute on function set_yard_colours(jsonb) from public, anon;
grant execute on function set_yard_colours(jsonb) to authenticated;

update companies set yard_colours = '{"MY": "#2E7D32", "GS": "#EF6C00", "T": "#FBC02D"}'
where slug = 'airport-parking-bay' and yard_colours = '{}';

select name, yards, yard_colours from companies order by name;
