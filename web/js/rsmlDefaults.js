// The `rsml` library's own built-in tag vocabulary (rsml@3.1.1, mirrored from
// its source — it doesn't export these, so a `new RSMLAnnotator({})` with no
// overrides falls back to exactly these lists/maps). Used both as the
// fallback when a project hasn't customized anything, and as the "reset to
// defaults" target in the settings drawer.
//
// Stored here *without* the library's own `@` / `-start`/`-end` decoration —
// just the bare tag name a person would type in the settings UI.
// buildRsmlOptions() below re-adds the `@` prefix for the three
// isolated-token categories when building the RSMLAnnotator config.
export const RSML_DEFAULTS = {
  hesitations: ["umm", "uhh", "hmm", "ugh", "huh", "tsk", "uh-huh", "ehh"],
  isolatedParalinguistics: [
    "laughter", "cry", "hum", "breathe", "sniff", "nose-blowing",
    "cough", "sneeze", "throat-clearing", "yawn",
    "eating-sounds", "snore", "groan", "sigh",
  ],
  isolatedOther: ["silence", "unintelligible", "stutter-block"],
  disfluencySpans: ["filler", "repetition", "broken-word", "repair", "false-start", "prolongation"],
  paralinguisticSpans: ["crying", "yelling", "laughing", "singing", "humming", "whistling", "whispering"],
  prosodySpans: ["emphasis", "falling-pitch", "raising-pitch"],
  entities: {
    PER: "Person", GPE: "Geo Political Entity", FAC: "Facility", LOC: "Location",
    ITEM: "Item", WOA: "Work of Art", EVENT: "Event", SPORTS: "Sports",
    ORG: "Organization", BRAND: "Brand", HON: "Honorific", DATETIME: "Date/Time",
    MONEY: "Money", QUANT: "Quantity", NUM: "Number", LANG: "Language",
    LAW: "Law/Policy", ID: "Identifier",
  },
  languages: {
    en: "English", hi: "Hindi", bn: "Bengali", mr: "Marathi", te: "Telugu", ta: "Tamil",
    gu: "Gujarati", ur: "Urdu", kn: "Kannada", or: "Odia", ml: "Malayalam", pa: "Punjabi",
    as: "Assamese", mai: "Maithili", sat: "Santali", ks: "Kashmiri", ne: "Nepali", sd: "Sindhi",
    doi: "Dogri", kok: "Konkani", mni: "Manipuri", brx: "Bodo", sa: "Sanskrit",
  },
};

// Builds the config object handed straight to `new RSMLAnnotator({...})`,
// from a project's saved rsmlConfig (or the library defaults if null/unset).
// Copies every value so the library's own internal Object.assign can't end
// up aliasing our live state arrays/objects.
//
// Lives here rather than in main.js so editor.js can pull it in as a plain
// leaf import instead of adding a name to its existing (pre-existing,
// legitimate) cyclic import of main.js.
export function buildRsmlOptions(rsmlConfig) {
  const cfg = rsmlConfig || RSML_DEFAULTS;
  const withAt = (list) => list.map((w) => (w.startsWith("@") ? w : "@" + w));
  return {
    hesitations: withAt(cfg.hesitations),
    isolatedParalinguistics: withAt(cfg.isolatedParalinguistics),
    isolatedOther: withAt(cfg.isolatedOther),
    disfluencySpans: cfg.disfluencySpans.slice(),
    paralinguisticSpans: cfg.paralinguisticSpans.slice(),
    prosodySpans: cfg.prosodySpans.slice(),
    entities: Object.assign({}, cfg.entities),
    languages: Object.assign({}, cfg.languages),
  };
}

export function freshRsmlConfig() {
  return {
    hesitations: RSML_DEFAULTS.hesitations.slice(),
    isolatedParalinguistics: RSML_DEFAULTS.isolatedParalinguistics.slice(),
    isolatedOther: RSML_DEFAULTS.isolatedOther.slice(),
    disfluencySpans: RSML_DEFAULTS.disfluencySpans.slice(),
    paralinguisticSpans: RSML_DEFAULTS.paralinguisticSpans.slice(),
    prosodySpans: RSML_DEFAULTS.prosodySpans.slice(),
    entities: Object.assign({}, RSML_DEFAULTS.entities),
    languages: Object.assign({}, RSML_DEFAULTS.languages),
  };
}

// Drives the generic settings-drawer renderer in rsmlSettings.js. `kind`
// picks the editor: "list" for the six bare-word arrays (rendered as
// removable chips), "map" for the two code->label dictionaries.
export const RSML_TAG_CATEGORIES = [
  {
    key: "hesitations", kind: "list", label: "Hesitations",
    hint: "Isolated fillers — type @name while annotating.",
  },
  {
    key: "isolatedParalinguistics", kind: "list", label: "Paralinguistics (isolated)",
    hint: "Isolated sounds, e.g. laughter, cough — type @name.",
  },
  {
    key: "isolatedOther", kind: "list", label: "Other isolated tags",
    hint: "e.g. silence, unintelligible — type @name.",
  },
  {
    key: "disfluencySpans", kind: "list", label: "Disfluency spans",
    hint: "Wrapped around speech as @name-start ... @name-end.",
  },
  {
    key: "paralinguisticSpans", kind: "list", label: "Paralinguistic spans",
    hint: "Wrapped around speech as @name-start ... @name-end.",
  },
  {
    key: "prosodySpans", kind: "list", label: "Prosody spans",
    hint: "Wrapped around speech as @name-start ... @name-end.",
  },
  {
    key: "entities", kind: "map", label: "Entity types", keyCase: "upper",
    hint: "Tagged as #CODE[text](normalized).",
  },
  {
    key: "languages", kind: "map", label: "Languages", keyCase: "lower",
    hint: "Tagged as !code[text](gloss) for code-mixed spans.",
  },
];
