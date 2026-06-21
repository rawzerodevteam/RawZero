import { useTranslation } from "react-i18next";
import { LANGS, languageName } from "../i18n";

/** Sélecteur de langue. Les langues sont découvertes via les fichiers locales/*.json. */
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { i18n } = useTranslation();
  return (
    <select
      className={"lang-select " + className}
      value={i18n.resolvedLanguage}
      onChange={(e) => void i18n.changeLanguage(e.target.value)}
      aria-label="Language"
    >
      {LANGS.map((l) => (
        <option key={l} value={l}>{languageName(l)}</option>
      ))}
    </select>
  );
}
