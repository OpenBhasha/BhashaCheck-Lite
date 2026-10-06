// The ONE place the app loads the rsml library (RSMLAnnotator) from - every
// other module imports it from here, never straight from the CDN. That makes
// "which RSML version is this app running?" a single fact, which is what an
// exported .rsml file's config records (see exportConfig.js); it also means the
// browser downloads one copy of the library, not one per URL.
//
// The library doesn't report its own version, so it is stated here, right next
// to the URL it must match. An import specifier can't be built from a
// constant, so when upgrading, change BOTH lines below together.
import RSMLAnnotator from "https://cdn.jsdelivr.net/npm/rsml@3.3.4/rsml.esm.js";

export const RSML_VERSION = "3.3.3";

export default RSMLAnnotator;
