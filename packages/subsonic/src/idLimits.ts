/**
 * How many ids one request may name.
 *
 * ### Why the protocol's own list needs a bound
 *
 * `SubsonicParams.ids()` comma-splits a repeated parameter, and `id` is in `MULTI_VALUE_PARAMS`
 * **because clients repeat it** — `scrobble?id=a&id=b&id=c`, `star?id=…`, `savePlayQueue?id=…`. So
 * the length of that list is whatever the client sent, and it arrives in a form body as well as a
 * query string, which means a URL length does not bound it either.
 *
 * Every endpoint that walks it then costs **statements per id**: `findBySongId` (1–2),
 * `requireForUser` (1), and for `scrobble` a `recordPlay` (1) on top. That is 2–4 per id against a
 * platform ceiling, and nothing on the endpoint side bounded the loop — so a request naming a few
 * hundred ids spent past the ceiling and the **runtime terminated the invocation**, with no Subsonic
 * envelope and nothing in any log. Not a `413`, not a `code=0`: the client saw a dropped connection.
 *
 * Every DAO in `backend-data` refuses rather than truncates (`BaseDAO.requireSubrequests`), and
 * `UserStateDAO.savePlayQueue` passes `requireComplete` — a half-saved queue is a *shorter* queue,
 * which is a wrong answer rather than an unfinished one. The endpoint side had no equivalent, so the
 * refusal the data layer went to the trouble of making never got the chance to happen.
 *
 * ### Why this is a constant and not configuration
 *
 * Because it is not a policy an operator has an opinion about. `MAX_PAGE_SIZE` is policy. This is
 * "how many things will one HTTP request talk about before the server declines" — and declining is
 * the point, so raising it does not buy throughput, it buys a longer way to reach the ceiling. It
 * sits **above** the page ceiling rather than beside it, so the number of ids one request may name is
 * never smaller than the number of songs one page may return; a client cannot page a list and be
 * refused for asking.
 */
const MAX_IDS_PER_REQUEST = 500;

export { MAX_IDS_PER_REQUEST };
