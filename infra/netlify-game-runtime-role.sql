-- Managed role creators have ADMIN but not necessarily SET membership.
-- The Function must explicitly enter the restricted coordinator role; do
-- not add the game role to the account runtime or inherit it by default.
do $$ begin
  if pg_has_role('kanto_netlify_runtime','kanto_game_runtime','MEMBER') then
    raise exception 'The account runtime must not inherit the game coordinator';
  end if;
end $$;
grant kanto_game_runtime to current_user with inherit false;
grant kanto_game_runtime to current_user with set true;
