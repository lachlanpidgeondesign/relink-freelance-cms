# Relink Platform

A web platform for **commissioning, reviewing and publishing Relink puzzles**. Freelance
writers submit puzzles, staff review and edit them, and editors publish the finished
puzzle to the live Puzzlr game — all through a role-based workflow backed by
[Supabase](https://supabase.com) (auth, Postgres, Row-Level Security and Edge Functions).

Built as a vanilla HTML/CSS/JS single-page app — **no build step, no framework, no
bundler**. ES modules are loaded directly in the browser and the Supabase JS SDK is
imported from a CDN.

## How it works

Everyone signs in to the same platform; their **role** decides what they see and can do.

| Role | Can do |
|------|--------|
| **Writer** | Create and edit their own puzzle drafts, then submit them for review. |
| **Reviewer** | Play submitted puzzles, comment, send them back for changes, or mark them ready. |
| **Editor** | Everything a reviewer can, plus edit any puzzle in place and publish it to Puzzlr. |
| **Admin** | Everything an editor can, plus manage the team (invite people, change roles). |

Puzzles move through a state machine — `draft → submitted → in_review → ready →
published`, with `changes_requested` looping back to the writer. The transitions are
validated in the database, not just the UI.

### Security model

Row-Level Security (RLS) in Postgres is the real access boundary; the role-based UI is a
convenience layer on top. Privileged actions (publishing to Puzzlr, inviting users) run in
**Edge Functions** that hold the secret keys server-side — those keys never reach the
browser. Access is **invite-only**: there is no public sign-up. Admins invite people from
the Team area, and invitees set their password via an emailed link.

## Running locally

Any static file server works, since the app talks directly to Supabase. The bundled Python
server is handy for local dev:

```bash
python3 server.py 8080
```

Then open **http://localhost:8080/platform.html** in Chrome or Edge.

> The in-place puzzle composer uses the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API) for some legacy tooling, so Chrome or Edge is recommended.

## Configuration

Client configuration lives in [`js/platform/config.js`](js/platform/config.js) — the
Supabase project URL and the **publishable** (public) key. These are safe to ship: their
power is bounded by RLS.

Secrets (the Supabase service-role key, the Puzzlr API key) are **never** committed. They
live only in Supabase Edge Function secrets. See
[`supabase/functions/.env.example`](supabase/functions/.env.example) for the list.

### Supabase setup

- **Database schema** — the canonical schema is [`.github/relink_platform_schema.sql`](.github/relink_platform_schema.sql);
  incremental changes are applied as migrations under [`supabase/migrations/`](supabase/migrations/).
- **Auth → URL Configuration** — add your deployment URL(s) to *Redirect URLs* and set the
  *Site URL*, so invite and password-reset links return to the app.
- **Auth → Providers → Email** — disable *"Allow new users to sign up"* so the platform
  stays invite-only at the server level too.
- **Edge Function secrets** — set the Puzzlr key with
  `supabase secrets set PUZZLR_API_KEY=…`. The service-role key is auto-injected by
  Supabase; you do not set it yourself.

## Project structure

```
platform.html              Platform entry point (auth + role-based routing)
index.html                 The puzzle composer (also embedded by the editor view)
server.py                  Simple static dev server
css/styles.css             Composer styles
js/
  app.js, state.js, …      The puzzle composer (rendering, state, persistence)
  platform/
    main.js                Bootstrap: auth state drives which screen shows
    auth.js                Sign-in, password set/reset, invite acceptance
    router.js              Role-based views: queue, review, editing, Team (admin)
    db.js                  The ONLY module that talks to the database
    client.js, config.js   Supabase client + public config
supabase/
  functions/               Edge Functions (publish-puzzle, admin-invite-user, …)
  migrations/              Incremental SQL migrations
save-data/                 Reference puzzle JSON + PDL schema
docs/                      Architecture, domain, conventions
```

## Documentation

- [Architecture](docs/architecture.md) — files, patterns, state management, persistence
- [Domain concepts](docs/domain.md) — puzzle structure, the PDL system, decoys
- [Conventions & pitfalls](docs/conventions.md) — code conventions, common gotchas
- [Puzzlr API](docs/puzzlr-api.md) — the live publish integration

