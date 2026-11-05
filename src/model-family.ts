export type DsmmModelFamily = "gpt" | "codex" | "claude" | "gemini" | "glm" | "kimi" | "deepseek" | "unknown";

type ModelIdentifier = Exclude<DsmmModelFamily, "unknown"> | "swe-2";
type ModelSeries = "opus" | "sonnet" | "haiku" | "sol" | "terra" | "astra" | "luna";

interface ModelNameRecognition {
  identifier: ModelIdentifier;
  family: DsmmModelFamily;
  series: ModelSeries | undefined;
  version: readonly [number, number, number] | undefined;
  versionParts: number | undefined;
  opus5: boolean;
  gemini4: boolean;
}

function seriesFamily(series: ModelSeries): "gpt" | "claude" {
  return series === "opus" || series === "sonnet" || series === "haiku" ? "claude" : "gpt";
}

function skipSeparators(name: string, start: number): number {
  return start + (/^[-_.\s/]+/u.exec(name.slice(start))?.[0].length ?? 0);
}

function seriesAt(name: string, start: number, family?: ModelIdentifier): ModelSeries | undefined {
  const series = /^(opus|sonnet|haiku|sol|terra|astra|luna)(?=\d|[^a-z0-9]|$)/u.exec(name.slice(start))?.[1] as ModelSeries | undefined;
  return series !== undefined && (family === undefined || seriesFamily(series) === family) ? series : undefined;
}

function suffixNumber(token: string): boolean {
  return /^(?:(?:19|20)\d{6}|\d+[km])$/u.test(token);
}

function versionStartsAt(name: string, start: number): boolean {
  const token = /^[a-z0-9]+/u.exec(name.slice(start))?.[0] ?? "";
  return /^\d/u.test(token) && !suffixNumber(token);
}

function readVersion(name: string, start: number, family?: ModelIdentifier) {
  const parts: number[] = [];
  let end = start;
  let cursor = start;
  let series: ModelSeries | undefined;
  let complete = true;
  while (versionStartsAt(name, cursor)) {
    const digits = /^\d+/u.exec(name.slice(cursor))![0];
    const numberEnd = cursor + digits.length;
    parts.push(Number(digits));
    end = numberEnd;
    if (/^[a-z]/u.test(name.slice(numberEnd))) {
      series = seriesAt(name, numberEnd, family);
      if (series === undefined || versionStartsAt(name, skipSeparators(name, numberEnd + series.length))) {
        complete = false;
        series = undefined;
        end += /^[a-z0-9]+/u.exec(name.slice(numberEnd))![0].length;
      } else {
        end += series.length;
      }
      break;
    }
    cursor = skipSeparators(name, end);
    if (versionStartsAt(name, cursor)) continue;
    const trailingSeries = seriesAt(name, cursor, family);
    if (trailingSeries !== undefined && !versionStartsAt(name, skipSeparators(name, cursor + trailingSeries.length))) {
      series = trailingSeries;
      end = cursor + trailingSeries.length;
    }
    break;
  }
  const version: readonly [number, number, number] | undefined = complete && parts.length > 0 && parts.length <= 3 && parts.every(Number.isSafeInteger)
    ? [parts[0], parts[1] ?? 0, parts[2] ?? 0] : undefined;
  return { version, versionParts: version === undefined ? undefined : parts.length, series, end };
}

function identifierFor(marker: string): ModelIdentifier {
  if (marker.startsWith("k2")) return "kimi";
  if (marker.startsWith("swe")) return "swe-2";
  if (marker === "chatgpt") return "gpt";
  if (marker === "fable") return "claude";
  return marker as Exclude<ModelIdentifier, "swe-2">;
}

