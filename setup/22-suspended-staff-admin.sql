-- Parking Ops — database part 22: a suspended client can't manage staff either.
--
-- Part 19 made me() and my_company() skip suspended clients, which locks
-- their staff out of the app. The manage-staff function asks
-- staff_admin_context() instead, which still found them - so a suspended
-- client's office could have added people or reset links. Now it skips them
-- too. Safe to run twice.

create or replace function staff_admin_context()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('staff_id', s.id, 'company_id', s.company_id, 'role', s.role, 'name', s.name, 'can_staff', can('staff'))
  from staff s join companies c on c.id = s.company_id
  where s.user_id = auth.uid() and s.active and c.suspended_at is null limit 1
$$;
