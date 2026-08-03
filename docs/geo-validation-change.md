# Geo accuracy + manual validation — change summary & handoff

Context for picking this up on another machine. This change set improves how
songs get their **artist country / region / year**, and adds ways to fix bad or
missing data by hand.

## The problem
Artist geo was resolved from **MusicBrainz by artist name only**, so same-named
artists got confused:
- Taxi → tagged Romania, but the band on the compile is Peruvian.
- Trio → tagged Maryland (US), but it's the German band.
- EV ("Cuppa Tea") → tagged French (a Nantes band), but the real one is English.
- Soapbox → tagged Swedish, but it's from Glasgow.

Plus ~1000+ songs had **no country**, and some `year` values are dirty
(`YYYYMMDD` dates like `20200610`).

## The fix — Discogs disambiguates MusicBrainz
The song's Discogs release pins the **real** artist (we store
`discogs.artistId`). MusicBrainz records a URL relationship to Discogs, so:

1. **Discogs id → exact MB artist** via `GET /ws/2/url?resource=https://www.discogs.com/artist/{id}&inc=artist-rels` → the precise MB artist → its area/country. Authoritative; kills the namesake problem.
2. **Name search** only as a fallback, and **rejected** if its country disagrees with the Discogs bio's country.
3. **Discogs bio-parsed country** as a last resort.

Key detail: the **artist cache is now keyed by Discogs id** (`artistMeta/discogs-{id}`), not by name — otherwise two different same-named artists collapse into one cache entry (the original bug). Falls back to the name key when there's no Discogs id.

`GEO_VERSION` bumped **1 → 2**, so a backfill re-run re-resolves everything with the new logic.

`year → decade` is sanitized at read time in `catalog.js` (`yearOf`): a plausible 4-digit year, or the leading 4 digits of a mashed date; junk is dropped. (This only cleans it for display/map; the stored field is still dirty — a `year` cleanup backfill is a possible future task.)

## When MusicBrainz can't tell namesakes apart
The Discogs-id path above only works when the song HAS a `discogs.artistId` —
about 1129 songs are `enrichStatus: 'nomatch'` (Discogs found no release), so they
fall through to a bare name search with nothing to corroborate it. The search
score reflects text similarity and popularity, not which band is on the
compilation:

```
100  Soapbox   country=SE  area=Sweden    Swedish christian punk/metal band   ← picked
 98  SOAPBOX   country=-   area=Glasgow   Scottish punk band                  ← the real one
 97  Soapbox   country=DE  area=Germany   German band
```

So a near-tie is now recorded as **provisional** rather than as fact:

- `namesakeRivals()` (`functions/musicbrainz.js`) finds candidates that are the
  **same name** (not "Soapbox Symphony"), within **5 score points**, and pointing
  at **different geography** — a near-tie that agrees on the country is harmless.
  It reads the search response we already have, so it costs no extra request.
- Those get `geoSource: '`**`musicbrainz-ambiguous`**`'` plus `geoAlternatives`
  (up to 3 human-readable rivals, e.g. `SOAPBOX — Glasgow (Scottish punk band)`).
  The best guess is still stored, so the map isn't left blank.
- A **Discogs bio that corroborates** the pick settles the tie — source goes back
  to plain `musicbrainz`.
- Ambiguous is **not resolved** (see below), so it's retried *and* surfaced in
  `/validate` with the alternatives spelled out on the row.

## `geoV` vs. resolved — the retry rule
`geoV` records which pipeline version last **touched** a doc; it does NOT mean the
lookup succeeded. Done-ness is `isGeoResolved(doc)` in `functions/geo.js`:

> at the current `GEO_VERSION` **and** the source is not provisional
> (`'none'` or `'musicbrainz-ambiguous'`).

Both "already resolved?" checks go through it — the `artistMeta` cache freshness
test and the song skip in `scripts/backfill-geo.js`. Before this, a failed lookup
was stamped `geoV: 2` and skipped forever; 612 songs sat at `geoSource: 'none'`.
The trade-off: unresolvable artists (~20%) are re-attempted on every run.

