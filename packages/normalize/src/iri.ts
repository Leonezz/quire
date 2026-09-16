import { isIP } from "node:net";

function isUcsChar(codePoint: number) {
  return (
    (codePoint >= 0x00a0 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfdcf) ||
    (codePoint >= 0xfdf0 && codePoint <= 0xffef) ||
    (codePoint >= 0x10000 && codePoint <= 0x1fffd) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fffd) ||
    (codePoint >= 0x30000 && codePoint <= 0x3fffd) ||
    (codePoint >= 0x40000 && codePoint <= 0x4fffd) ||
    (codePoint >= 0x50000 && codePoint <= 0x5fffd) ||
    (codePoint >= 0x60000 && codePoint <= 0x6fffd) ||
    (codePoint >= 0x70000 && codePoint <= 0x7fffd) ||
    (codePoint >= 0x80000 && codePoint <= 0x8fffd) ||
    (codePoint >= 0x90000 && codePoint <= 0x9fffd) ||
    (codePoint >= 0xa0000 && codePoint <= 0xafffd) ||
    (codePoint >= 0xb0000 && codePoint <= 0xbfffd) ||
    (codePoint >= 0xc0000 && codePoint <= 0xcfffd) ||
    (codePoint >= 0xd0000 && codePoint <= 0xdfffd) ||
    (codePoint >= 0xe1000 && codePoint <= 0xefffd)
  );
}

function isIprivate(codePoint: number) {
  return (
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd)
  );
}

const IUNRESERVED_OR_SUBDELIM = /^[A-Za-z0-9\-._~!$&'()*+,;=]$/u;

function componentIsValid(value: string, extraAscii: ReadonlySet<string>, allowPrivate: boolean) {
  for (let index = 0; index < value.length;) {
    const character = value[index];
    if (character === "%") {
      if (!/^[0-9A-Fa-f]{2}$/u.test(value.slice(index + 1, index + 3))) return false;
      index += 3;
      continue;
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) return false;
    const codePointCharacter = String.fromCodePoint(codePoint);
    if (codePoint <= 0x7f) {
      if (!IUNRESERVED_OR_SUBDELIM.test(codePointCharacter) && !extraAscii.has(codePointCharacter)) return false;
    } else if (!isUcsChar(codePoint) && !(allowPrivate && isIprivate(codePoint))) {
      return false;
    }
    index += codePointCharacter.length;
  }
  return true;
}

const USERINFO_EXTRA = new Set([":"]);
const PCHAR_EXTRA = new Set([":", "@"]);
const QUERY_OR_FRAGMENT_EXTRA = new Set([":", "@", "/", "?"]);
const PATH_EXTRA = new Set([...PCHAR_EXTRA, "/"]);

function authorityIsValid(authority: string) {
  const at = authority.lastIndexOf("@");
  if (at >= 0 && !componentIsValid(authority.slice(0, at), USERINFO_EXTRA, false)) return false;
  const hostPort = authority.slice(at + 1);
  if (hostPort.startsWith("[")) {
    const closing = hostPort.indexOf("]");
    if (closing < 0 || hostPort.indexOf("[", 1) >= 0 || hostPort.indexOf("]", closing + 1) >= 0) return false;
    const literal = hostPort.slice(1, closing);
    const remainder = hostPort.slice(closing + 1);
    if (remainder !== "" && !/^:\d*$/u.test(remainder)) return false;
    const ipvFuture = /^[vV][0-9A-Fa-f]+\.[A-Za-z0-9\-._~!$&'()*+,;=:]+$/u.test(literal);
    return isIP(literal) === 6 || ipvFuture;
  }
  if (hostPort.includes("[") || hostPort.includes("]")) return false;
  const colon = hostPort.lastIndexOf(":");
  if (colon >= 0 && hostPort.indexOf(":") !== colon) return false;
  const host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
  const port = colon >= 0 ? hostPort.slice(colon + 1) : undefined;
  return componentIsValid(host, new Set(), false) && (port === undefined || /^\d*$/u.test(port));
}

function hierarchyIsValid(value: string, hasScheme: boolean) {
  if (value.startsWith("//")) {
    const pathStart = value.indexOf("/", 2);
    const authority = pathStart < 0 ? value.slice(2) : value.slice(2, pathStart);
    const path = pathStart < 0 ? "" : value.slice(pathStart);
    return authorityIsValid(authority) && componentIsValid(path, PATH_EXTRA, false);
  }
  if (!componentIsValid(value, PATH_EXTRA, false)) return false;
  if (!hasScheme && !value.startsWith("/")) {
    const firstSegment = value.split("/", 1)[0];
    if (firstSegment.includes(":")) return false;
  }
  return true;
}

export function hasValidIriReferenceLexicalForm(value: string) {
  const fragmentDelimiter = value.indexOf("#");
  if (fragmentDelimiter >= 0 && value.indexOf("#", fragmentDelimiter + 1) >= 0) return false;
  const beforeFragment = fragmentDelimiter < 0 ? value : value.slice(0, fragmentDelimiter);
  const fragment = fragmentDelimiter < 0 ? undefined : value.slice(fragmentDelimiter + 1);
  const queryDelimiter = beforeFragment.indexOf("?");
  const beforeQuery = queryDelimiter < 0 ? beforeFragment : beforeFragment.slice(0, queryDelimiter);
  const query = queryDelimiter < 0 ? undefined : beforeFragment.slice(queryDelimiter + 1);
  const scheme = /^([A-Za-z][A-Za-z\d+.-]*):(.*)$/su.exec(beforeQuery);
  const hierarchy = scheme ? scheme[2] : beforeQuery;
  return (
    hierarchyIsValid(hierarchy, Boolean(scheme)) &&
    (query === undefined || componentIsValid(query, QUERY_OR_FRAGMENT_EXTRA, true)) &&
    (fragment === undefined || componentIsValid(fragment, QUERY_OR_FRAGMENT_EXTRA, false))
  );
}
