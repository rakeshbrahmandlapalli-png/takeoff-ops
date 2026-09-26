-- Parking Ops — database part 44: undo an import.
--
-- A wrong file imported onto a sheet (26 Sept: a file with dates but no
-- times added 161 cars and set 23 cars' times to midnight) can be undone
-- from the Import screen within 24 hours, by anyone who may import.
--
--   • import_sheet (part 40) is renamed import_sheet_core and left as it is.
--     A new import_sheet around it notes, before and after, every car of that
--     kind the import touched: the cars it added, and each changed car's
--     values before and after.
--   • undo_import(id) takes off the cars it added (unless someone has already
--     worked on one: sent, called, cleared, yard, PT, intake, paid, early),
--     and puts back what it changed, field by field, only where the value is
--     still what the import left (a tap made since is never undone).
--     A sheet the import created and that ends up empty is deleted.
--     Imports on one sheet are undone newest first.
--   • recent_imports() lists the last 24 hours for the Import screen.
-- Notes are kept 2 days. If part 40 is ever run again it replaces the new
-- import_sheet: run this part again after it.
-- Safe to run twice.

create table if not exists private.imports (
  id           bigint generated always as identity primary key,
  company_id   uuid not null references public.companies(id) on delete cascade,
  sheet_id     uuid,
  kind         text not null,
  day          date not null,
  at           timestamptz not null default now(),
  staff_id     uuid,
  staff_name   text not null default '',
  result       jsonb not null default '{}',
  added        uuid[] not null default '{}',
  changed      jsonb not null default '[]',   -- [{id, before, after}]
  sheet_created boolean not null default false,
  undone_at    timestamptz,
  undone_by    text
);
create index if not exists imports_company_idx on private.imports(company_id, at desc);

do $$ begin
  if exists (select 1 from pg_proc where proname = 'import_sheet' and pronamespace = 'public'::regnamespace)
     and not exists (select 1 from pg_proc where proname = 'import_sheet_core' and pronamespace = 'public'::regnamespace) then
    alter function public.import_sheet(text, date, jsonb, jsonb) rename to import_sheet_core;
  elsif exists (select 1 from pg_proc p where p.proname = 'import_sheet' and p.pronamespace = 'public'::regnamespace
                and pg_get_functiondef(p.oid) not like '%import_sheet_core%') then
    -- part 40 was run again: its import_sheet is the newer core
    drop function public.import_sheet_core(text, date, jsonb, jsonb);
    alter function public.import_sheet(text, date, jsonb, jsonb) rename to import_sheet_core;
  end if;
end $$;
revoke execute on function import_sheet_core(text, date, jsonb, jsonb) from public, anon, authenticated;

create or replace function import_sheet(p_kind text, p_day date, p_rows jsonb, p_source jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  res jsonb;
  had_sheet boolean;
  imp_id bigint;
begin
  if not can('import') then raise exception 'Not allowed for your role: import'; end if;
  select exists (select 1 from sheets where company_id = s.company_id and kind = p_kind and day = p_day) into had_sheet;
  create temp table if not exists _imp_before (id uuid primary key, row jsonb) on commit drop;
  truncate _imp_before;
  insert into _imp_before select b.id, to_jsonb(b) - 'updated_at' from bookings b where b.company_id = s.company_id and b.kind = p_kind;

  res := import_sheet_core(p_kind, p_day, p_rows, p_source);

  delete from private.imports where at < now() - interval '2 days';
  insert into private.imports(company_id, sheet_id, kind, day, staff_id, staff_name, result, added, changed, sheet_created)
  select s.company_id, (res->>'sheet_id')::uuid, p_kind, p_day, s.id, s.name, res,
    coalesce((select array_agg(b.id) from bookings b where b.company_id = s.company_id and b.kind = p_kind
              and not exists (select 1 from _imp_before o where o.id = b.id)), '{}'),
    coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'before', o.row, 'after', to_jsonb(b) - 'updated_at'))
              from bookings b join _imp_before o on o.id = b.id where (to_jsonb(b) - 'updated_at') is distinct from o.row), '[]'),
    not had_sheet
  returning id into imp_id;
  return res || jsonb_build_object('undo_id', imp_id);
end;
$$;
revoke execute on function import_sheet(text, date, jsonb, jsonb) from public, anon;
grant execute on function import_sheet(text, date, jsonb, jsonb) to authenticated;

create or replace function recent_imports()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'day', i.day, 'at', i.at, 'by', i.staff_name,
      'added', cardinality(i.added), 'changed', jsonb_array_length(i.changed),
      'undone', i.undone_at is not null,
      'latest', not exists (select 1 from private.imports j where j.company_id = i.company_id and j.kind = i.kind and j.day = i.day
                            and j.id > i.id and j.undone_at is null)) order by i.id desc), '[]')
  from private.imports i
  where i.company_id = my_company() and i.at > now() - interval '24 hours' and can('import')