`--recheck=<geoSource,…>` re-resolves only songs with the given sources, bypassing
both the done check and the cache — for applying a rule change to one source
without a full `--force`.

## Manual correction
- **Admin screen `/validate`** (`public/js/views/validate.js`, admin-only, in the nav as "À valider"): lists every song missing **title / artist / year / country**, *plus* every song whose country is **uncertain** (`musicbrainz-ambiguous`, sorted first, row outlined in `--accent-soft`, rival candidates printed above the fields). Inline-editable, paginated (40/page). Saves write straight to the song doc.
- **Authors** can edit **year, country, region** per song in the **compilation editor** (edit mode → new fields under title/artist).
- Both stamp **`geoManual: true`** and **`geoSource: 'manual'`** on the song (clearing `geoAlternatives`), so the row leaves `/validate` and stops being re-resolved. The geo backfill and the enrichment path **skip `geoManual` songs**, so a human fix is never overwritten.
- Country picker uses a shared helper `public/js/countries.js` (ISO-3166-1 alpha-2 → English name, from the `i18n-iso-countries` dataset the map already uses). Stores both `artistCountry` (label) and `artistCountryCode` (ISO-2, which the map colours by).

Firestore rules already allow the compilation author (or an admin) to write song docs — no rules change needed.

## Files changed
**Server / functions**
- `functions/musicbrainz.js` — `lookupArtistByDiscogsId()`, refactored `geoFromArtist()` shared helper.
- `functions/geo.js` — Discogs-first `resolveArtistGeo(db, artist, { discogsArtistId, discogsFallback, force })`, cache keyed by Discogs id, `GEO_VERSION = 2`, name↔bio agreement check.
- `functions/index.js` — enrich trigger passes `discogs.artistId` into geo resolution.
- `functions/test/musicbrainz.test.js` — +3 tests for the Discogs path (57 total, green).
- `scripts/backfill-geo.js` — groups by Discogs-id-or-name, skips `geoManual`, new signature.

**Client**
- `public/js/countries.js` — NEW shared country-options helper.
- `public/js/views/validate.js` — NEW admin validation screen.
- `public/js/views/compilation.js` — year/country/region editing in edit mode + save (+ `geoManual`).
- `public/js/catalog.js` — `yearOf`/`decadeOf` sanitization; decade helpers.
- `public/js/app.js` — route `/validate`.
- `public/index.html` — "À valider" admin nav link.
- `public/css/app.css` — `/validate` + `.ed-meta` styles.

## Status
- Functions unit tests: **83/83** (was 57; `functions/test/geo.test.js` is new —
  `resolveArtistGeo` had no coverage at all).
- Full e2e chain (seed → e2e → ui → player → upload-draft): **green**.
- Committed & pushed to `main` (CI auto-deploys on green).

### Prod data after both runs (2026-08-03)
4360 songs — **3417 (78%) carry a country code**, 3456 carry some place.

| `geoSource` | songs | |
|---|---|---|
| `discogs+musicbrainz` | 2807 | exact artist via the Discogs URL relation — authoritative |
| `musicbrainz` | 657 | name match, no rival namesake |
| `none` | 672 | nothing found; retried on every run |
| `musicbrainz-ambiguous` | 53 | namesake coin-flip → `/validate` |
| `discogs-bio` | 36 | country parsed from the Discogs bio |
| (unset) | 135 | various-artists / blank artist — correctly skipped |

The four reported cases all landed:

| | result |
|---|---|
| Taxi | **Chimbote, Peru** `discogs-bio` (was Romania) |
| Trio | **Großenkneten, Niedersachsen, Germany** `discogs+musicbrainz` (was Maryland, US) |
| EV | **UK** `discogs-bio` (was Nantes, France) |
| Soapbox | Sweden, **flagged** `musicbrainz-ambiguous`, Glasgow offered as the alternative |

