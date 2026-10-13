#!/usr/bin/env python3
"""Split `@edge-sonic/shared` imports into the kit's pure utilities and the local bundle.

`@edge-sonic/shared` was a barrel over two very different things: a copy of the
kit's pure utilities (`SubrequestMeter`, `UUIDUtil`, …) and this repo's own
backend string bundle (`BUNDLES`, `getBackendStrings`, …). Only the second
survives convergence, so every import has to be split rather than repointed.

Run from the repository root: python3 scripts/split-shared-imports.py
"""
import pathlib
import re
import sys

# Symbols the kit ships under the same name. Everything exported by
# `@rexezuge/shared` that this repo used.
KIT_SYMBOLS = {
    # SubrequestMeter
    'SubrequestCounter', 'UNMETERED_SUBREQUESTS', 'SUBREQUEST_KINDS', 'subrequestSpend',
    'NO_SUBREQUESTS_SPENT', 'SubrequestMeter', 'SubrequestKind', 'SubrequestSpend',
    # UUIDUtil
    'UUIDUtil',
    # Identity
    'isValidEmailFormat', 'MAX_EMAIL_LENGTH', 'EMAIL_FORMAT_RE',
    # ErrorSanitizationUtil
    'ErrorSanitizationUtil',
    # SsrfHosts / RemoteUrlPolicy
    'MAX_URL_LENGTH', 'MAX_REMOTE_URL_LENGTH', 'PRIVATE_IPV4_RANGES', 'stripBrackets',
    'stripTrailingDot', 'isEncodedNumericHost', 'isBlockedIpv6Host', 'isLoopbackHost',
    'isLocalhostName', 'isPrivateOrInternalHost', 'normalizeRemoteUrl',
    'resolveRedirectUrl', 'parseAllowedHosts', 'RemoteUrlRejectedError', 'MAX_REDIRECTS',
    'BLOCKED_HOST_SUFFIXES', 'BLOCKED_HOSTNAMES',
}

# The local bundle's own surface.
LOCAL_SYMBOLS = {'getBackendStrings', 'BUNDLES', 'DEFAULT_LOCALE', 'BackendStrings', 'Locale'}

IMPORT_RE = re.compile(
    r"import(\s+type)?\s*\{(?P<body>[^}]*)\}\s*from\s*'@edge-sonic/shared';",
    re.DOTALL,
)


def split_symbols(body: str):
    """Return (kit, local) symbol-name lists from a named-import body."""
    kit, local = [], []
    for raw in body.split(','):
        name = raw.strip()
        if not name:
            continue
        bare = name.replace('type ', '').strip()
        # `X as Y` — classify on the source name.
        source = bare.split(' as ')[0].strip()
        (kit if source in KIT_SYMBOLS else local).append(name)
    return kit, local


def render(kind: str, names, specifier: str) -> str:
    if not names:
        return ''
    prefix = 'import type' if kind == 'type' else 'import'
    one = ', '.join(names)
    if len(f"{prefix} {{ {one} }} from '{specifier}';") <= 118:
        return f"{prefix} {{ {one} }} from '{specifier}';"
    body = ',\n'.join(f'  {n},' for n in names)
    return f"{prefix} {{\n{body}\n}} from '{specifier}';"


def process(path: pathlib.Path) -> bool:
    text = path.read_text()
    matches = list(IMPORT_RE.finditer(text))
    if not matches:
        return False

    out = []
    cursor = 0
    changed = False
    for match in matches:
        kind = 'type' if match.group(1) else 'value'
        kit, local = split_symbols(match.group('body'))
        # Anything unrecognised stays local rather than being guessed onto the kit.
        if not kit and not local:
            continue
        replacement = '\n'.join(
            part for part in [render(kind, kit, '@rexezuge/shared'), render(kind, local, '@edge-sonic/shared')] if part
        )
        out.append(text[cursor:match.start()])
        out.append(replacement)
        cursor = match.end()
        changed = True
    out.append(text[cursor:])

    if changed:
        path.write_text(''.join(out))
    return changed


def main() -> int:
    roots = [pathlib.Path(p) for p in ('apps', 'packages', 'test')]
    touched = 0
    for root in roots:
        for path in root.rglob('*.ts'):
            if 'node_modules' in path.parts or 'dist' in path.parts:
                continue
            if process(path):
                touched += 1
    print(f'rewrote {touched} file(s)')
    return 0


if __name__ == '__main__':
    sys.exit(main())