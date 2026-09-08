const cloudKitOrigin = "https://api.apple-cloudkit.com";
const retryableStatuses = new Set([429, 500, 502, 503, 504]);

export class CloudKitRequestError extends Error {
  constructor(kind, status = null) {
    super(status === null ? `CloudKit ${kind}` : `CloudKit ${kind} (${status})`);
    this.name = "CloudKitRequestError";
    this.kind = kind;
    this.status = status;
  }
}

export function cloudKitDatabasePath(configuration, endpoint = "records/query") {
  const container = encodeURIComponent(configuration.containerIdentifier);
  const environment = configuration.environment;
  if (!container || !new Set(["development", "production"]).has(environment)) {
    throw new CloudKitRequestError("configuration");
  }
  return `/database/1/${container}/${environment}/public/${endpoint}`;
}

export function makeRecordsQueryBody({ fallbackStartMilliseconds, asOfMilliseconds, continuationMarker, resultsLimit = 200 }) {
  if (!Number.isSafeInteger(fallbackStartMilliseconds)
      || !Number.isSafeInteger(asOfMilliseconds)
      || fallbackStartMilliseconds >= asOfMilliseconds
      || !Number.isInteger(resultsLimit)
      || resultsLimit < 1
      || resultsLimit > 200) {
    throw new CloudKitRequestError("query configuration");
  }
  return {
    query: {
      recordType: "JottoGameState",
      filterBy: [
        {
          systemFieldName: "modifiedTimestamp",
          comparator: "GREATER_THAN_OR_EQUALS",
          fieldValue: { value: fallbackStartMilliseconds },
        },
        {
          systemFieldName: "modifiedTimestamp",
          comparator: "LESS_THAN",
          fieldValue: { value: asOfMilliseconds },
        },
      ],
      sortBy: [{ systemFieldName: "modifiedTimestamp", ascending: true }],
    },
    desiredKeys: ["stateData"],
    resultsLimit,
    ...(continuationMarker === undefined ? {} : { continuationMarker }),
  };
}

export function signedMessage({ date, bodyDigestBase64, path }) {
  return `${date}:${bodyDigestBase64}:${path}`;
}

export async function requestBodyDigestBase64(bodyBytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bodyBytes));
  return bytesToBase64(digest);
}

export async function importP256PrivateKey(pkcs8Base64) {
  let bytes;
  try {
    bytes = base64ToBytes(pkcs8Base64);
  } catch {
    throw new CloudKitRequestError("private key encoding");
  }
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      bytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new CloudKitRequestError("private key import");
  }
}

export function ecdsaSignatureToDER(signature) {
  const bytes = signature instanceof Uint8Array ? signature : new Uint8Array(signature);
  if (bytes.length > 0 && bytes[0] === 0x30) return bytes;
  if (bytes.length !== 64) throw new CloudKitRequestError("signature encoding");
  const r = canonicalDERInteger(bytes.slice(0, 32));
  const s = canonicalDERInteger(bytes.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

export async function makeCloudKitHeaders({ keyID, privateKey, bodyBytes, path, date }) {
  if (!keyID || !privateKey || !date || !path) throw new CloudKitRequestError("signing configuration");
  const bodyDigestBase64 = await requestBodyDigestBase64(bodyBytes);
  const message = new TextEncoder().encode(signedMessage({ date, bodyDigestBase64, path }));
  const rawSignature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    message,
  );
  return {
    "X-Apple-CloudKit-Request-KeyID": keyID,
    "X-Apple-CloudKit-Request-ISO8601Date": date,
    "X-Apple-CloudKit-Request-SignatureV1": bytesToBase64(ecdsaSignatureToDER(rawSignature)),
  };
}

export class CloudKitCommunityClient {
  constructor({
    containerIdentifier,
    environment,
    keyID,
    privateKeyPKCS8Base64,
    fetchImplementation = fetch,
    sleep = defaultSleep,
    now = () => new Date(),
    maximumAttempts = 3,
  }) {
    this.configuration = { containerIdentifier, environment };
    this.keyID = keyID;
    this.privateKeyPKCS8Base64 = privateKeyPKCS8Base64;
    this.fetchImplementation = fetchImplementation;
    this.sleep = sleep;
    this.now = now;
    this.maximumAttempts = maximumAttempts;
    this.privateKeyPromise = null;
  }

  async queryGameStates({ fallbackStartMilliseconds, asOfMilliseconds }) {
    const records = [];
    const consumedMarkers = new Set();
    let continuationMarker;
    let pageCount = 0;
    do {
      if (continuationMarker !== undefined) {
        if (consumedMarkers.has(continuationMarker)) throw new CloudKitRequestError("repeated continuation marker");
        consumedMarkers.add(continuationMarker);
      }
      const page = await this.queryPage({ fallbackStartMilliseconds, asOfMilliseconds, continuationMarker });
      pageCount += 1;
      if (!Array.isArray(page.records)) throw new CloudKitRequestError("malformed response");
      if (page.records.some((record) => record?.serverErrorCode)) {
        throw new CloudKitRequestError("record error");
      }
      records.push(...page.records);
      continuationMarker = page.continuationMarker;
      if (continuationMarker !== undefined && typeof continuationMarker !== "string") {
        throw new CloudKitRequestError("malformed continuation marker");
      }
    } while (continuationMarker !== undefined);
    return { records, pageCount };
  }

  async queryPage(query) {
    const bodyBytes = new TextEncoder().encode(JSON.stringify(makeRecordsQueryBody(query)));
    const path = cloudKitDatabasePath(this.configuration);
    const key = await this.privateKey();
    let lastStatus = null;
    for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
      const date = this.now().toISOString().replace(/\.\d{3}Z$/, "Z");
      const headers = await makeCloudKitHeaders({ keyID: this.keyID, privateKey: key, bodyBytes, path, date });
      let response;
      try {
        response = await this.fetchImplementation(`${cloudKitOrigin}${path}`, {
          method: "POST",
          headers: { "content-type": "text/plain", ...headers },
          body: bodyBytes,
        });
      } catch {
        if (attempt === this.maximumAttempts) throw new CloudKitRequestError("network");
        await this.sleep(250 * (2 ** (attempt - 1)));
        continue;
      }
      lastStatus = response.status;
      if (response.ok) {
        try {
          return await response.json();
        } catch {
          throw new CloudKitRequestError("malformed response", response.status);
        }
      }
      if (!retryableStatuses.has(response.status) || attempt === this.maximumAttempts) {
        throw new CloudKitRequestError("request failed", response.status);
      }
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfter = retryAfterHeader === null ? null : Number(retryAfterHeader);
      const delay = retryAfter !== null && Number.isFinite(retryAfter) && retryAfter >= 0
        ? Math.min(5_000, retryAfter * 1_000)
        : 250 * (2 ** (attempt - 1));
      await this.sleep(delay);
    }
    throw new CloudKitRequestError("request failed", lastStatus);
  }

  privateKey() {
    this.privateKeyPromise ??= importP256PrivateKey(this.privateKeyPKCS8Base64);
    return this.privateKeyPromise;
  }
}

function canonicalDERInteger(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const magnitude = [...bytes.slice(start)];
  if ((magnitude[0] & 0x80) !== 0) magnitude.unshift(0);
  return [0x02, magnitude.length, ...magnitude];
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
