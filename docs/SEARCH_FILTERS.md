# Message search filters

Open Search and type words, or open **Filters** to narrow the messages without learning search syntax. The filter dialog offers From (including Me), Date (presets or an inclusive custom day range), and Contains (Images, Links, Files and Polls). Choices stay in the dialog until Apply. Escape discards unapplied choices and returns to the search field. Clear filters clears the dialog's choices; Apply commits that change.

Applied choices appear as removable chips, not text inserted into the search field. All / Chats / Rooms independently selects the kind of conversation. A selected person in a room is tied to that room's stable occupant identity when available; an old row without an occupant identity may match the selected nickname, but a conflicting known occupant never does.

Typed operators remain available:

- `from:alice`, `from:"Bob Smith"`, `from:me` and `is:mine` select a sender.
- `has:image`, `has:link`, `has:file` and `has:poll` select content. Files includes images. An attachment's own URL is not a separate link.
- `after:2024-03-01` excludes that day; `before:2024-04-01` excludes that day. `on:2024-03`, `during:2024` and `on:2024-03-01..2024-03-15` include the named month, year or range.
- Numeric dates use the interface language's order; ISO dates are unambiguous. Days run from local midnight to the next local midnight, including daylight-saving transitions.
- Operators inside quoted phrases stay literal. Removing a chip removes its exact operator, not a lookalike elsewhere in the text.

Suggestions appear after an explicit prefix such as `from:` or `has:`, not while typing ordinary words. Arrow keys highlight suggestions; Enter accepts one. Tab keeps normal focus navigation. Escape dismisses suggestions without clearing the query. Incomplete, invalid and inverted date filters must be corrected before searching. Dates alone still need a word or a sender/content condition.

## Local history preparation

The existing time-sorted word-posting store also holds sender and content facets. No extra index table or message-cache schema is required. Searches start with the rarest in-range posting group and intersect the remaining groups; small conversations retain their existing direct path. Prefix expansion normally reads word dictionary keys. A row-only legacy index whose word lists were retired falls back to enumerating posting keys; that lexicon discovery can inspect keys outside the date window. The message-posting pages themselves remain range bounded. Searching does not scan the message cache for content filters.

Version 6 prepares facets in batches of at most 100 documents. A separate facet-build marker also repairs prerelease version-6 rows. Documents, facet postings and the checkpoint commit in the same transaction. Another tab cannot move the checkpoint backwards. An account change cancels the current preparation.

Word and date search remain available while facets are preparing. Sender/content searches wait and rerun when preparation completes. Missing historical attachment/poll metadata is unknown, not proof that content is absent: these rows do not receive guessed content facets, and affected searches warn that older matches may be missing. Authoritative replay can repair them. Failed preparation reports the failure and offers Retry rather than spinning indefinitely.

## Server archive

Search server archive is explicit. A capable server receives words and date bounds; Fluux applies the same sender/content conditions to returned canonical messages. A scoped one-to-one search can instead page the archive without full-text support, including filter-only queries. Each page keeps the same bounds and moves toward older entries. Load more remains available after an empty filtered page when its cursor advanced. Completion, cancellation, missing cursors and stalled cursors stop paging. Detached archive searches do not claim timeline coverage or change gaps.

Local history is not the complete server archive. Filter-only server searches remain limited to supported one-to-one paging; room archive search requires words and server full-text support.

## Verification helpers

`e2e/search-filters.ts` owns the responsive keyboard/dialog journey in the normal browser gate. Run its Chromium and WebKit projects with `--project=search-filters-chromium --project=search-filters-webkit` using `e2e/playwright.e2e.config.ts`.

For the on-demand cost measurement, start an isolated development server, then set `FLUUX_SEARCH_PROOF_APP` to its loopback URL and `FLUUX_SEARCH_PROOF_OUTPUT` to a JSON file outside the working copy. Run `node scripts/search-index-proof.mjs`. It launches and closes its own disposable browser profile. The fixture repeats the existing demo conversation corpus with distinct archive identities, exactly 50,000 messages and fixed minute spacing; it contains no personal history.

The measurement records word-only median/p95 before and after facet preparation, migration duration, facet row count, document reads, posting rows and out-of-span rows for narrow and broad windows. The pre-preparation reading uses the version-5 persisted representation with the candidate search code; it is not an old-code performance baseline. To compare the actual version-5 implementation, place these proof helpers at the same relative paths in a separate version-5 source checkout and run its development server with `FLUUX_SEARCH_PROOF_STAGE=version5`. That stage skips facet preparation and records the old implementation’s timings on the identical corpus. Keep the baseline checkout uncommitted, remove the copied helpers afterward, and retain both source identities with the readings. Investigate repeatable word-only slowdown before accepting the cost.

The helpers in `packages/fluux-sdk/src/utils/fixtures/searchHistory.ts` also generate disposable archive history for service qualification. The historical seeder writes the explicit version-5 schema, not a stripped candidate database. `packages/fluux-sdk/src/utils/fixtures/searchIndexProof.ts` exports these helpers for a development-server proof harness. These browser fixtures do not establish server behavior: qualify actual archive paging separately against a disposable XMPP service, with server full-text enabled and disabled, including an empty filtered first page and unchanged timeline coverage.

New panel copy is authored in English and French. Other locales currently carry English fallback copy pending language review.
