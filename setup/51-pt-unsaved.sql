-- Parking Ops — database part 51: PT ticked but its photos not saved in the app.
--
-- pt_unsaved(sheet): the PICKS cars on that sheet whose PT was ticked more
-- than 2 hours ago (and within the last 36), with no set of photos saved for
-- them (pt_links) and no reason given for ticking PT without photos in the
-- app (a PT COPY line "PT ticked without photos in the app…"). The office
-- sees PT NOT SAVED on those rows: the phone that took the photos is still
-- holding them, and saves them once it has signal and the app is open.
-- Office and managers only. Safe to run twice.

create or replace function pt_unsaved(p_sheet uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not can('import') then return '[]'; end if;
  return coalesce((
    select jsonb_agg(b.id)
    from bookings b
    where b.sheet_id = p_sheet and b.company_id = my_company() and b.kind = 'picks' and b.removed_at is null
      and b.pt_at is not null and b.pt_at < now() - interval '2 hours' and b.pt_at > now() - interval '36 hours'
      and not exists (select 1 from pt_links l where l.booking_id = b.id)
      and not exists (select 1 from activity a where a.booking_id = b.id and a.action = 'PT COPY'
                        and a.value like 'PT ticked without photos%' and a.at >= b.pt_at - interval '5 minutes')
  ), '[]');
end;
$$;
revoke execute on function pt_unsaved(uuid) from public, anon;
grant execute on function pt_unsaved(uuid) to authenticated;