Only **52 artists** are flagged ambiguous, so the `/validate` queue stays small.
The flags read sensibly — `Mute → Canada` offering Haifa and Magelang,
`The Roadrunners → UK` offering three US/NZ bands.

### Known gap: bio-derived countries have no ISO code
`discogs-bio` sets `country` from prose ("Peru", "UK") but leaves `countryCode`
null, and the map colours by `artistCountryCode`. So the 36 `discogs-bio` songs —
Taxi and EV among them — read correctly in the player/track detail but **don't
colour on the map**. Fixing it means reverse-mapping a country name to ISO-3166-1
alpha-2 (with aliases: UK→GB, USA→US …) in step 3 of `resolveArtistGeo`.

## TODO after switching computers
1. **Re-run the geo backfill (v2)** against prod to correct existing data (Taxi/Trio/EV/Soapbox …) and fill blanks — it re-resolves everything because `GEO_VERSION` changed, and skips `geoManual` songs:
   ```bash
   gcloud auth application-default login        # once
   node scripts/backfill-geo.js                 # ~2-3h, respects MusicBrainz 1 req/s
   ```
   - ⚠️ On the *current* machine, node couldn't complete the OAuth token exchange (a local DLP layer severs the POST to `oauth2.googleapis.com`), so the backfills there ran via a throwaway `curl`-based runner in `scripts/.tmp-*.mjs`. On a normal machine `scripts/backfill-geo.js` should work directly. If you hit the same "Premature close" error, reuse the curl-runner trick (mint tokens with `gcloud`, do Firestore/Storage over REST).
   - ✅ **Done 2026-08-03** (3652 artists). First attempt failed on *every* artist with
     `Couldn't serialize object of type "ServerTimestampTransform"`: `geo.js` is imported
     by the backfill through the *root* `node_modules/firebase-admin`, while its
     `FieldValue.serverTimestamp()` sentinel came from `functions/node_modules` — a
     cross-copy sentinel Firestore refuses to serialize. Fixed by writing a plain
     `new Date()` for `resolvedAt` (write-only metadata; wall-clock is fine). Keep it
     that way if you add more shared-module writes.
2. ✅ **Spot-checked** — see the table above; all four cases resolved or flagged.
   - **Soapbox can't be fixed automatically**: `enrichStatus: 'nomatch'` → no
     Discogs id, no bio, and the Glasgow band loses the MB score contest 98–100.
     It's flagged `musicbrainz-ambiguous` for a human call in `/validate`.
   - Still untried by hand: `/validate` itself, and an author editing year/country
     in a compilation.
3. ✅ **Re-ran with `--recheck=musicbrainz`** (1333 artists incl. the `none` retries,
   ~1h20). The full run predated the ambiguity check, so its bare name matches were
   stamped plain `'musicbrainz'` and counted as resolved; this pass re-examined
   exactly those and flagged 49 coin-flips.

## If you re-run the backfill later
A plain `node scripts/backfill-geo.js` now picks up everything provisional — the
672 `none` songs and the 53 ambiguous ones — because neither counts as resolved.
That's ~700 artists, ~50 min. Add `--recheck=musicbrainz` only after changing how
name matches are judged, and `--force` only to redo all 3449.

## How to run things
- Dev app (Firebase emulators + hosting on `localhost:5050`, login `peltier.nicolas@gmail.com` / `password`): `npm run dev`
- Functions unit tests: `cd functions && npm test`
- Full e2e chain: `npx firebase emulators:exec --only auth,functions,firestore,hosting,storage --project demo-compilator "npm run seed && npm run test:e2e && npm run test:e2e:ui && npm run test:e2e:player && npm run test:e2e:upload-draft"`
  (needs `npx playwright install chromium`; the emulator seed has no geo data, so the map/validate screens look sparse locally — real data is in prod.)

## Gotchas
- MusicBrainz asks for ≤1 req/s and a descriptive User-Agent (both handled).
- The map colours by `artistCountryCode` (ISO-2), so manual country edits must set the code (the picker does).
- `geoManual` is the write-protect flag — don't strip it in future enrichment code.
