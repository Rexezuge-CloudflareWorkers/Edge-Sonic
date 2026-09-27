/**
 * Subsonic REST API constants.
 *
 * The wire protocol is versioned by the client through `v`, and the server
 * declares the version it implements in every response. `1.16.1` is the target;
 * see `isClientVersionSupported` for the compatibility rule, which is *not* a
 * simple equality check even though the version string looks like one.
 */

/**
REST API version implemented by this server.
*/
const API_VERSION = '1.16.1';

/**
Server software version reported as `serverVersion` in every response.
*/
const SERVER_VERSION = '0.1.0';

/**
`type` attribute — identifies the server implementation to clients.
*/
const SERVER_TYPE = 'edge-sonic';

/**
 * We advertise the OpenSubsonic extension flag.
 *
 * This is not cosmetic: OpenSubsonic-aware clients (Symfonium among them) use
 * `openSubsonic: true` plus `type` to decide whether a non-Subsonic extension
 * namespace may appear in responses. Claiming it while shipping no extensions
 * is still correct — it means "you may send me the standard parameters" — and
 * declining it makes some clients take a legacy code path.
 */
const OPEN_SUBSONIC = true;

/**
XML namespace every `subsonic-response` document is rooted in.
*/
const XML_NAMESPACE = 'https://subsonic.org/restapi';

/**
Path prefix the whole Subsonic surface lives under.
*/
const API_BASE_PATH = '/rest';

/**
`f` parameter values.
*/
type ResponseFormat = 'xml' | 'json' | 'jsonp';

const DEFAULT_FORMAT: ResponseFormat = 'xml';

/**
 * Why protocol failures are HTTP 200 with a `failed` envelope rather than a 4xx.
 *
 * Subsonic clients parse the *body*, and the overwhelming majority of them
 * branch on `status="failed"` rather than on the HTTP status. A 400 with a
 * correct body is reported to the user as "server error", losing the one piece
 * of information they need. So the envelope is authoritative and the status
 * follows it. The single exception is `code=40` (see `httpStatusForErrorCode`).
 */
const PROTOCOL_ERROR_HTTP_STATUS = 200;

/**
 * @param major Client major version
 * @param minor Client minor version
 * @returns true when this server can serve the client
 *
 * The rule from the Subsonic spec is: a server is compatible with a client when
 * the major versions match and the server's minor version is greater than or
 * equal to the client's. The third component is ignored entirely.
 *
 * Implemented explicitly rather than as string comparison, because `1.9.0`
 * compares greater than `1.16.1` as a string and would then reject every client
 * older than 1.10.
 */
function isClientVersionSupported(major: number, minor: number): boolean {
  const [serverMajor, serverMinor] = API_VERSION.split('.').map(Number) as [number, number];
  return major === serverMajor ? minor <= serverMinor : false;
}

export {
  API_VERSION,
  SERVER_VERSION,
  SERVER_TYPE,
  OPEN_SUBSONIC,
  XML_NAMESPACE,
  API_BASE_PATH,
  DEFAULT_FORMAT,
  PROTOCOL_ERROR_HTTP_STATUS,
  isClientVersionSupported,
};
export type { ResponseFormat };
