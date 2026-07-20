# Localization activation contract

LineRecall's source interface is `en-US`. The versioned locale registry also
reserves `es`, `de`, `fr`, `pt-BR`, `pl`, and `ar`, but those six locales are
disabled. No translated text has been invented or copied into placeholder
catalogs.

A translated locale cannot be activated until it has a complete catalog and
named language, layout, and assistive-technology reviewers. Arabic is declared
right-to-left even while disabled so a direction regression is visible before
activation. `npm run localization:audit` blocks missing keys, changed ICU
placeholders, unreviewed activation, extra unreviewed catalogs, duplicate
locales, and incorrect direction metadata.

The formatter supports a bounded ICU subset: `{name}`, `{count, number}`, and
`{date, date}`. Values are length- and type-checked, output is text only, and
missing or extra parameters are errors. Plural/select rules remain disabled
until real translated catalogs can be reviewed.

The application currently applies the resolved locale and direction at the
document boundary. A disabled or invalid runtime request resolves to `en-US`
and `ltr`; it never partially mixes catalogs. The source locale still has
manual layout and assistive-technology release blockers. Enabling English is
not a claim of qualified review, WCAG conformance, or legal certification.
