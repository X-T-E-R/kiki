<!--
Thank you for your contribution to Kiki!
Please open an issue before sending a feature PR — PRs without prior discussion may be closed without review.

See https://github.com/X-T-E-R/kiki/blob/kiki/CONTRIBUTING.md for more.
-->

## Related Issue

<!-- Link the issue this feature came from. If there is no issue, explain the problem in the next section instead. -->

Resolve #(issue_number)

## Problem

<!-- What user need or limitation does this address? If the linked issue already covers this, write "See linked issue". -->

## What changed

<!-- What did you implement, and why does this approach fit Kiki? -->

## Documentation impact

<!-- Select None alone, or select every affected category. This declaration routes future review; it is not a semantic CI gate. -->

- [ ] None — no generated, maintainer, or user-facing contract changed. Do not select another category.
- [ ] Generated — one or more checked-in projections changed.
- [ ] Maintainer — one or more owner, extension, recovery, verification, or stable internal views changed.
- [ ] User — one or more supported behavior, configuration, command, compatibility, migration, or reader-decision views changed.

## Documentation completion

<!-- Select exactly one. None pairs with Completed. Generated work must be completed in this candidate and cannot appear in a deferred record. Deferred requires at least one Maintainer or User category. -->

- [ ] Completed — all selected impact is complete for this candidate, or impact is None.
- [ ] Deferred — generated work is complete; every remaining maintainer or user view is recorded below.

<!-- Repeat this line for every deferred view. Retain all applicable categories and use the earliest boundary: stable reuse/owner handoff for Maintainer, or default-on/public release for User. -->

- Categories and view: <!-- Maintainer and/or User plus exact path/heading --> | Owner: <!-- accountable owner --> | Target boundary: <!-- earliest applicable no-later-than boundary -->

## Checklist

- [ ] I have read the [CONTRIBUTING](https://github.com/X-T-E-R/kiki/blob/kiki/CONTRIBUTING.md) document.
- [ ] I have linked a related issue, or explained the problem above.
- [ ] I have added tests that prove my feature works.
- [ ] Ran `gen-changesets` skill, or this PR needs no changeset.
- [ ] I classified the documentation impact above and completed or deferred the due work for the stated boundary.
