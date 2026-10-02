# pantheon-checks

Checks that [`@join-pantheon/cli`](https://www.npmjs.com/package/@join-pantheon/cli)
works for a new person on real Windows, macOS and Linux machines, on Node 22 and 24.

`journey.mjs` installs the published package and walks through what someone joining
a team does: sign up, start or join a team, send a message, have their coding
agent start Pantheon, run the wake-up hook, and run `pantheon doctor`. It uses
throwaway homes and a relay started on the runner, so it touches no real account
or hosted service.

Run it from the **Actions** tab ("journey" → Run workflow) with a version or tag:
`latest`, `next`, or an exact version such as `0.31.2-rc.1`.

Pantheon's own source and full test suite live elsewhere; this repository only
checks the package as it is published.