$$;
revoke execute on function recent_imports() from public, anon;
grant execute on function recent_imports() to authenticated;

create or replace function undo_import(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  i private.imports;
  f text;
  fields text[] := array['sheet_id','num','ref','reg','name','phone','make','drop_at','return_at','orig_return_at','overstay',
    'called_word','called_at','called_by','sched_at','sched_time','est_at','est_time','flight_status','flight_note','flight',
    'note','pick_called','pick_called_at','early','early_at','moved_from'];
  ch jsonb;
  cur jsonb;
  patch jsonb;
  nb bookings;
  n_removed int := 0; n_kept int := 0; n_restored int := 0;
begin
  if not can('import') then raise exception 'Not allowed for your role: import'; end if;
  select * into i from private.imports where id = p_id and company_id = s.company_id for update;
  if i.id is null then raise exception 'That import can''t be found (imports can be undone for 24 hours).'; end if;
  if i.undone_at is not null then raise exception 'That import was already undone.'; end if;
  if i.at < now() - interval '24 hours' then raise exception 'Imports can only be undone within 24 hours.'; end if;
  if exists (select 1 from private.imports j where j.company_id = i.company_id and j.kind = i.kind and j.day = i.day and j.id > i.id and j.undone_at is null) then
    raise exception 'This sheet was imported again after that. Undo the later import first.';
  end if;

  -- Cars it added: taken off, unless someone has already worked on one.
  with gone as (
    select b.id from bookings b where b.id = any(i.added) and b.company_id = i.company_id
      and b.sent_at is null and b.called_at is null and b.cleared_at is null and coalesce(b.yard, '') = ''
      and b.pt_at is null and b.intake_at is null and b.charge_at is null and not coalesce(b.early, false)
      and not exists (select 1 from pt_links l where l.booking_id = b.id)
  ), del_act as (delete from activity a using gone where a.booking_id = gone.id)
  delete from bookings b using gone where b.id = gone.id;
  get diagnostics n_removed = row_count;
  n_kept := (select count(*) from bookings where id = any(i.added));

  -- Cars it changed: each field back, only where it's still what the import left.
  for ch in select * from jsonb_array_elements(i.changed) loop
    select to_jsonb(b) into cur from bookings b where b.id = (ch->>'id')::uuid;
    if cur is null then continue; end if;
    patch := '{}';
    foreach f in array fields loop
      if (cur->f) is not distinct from (ch->'after'->f) and (ch->'before'->f) is distinct from (ch->'after'->f) then
        patch := patch || jsonb_build_object(f, ch->'before'->f);
      end if;
    end loop;
    if patch = '{}' then continue; end if;
    nb := jsonb_populate_record(null::bookings, cur || patch);
    update bookings set
      sheet_id = nb.sheet_id, num = nb.num, ref = nb.ref, reg = nb.reg, name = nb.name, phone = nb.phone, make = nb.make,
      drop_at = nb.drop_at, return_at = nb.return_at, orig_return_at = nb.orig_return_at, overstay = nb.overstay,
      called_word = nb.called_word, called_at = nb.called_at, called_by = nb.called_by,
      sched_at = nb.sched_at, sched_time = nb.sched_time, est_at = nb.est_at, est_time = nb.est_time,
      flight_status = nb.flight_status, flight_note = nb.flight_note, flight = nb.flight, note = nb.note,
      pick_called = nb.pick_called, pick_called_at = nb.pick_called_at, early = nb.early, early_at = nb.early_at,
      moved_from = nb.moved_from, updated_at = now()
    where id = nb.id;
    n_restored := n_restored + 1;
  end loop;

  -- A sheet the import made, now empty, goes too.
  if i.sheet_created and i.sheet_id is not null and not exists (select 1 from bookings where sheet_id = i.sheet_id) then
    update bookings set moved_from = null where moved_from = i.sheet_id;
    delete from sheets where id = i.sheet_id and company_id = i.company_id;
  end if;

  update private.imports set undone_at = now(), undone_by = s.name where id = i.id;
  insert into activity(company_id, staff_id, staff_name, sheet_id, action, value)
  values (i.company_id, s.id, s.name, (select id from sheets where id = i.sheet_id), 'IMPORT UNDONE',
    i.kind || ' ' || i.day || ' (imported ' || to_char(i.at at time zone 'Europe/London', 'HH24:MI') || '): ' ||
    n_removed || ' cars taken off, ' || n_restored || ' put back' || case when n_kept > 0 then ', ' || n_kept || ' kept (already worked on)' else '' end);
  return jsonb_build_object('removed', n_removed, 'kept', n_kept, 'restored', n_restored, 'sheet_id', i.sheet_id,
    'sheet_gone', not exists (select 1 from sheets where id = i.sheet_id));
end;
$$;
revoke execute on function undo_import(bigint) from public, anon;
grant execute on function undo_import(bigint) to authenticated;
