import type { DsmmLocale, DsmmSettings } from "./settings.js";

const localeNames: Record<DsmmLocale, string> = {
  en: "English", "zh-Hans": "Simplified Chinese", "zh-Hant": "Traditional Chinese", ja: "Japanese", ko: "Korean",
  de: "German", fr: "French", es: "Spanish", "pt-BR": "Brazilian Portuguese", ru: "Russian"
};

export function buildDsmmLocaleGuidance(settings: Pick<DsmmSettings, "locale">): string {
  return `<dsmm-visible-output-language>
${JSON.stringify({ capturedLocale: settings.locale ?? null, visibleOutputLanguage: settings.locale === undefined ? null : localeNames[settings.locale] })}
${settings.locale === undefined ? "No DSMM locale is captured; inherit applicable host/user language guidance, otherwise use the current request and conversation context." : `This Agent's immutable captured locale is ${settings.locale} (${localeNames[settings.locale]}). Use it as the default for visible replies, plans and role/category output.`}
The current user's explicit output-language request takes precedence. Preserve that instruction in child assignments. A parent's later profile change does not rewrite a child's captured preference. Preserve code, identifiers, commands, paths, protocol fields and exact quotations verbatim. This affects visible output only: it neither promises an internal reasoning language nor changes the host UI/project locale. Do not infer configuration or authority with natural-language matching.
</dsmm-visible-output-language>`;
}
