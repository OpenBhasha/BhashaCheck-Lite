// BhashaCheck's own version - semantic versioning (MAJOR.MINOR.PATCH):
//   MAJOR  a change that breaks something people already have: a file format
//          change older files can't be read under, or a saved-project change
//          that needs a migration older versions can't cope with
//   MINOR  new features, backwards compatible
//   PATCH  fixes
// Bump it here, and only here. It is shown in the app (header badge and
// Settings -> About) and written into every exported .rsml file's config (see
// exportConfig.js), next to the RSML version (see rsmlLib.js).
export const BHASHACHECK_VERSION = "1.0.0";
