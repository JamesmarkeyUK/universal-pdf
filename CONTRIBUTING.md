# Contributing to Universal PDF

Bug reports, ideas and pull requests are all welcome. This is a small project,
so the most useful thing you can send is a clear description of what you did and
what happened instead of what you expected.

## Licensing your contribution

Universal PDF is licensed under the **GNU Affero General
Public License, version 3 or later**, with one additional permission that allows
the app to be distributed through curated application stores. See
[`LICENSE`](LICENSE).

**By opening a pull request, you agree that:**

1. You wrote the contribution, or otherwise have the right to submit it under
   these terms.
2. Your contribution is licensed under **AGPL-3.0-or-later**, the same licence
   as the rest of the project.
3. You grant the **same additional permission for application store
   distribution** over your contribution that the `LICENSE` file grants over the
   rest — so that the app as a whole can still be published to the App Store,
   Google Play and comparable stores.

You keep the copyright in your own work. Point 3 is not an assignment; it is the
same permission the project already gives everyone else, extended to your lines
so the app stays distributable as a whole.

### Why point 3 exists

The AGPL and the usage rules of curated app stores genuinely conflict — device
limits, DRM, and section 10's bar on imposing further restrictions. It is why
VLC was removed from the App Store in 2011. The conflict is resolved by an
*additional permission* under section 7 of the licence, and only a copyright
holder can grant one.

That means a single merged contribution without point 3 would leave part of the
app covered by the permission and part not, and the app as a whole could no
longer be published to a store. Nobody would notice until submission day, which
is a bad time to find out. Point 3 keeps that from happening quietly.

If you would rather not grant it, say so in the pull request — the contribution
may still be very welcome, it just means it needs handling deliberately rather
than being merged on the assumption above.

## Practical notes

- Keep pull requests focused. One change per pull request is much easier to
  review than five.
- Run the project's checks before you push — typically `npm run build` and the
  test script listed in `package.json`. If a check fails for a reason unrelated
  to your change, say so rather than silently working around it.
- Match the surrounding code. There is no separate style guide; the existing
  files are the style guide.
- If you are proposing something large, open an issue first. It is kinder than
  writing a lot of code that turns out to be pointed the wrong way.

## Security

Please do **not** open a public issue for a security problem. Email
<inbox@jamesmarkey.co.uk> instead.
