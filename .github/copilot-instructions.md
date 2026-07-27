# Copilot instructions

   This repo is the Relink freelance submission platform (a POC on Supabase).
   Read @../PROJECT_BRIEF.md for the full spec — the workflow, the four roles,
   the state machine, and the settled decisions. Read @../relink_platform_schema.sql
   for the data model. Do NOT reverse any decision listed in the brief's
   "Settled decisions" section without flagging it.

   Stack: vanilla HTML/JS/ES modules (no framework), Supabase for auth/DB/Edge
   Functions. Keep the data-access layer thin and in one place so the database
   can be swapped later. British English.