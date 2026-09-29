// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  overrides: [
    {
      files: ["**/*.ts"],
      rules: {
        // We disable this rule here because the template
        // contains some unused examples and variables
        "@typescript-eslint/no-unused-vars": "off",
      },
    },
    {
      // Window scripts run inside a Zotero chrome window, where document,
      // window, Zotero and timers are injected globals — same situation as
      // bootstrap.js/prefs.js, which the base config exempts the same way.
      files: ["addon/content/**/*.js"],
      rules: {
        "no-undef": "off",
      },
    },
  ],
});
