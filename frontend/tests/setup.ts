import i18n from "../src/i18n";

// Les tests (store.test.ts) vérifient des libellés d'historique en dur en français ;
// l'app détecte désormais la langue en priorité via localStorage et retombe sur l'anglais
// (cf. src/i18n/index.ts), donc sans ceci les tests tourneraient en anglais par défaut.
await i18n.changeLanguage("fr");