/** Model fields are complete names here; route owners separate provider metadata. */
export function recognizeModelName(model: string): ModelNameRecognition | undefined {
  const name = model.trim().toLowerCase();
  const markers = name.matchAll(/(?<![a-z0-9])(?:(?:chatgpt|gpt|codex|claude|fable|gemini|glm|deepseek|kimi|opus|sonnet|haiku|sol|terra|astra|luna)(?=\d|[^a-z0-9]|$)|(?:k2[-_.\s/]*p[5-8]|swe[-_.\s/]+2)(?![a-z0-9])|\d+)/gu);
  let first: ModelNameRecognition | undefined;
  let consumedEnd = 0;
  for (const marker of markers) {
    if (marker.index < consumedEnd) continue;
    let identifier: ModelIdentifier;
    let parsed: ReturnType<typeof readVersion>;
    let wildcardGemini4 = false;
    let series = seriesAt(name, marker.index);
    if (/^\d/u.test(marker[0])) {
      // Numeric spans include malformed segments; never restart at their later digits.
      if (/(?:\d|(?<![a-z0-9])\d[a-z0-9]*)[-_.\s/]+$/u.test(name.slice(consumedEnd, marker.index))) continue;
      parsed = readVersion(name, marker.index);
      if (parsed.version === undefined || parsed.series === undefined) continue;
      series = parsed.series;
      identifier = seriesFamily(series);
    } else if (series !== undefined) {
      const start = skipSeparators(name, marker.index + marker[0].length);
      if (!versionStartsAt(name, start)) continue;
      identifier = seriesFamily(series);
      parsed = readVersion(name, start, identifier);
    } else {
      identifier = identifierFor(marker[0]);
      const markerEnd = marker.index + marker[0].length;
      let start = skipSeparators(name, markerEnd);
      series = start > markerEnd ? seriesAt(name, start, identifier) : undefined;
      if (series !== undefined) start = skipSeparators(name, start + series.length);
      if (identifier === "gemini" && /^4\.x/u.test(name.slice(start))) {
        const end = start + 3;
        wildcardGemini4 = /^(?:$|[-_.\s/@:])/u.test(name.slice(end)) && !versionStartsAt(name, skipSeparators(name, end));
        parsed = { version: undefined, versionParts: undefined, series: undefined, end };
      } else {
        const compactGemini4 = identifier === "gemini" && /^4(?=[^a-z0-9]|$)/u.test(name.slice(start));
        parsed = start === markerEnd && identifier !== "gpt" && !compactGemini4
          ? { version: undefined, versionParts: undefined, series: undefined, end: markerEnd }
          : readVersion(name, start, identifier);
      }
      series ??= parsed.series;
    }
    if (first !== undefined) {
      if (first.identifier !== "gpt" || first.family !== "gpt" || identifier !== "codex") break;
      first.family = "codex";
      consumedEnd = parsed.end;
      continue;
    }
    const family = identifier === "swe-2" || /^k2[-_.\s/]*p8$/u.test(marker[0]) ? "unknown" : identifier;
    first = {
      identifier, family, series, version: parsed.version, versionParts: parsed.versionParts,
      opus5: series === "opus" && parsed.version?.[0] === 5 && (parsed.versionParts === 1 || parsed.versionParts === 2 && parsed.version[1] === 5),
      gemini4: identifier === "gemini" && (wildcardGemini4 || parsed.version?.[0] === 4)
    };
    consumedEnd = parsed.end;
  }
  return first;
}

export function classifyModelFamily(input: { providerID?: string; modelID?: string }): DsmmModelFamily {
  const providerID = input.providerID?.trim().toLowerCase() ?? "";
  const recognized = recognizeModelName(input.modelID ?? "");
  if (recognized !== undefined) return recognized.family;

  if (providerID.includes("codex")) return "codex";
  if (providerID.includes("anthropic")) return "claude";
  if (providerID === "google" || providerID === "google-vertex") return "gemini";
  if (providerID.includes("zhipu")) return "glm";
  if (providerID.includes("moonshot") || providerID.includes("kimi")) return "kimi";
  if (providerID.includes("deepseek")) return "deepseek";
  return "unknown";
}
