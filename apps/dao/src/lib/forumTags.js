// src/lib/forumTags.js
//
// The forum's Nostr tags, in a module with NO imports of its own.
//
// They used to live in hooks/useForum.js, and lib/forumModeration.js (which
// builds MOD_ACTION_TAG from FORUM_TAG at module load) imported them from
// there — while useForum.js itself imports forumModeration.js. That circular
// import made the app crash with "Cannot access 'FORUM_TAG' before
// initialization" (or silently produce the tag "undefined-mod-action")
// depending on which of the two modules the bundler happened to load first.
// Anything that only needs a tag must import it from HERE, never from
// hooks/useForum. (useForum.js still re-exports both for existing callers.)

export const FORUM_TAG = "hrpdao-forum";
export const FORUM_REPORT_TAG = `${FORUM_TAG}-report`;
