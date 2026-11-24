# North Pole Phone

A family Christmas app: kids "call" Santa and friends, talk to them out loud, pick gifts from pictures, and build a wish list per child.

- `index.html` is the whole app (hosted with GitHub Pages).
- `supabase/functions/np/index.ts` is the backend (a Supabase Edge Function). It holds the API keys as secrets (`ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `FAMILY_CODE`) and stores the lists in Postgres.

No keys or list data live in this repository.
